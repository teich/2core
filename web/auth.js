// No access key is issued or stored for Tailscale. The private proxy transport
// authenticates every request; this endpoint tells the UI to skip its key form.
export async function detectImplicitAuthentication() {
  try {
    const response = await fetch('/api/auth', { cache: 'no-store', signal: AbortSignal.timeout(10000) });
    if (!response.ok) return false;
    const auth = await response.json();
    return auth.authenticated === true && auth.mode === 'tailscale';
  } catch { return false; }
}
