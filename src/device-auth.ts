export const deviceKey = (id: string) => `bridge-device:v1:${id}`;
export const validDeviceId = (id: string) => /^[a-z0-9-]{2,64}$/.test(id);
export async function credentialHash(token: string): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))), b => b.toString(16).padStart(2, '0')).join('');
}
export async function deviceCredentialHash(id: string, record: unknown, legacyId: string, legacyToken: string): Promise<string | null> {
  if (!validDeviceId(id)) return null;
  if (record === null) return id === legacyId && legacyToken ? credentialHash(legacyToken) : null;
  const entry = record as any;
  return entry?.version === 1 && entry.revoked === false && /^[0-9a-f]{64}$/.test(entry.hash ?? '') ? entry.hash : null;
}
export async function verifyDeviceCredential(auth: string | null, expected: string | null): Promise<boolean> {
  if (!expected || !auth?.startsWith('Bearer ')) return false;
  const actual = await credentialHash(auth.slice(7));
  let diff = 0;
  for (let i = 0; i < 64; i++) diff |= actual.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}
