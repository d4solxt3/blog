/** Shared by the local customizer and Markdown studio. */
export async function startLocalRelease(file: string): Promise<string> {
  const response = await fetch('/_admin/api/publish', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Editor-Action': 'publish' },
    body: JSON.stringify({ file }),
  });
  const result = await response.json();
  if (!response.ok || !/^[0-9a-f]{40}$/.test(result.revision ?? '')) {
    throw new Error(result.error || 'The local editor could not start the deployment.');
  }
  return result.revision;
}

export async function waitForLocalRelease(revision: string, signal: AbortSignal) {
  for (let attempt = 0; attempt < 90; attempt++) {
    signal.throwIfAborted();
    const state = await fetch('/_admin/api/release?revision=' + encodeURIComponent(revision), { cache: 'no-store', signal })
      .then(response => response.ok ? response.json() : null).catch(() => null);
    signal.throwIfAborted();
    if (state?.live) return;
    if (state?.failed) throw new Error('Railway deployment ' + state.status.toLowerCase() + '. Check the build logs and retry.');
    await new Promise(resolve => setTimeout(resolve, 4000));
  }
  throw new Error('GitHub has your changes. The live site has not confirmed this release yet. Check Railway for its status.');
}
