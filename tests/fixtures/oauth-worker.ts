// Local Miniflare entrypoint ONLY. Never included by cloud/wrangler.jsonc.
import gateway from '../../cloud/gateway.js';
import { getOAuthApi, oauthOptions, oauthGateway, SMOKE_SCOPE, READ_SCOPE, WRITE_SCOPE } from '../../cloud/oauth.js';
export default {
  async fetch(request: Request, env: any, ctx: ExecutionContext) {
    env.GATEWAY_ORIGIN = new URL(request.url).origin;
    if (new URL(request.url).pathname === '/__test/token') {
      if (new URL(request.url).searchParams.has('other')) env = { ...env, ALLOWED_GITHUB_ID: '999' };
      const requested = new URL(request.url).searchParams.get('scope');
      const scope = new URL(request.url).searchParams.has('empty') ? [] : requested === 'write' ? [WRITE_SCOPE] : requested === 'read' ? [READ_SCOPE] : requested === 'both' ? [SMOKE_SCOPE, READ_SCOPE] : [SMOKE_SCOPE];
      const helpers = getOAuthApi(oauthOptions(env, async () => new Response()), env);
      const client = await helpers.createClient({ clientName: 'Local test only', redirectUris: ['http://localhost/callback'], tokenEndpointAuthMethod: 'none' });
      const verifier = 'test-verifier-'.repeat(5);
      const challenge = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      const url = new URL(`${env.GATEWAY_ORIGIN}/authorize`);
      url.search = new URLSearchParams({ client_id: client.clientId, redirect_uri: 'http://localhost/callback', response_type: 'code', scope: scope.join(' '), code_challenge: challenge, code_challenge_method: 'S256', resource: `${env.GATEWAY_ORIGIN}/mcp` }).toString();
      const parsed = await helpers.parseAuthRequest(new Request(url));
      const completed = await helpers.completeAuthorization({ request: parsed, userId: env.ALLOWED_GITHUB_ID, metadata: {}, scope, props: { userId: env.ALLOWED_GITHUB_ID } });
      const code = new URL(completed.redirectTo).searchParams.get('code')!;
      const exchange = new Request(`${env.GATEWAY_ORIGIN}/oauth/token`, { method: 'POST', body: new URLSearchParams({ grant_type: 'authorization_code', code, client_id: client.clientId, redirect_uri: 'http://localhost/callback', code_verifier: verifier, resource: `${env.GATEWAY_ORIGIN}/mcp` }) });
      const response = await oauthGateway(env, async () => new Response()).fetch(exchange, env, ctx);
      if (!response.ok) return response;
      return Response.json({ ...await response.json() as object, client_id: client.clientId });
    }
    return gateway.fetch(request, env, ctx);
  },
};
export { Relay } from '../../cloud/gateway.js';
