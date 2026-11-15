import OAuthProvider, { getOAuthApi, insufficientScope, OAuthError, type OAuthHelpers, type OAuthProviderOptions, type ConsentDescription, type OAuthResourceContext } from '@cloudflare/workers-oauth-provider';
import type { KVNamespace } from '@cloudflare/workers-types';

export const SMOKE_SCOPE = 'bridge:smoke';
export const READ_SCOPE = 'bridge:read';
export const WRITE_SCOPE = 'bridge:write';
const GRANT_TTL = 30 * 86400;
export interface OAuthEnv {
  OAUTH_KV: KVNamespace;
  GATEWAY_ORIGIN: string;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  ALLOWED_GITHUB_ID: string;
  OAUTH_PROVIDER?: OAuthHelpers;
}
const escape = (value: string) => value.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
function consentPage(details: ConsentDescription, handle: string, scopes: string[]): string {
  return `<!doctype html><html lang="es"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Autorizar SolicitudPro Bridge</title>
<h1>Autorizar ${escape(details.clientName)}</h1><p>Cliente: ${escape(details.clientDomain ?? 'nombre no verificado')}.</p>
<p>Destino de autorización: <strong>${escape(details.redirectHost)}</strong>.</p>
${details.redirectIsLoopback ? '<p>Destino local: continúa solo si acabas de iniciar este acceso.</p>' : ''}
<p>Permisos: <strong>${scopes.map(escape).join(', ')}</strong>. ${scopes.includes(WRITE_SCOPE) ? 'Aprobar planes tras consentimiento explícito en ChatGPT y aplicarlos una sola vez sobre archivos autorizados; sin Git commit/push ni infraestructura.' : scopes.includes(READ_SCOPE) ? 'Lectura del estado Git, contexto y código de proyectos autorizados; análisis Codex en sandbox de solo lectura. Sin escritura ni comandos enviados directamente por el cliente.' : 'Solo una comprobación fija; sin repositorios ni comandos.'}</p>
<p>Verificaremos tu identidad mediante GitHub sin solicitar permisos de repositorios.</p>
<form method="post"><input type="hidden" name="handle" value="${escape(handle)}"><button name="decision" value="approve">Autorizar e iniciar sesión</button><button name="decision" value="deny">Denegar</button></form></html>`;
}
const error = (status = 400) => new Response('No se pudo autorizar el acceso.', { status, headers: { 'Cache-Control': 'no-store' } });
const s256 = async (value: string) => {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

async function signIn(request: Request, env: OAuthEnv): Promise<Response> {
  if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET || !/^\d+$/.test(env.ALLOWED_GITHUB_ID ?? '')) return error(503);
  const oauth = env.OAUTH_PROVIDER!;
  const path = new URL(request.url).pathname;
  try {
    if (path === '/authorize' && request.method === 'GET') {
      const parsed = await oauth.parseAuthRequest(request);
      if (!parsed.scope.length || parsed.scope.some(scope => ![SMOKE_SCOPE, READ_SCOPE, WRITE_SCOPE].includes(scope))) return error();
      const details = await oauth.describeConsent(parsed);
      const consent = await oauth.beginConsent(parsed);
      consent.headers.set('Content-Type', 'text/html; charset=utf-8');
      return new Response(consentPage(details, consent.handle, parsed.scope), { headers: consent.headers });
    }
    if (path === '/authorize' && request.method === 'POST') {
      if (Number(request.headers.get('Content-Length') ?? 0) > 4096) return error();
      const form = await request.formData();
      const handle = String(form.get('handle') ?? '');
      if (form.get('decision') !== 'approve') {
        const denied = await oauth.denyConsent(request, handle);
        return new Response(null, { status: 302, headers: denied.headers });
      }
      // Keep exactly the scopes requested and displayed in consent; do not over-grant.
      const approved = await oauth.approveConsent(request, handle);
      const verifier = crypto.randomUUID() + crypto.randomUUID();
      const upstream = await oauth.beginUpstream(approved.request, { data: { verifier }, headers: approved.headers });
      const url = new URL('https://github.com/login/oauth/authorize');
      url.search = new URLSearchParams({ client_id: env.GITHUB_CLIENT_ID, redirect_uri: `${env.GATEWAY_ORIGIN}/oauth/github/callback`, scope: '', state: upstream.state, code_challenge: await s256(verifier), code_challenge_method: 'S256', allow_signup: 'false' }).toString();
      upstream.headers.set('Location', url.href);
      return new Response(null, { status: 302, headers: upstream.headers });
    }
    if (path === '/oauth/github/callback' && request.method === 'GET') {
      const upstream = await oauth.finishUpstream<{ verifier: string }>(request);
      const code = new URL(request.url).searchParams.get('code');
      if (!code || code.length > 512) return error();
      const exchange = await fetch('https://github.com/login/oauth/access_token', { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: env.GITHUB_CLIENT_ID, client_secret: env.GITHUB_CLIENT_SECRET, code, redirect_uri: `${env.GATEWAY_ORIGIN}/oauth/github/callback`, code_verifier: upstream.data.verifier }), signal: AbortSignal.timeout(10_000) });
      if (!exchange.ok) return error();
      const token = await exchange.json() as { access_token?: string; scope?: string };
      // This app is identity-only. Refuse unexpectedly broad upstream grants.
      if (!token.access_token || token.scope) return error(403);
      const profile = await fetch('https://api.github.com/user', { headers: { Authorization: `Bearer ${token.access_token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'SolicitudPro-Bridge-Login' }, signal: AbortSignal.timeout(10_000) });
      if (!profile.ok) return error();
      const user = await profile.json() as { id?: number };
      if (String(user.id) !== env.ALLOWED_GITHUB_ID) return error(403);
      // Discard the upstream token; persist only the approved subject.
      const result = await oauth.completeAuthorization({ request: upstream.request, userId: String(user.id), metadata: {}, scope: upstream.request.scope.filter(scope => [SMOKE_SCOPE, READ_SCOPE, WRITE_SCOPE].includes(scope)), props: { userId: String(user.id) } });
      upstream.headers.set('Location', result.redirectTo);
      return new Response(null, { status: 302, headers: upstream.headers });
    }
    return new Response('Not found', { status: 404 });
  } catch { return error(); }
}

export function oauthOptions(env: OAuthEnv, forward: (request: Request) => Promise<Response>): OAuthProviderOptions<OAuthEnv> {
  const resource = `${env.GATEWAY_ORIGIN}/mcp`;
  return {
    apiRoute: '/mcp',
    resourceMetadata: { resource },
    authorizeEndpoint: '/authorize', tokenEndpoint: '/oauth/token',
    clientIdMetadataDocumentEnabled: true,
    scopesSupported: [SMOKE_SCOPE, READ_SCOPE, WRITE_SCOPE], requiredScopes: [SMOKE_SCOPE],
    accessTokenTTL: 600, refreshTokenTTL: GRANT_TTL, refreshTokenIdleTTL: GRANT_TTL,
    onError: ({ code, status, headers, internal }) => {
      if (code === 'invalid_grant' && internal.category === 'refresh-token-grant' &&
          ['grant_not_found', 'refresh_token_expired', 'refresh_token_mismatch'].includes(internal.reason)) {
        console.warn('OAUTH_REAUTH_REQUIRED', internal.reason);
        return Response.json({
          error: code,
          error_description: 'OAUTH_REAUTH_REQUIRED: reconnect SolicitudPro Bridge.',
        }, { status, headers });
      }
      // A missing or expired access token may still be recoverable via refresh.
      console.warn('OAuth request rejected', status, code, internal.category, internal.reason);
    },
    tokenExchangeCallback: async ({ props }) => {
      if (props?.userId !== env.ALLOWED_GITHUB_ID) throw new OAuthError('invalid_grant', { description: 'Access denied' });
    },
    apiHandler: { async fetch(request: Request, _env: OAuthEnv, ctx: any) {
      const authenticated = ctx as OAuthResourceContext<{ userId: string }>;
      if (![SMOKE_SCOPE, READ_SCOPE, WRITE_SCOPE].some(scope => authenticated.auth.scope.includes(scope))) return insufficientScope(authenticated.auth, [SMOKE_SCOPE]);
      if (!env.ALLOWED_GITHUB_ID || authenticated.props?.userId !== env.ALLOWED_GITHUB_ID) return error(403);
      const trace = crypto.randomUUID();
      console.log('oauth-mcp-authorized', trace);
      const headers = new Headers(request.headers); headers.set('X-Bridge-Trace', trace); headers.set('X-Bridge-Scopes', authenticated.auth.scope.filter(scope => [SMOKE_SCOPE, READ_SCOPE, WRITE_SCOPE].includes(scope)).join(' '));
      return forward(new Request(request, { headers }));
    } },
    defaultHandler: { async fetch(request: Request, authEnv: OAuthEnv) {
      const path = new URL(request.url).pathname;
      if (path === '/relay' || path === '/health') return forward(request);
      return signIn(request, authEnv);
    } },
  };
}
export function oauthGateway(env: OAuthEnv, forward: (request: Request) => Promise<Response>) {
  return new OAuthProvider(oauthOptions(env, forward));
}
// Export the official helper only for in-process test setup; never as an HTTP route.
export { getOAuthApi };
