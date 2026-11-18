import { execFileSync } from 'node:child_process';

export function GET() {
  let revision = process.env.RAILWAY_GIT_COMMIT_SHA;
  if (!revision) {
    try { revision = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch {}
  }
  return Response.json({ revision: revision ?? null }, { headers: { 'Cache-Control': 'no-cache' } });
}
