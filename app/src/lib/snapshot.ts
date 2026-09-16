/**
 * Snapshot revalidation helper.
 *
 * After serving a live homepage render, the app fires off a background request
 * to /api/snapshot to regenerate the cached HTML that Caddy serves. This keeps
 * the snapshot fresh without blocking the visitor's response.
 *
 * The request is fire-and-forget: if it fails (e.g. the snapshot dir doesn't
 * exist during development), the error is swallowed because the live page was
 * already served successfully.
 */

const PORT = process.env['PORT'] ?? '3000'

export function revalidateSnapshot(): void {
  // Only revalidate when running as the deployed server (not during build).
  // During `next build`, process.env is minimal and there's no server to reach.
  if (process.env['NODE_ENV'] !== 'production') return

  fetch(`http://127.0.0.1:${PORT}/api/snapshot`, {
    method: 'GET',
    headers: { Accept: 'text/html' },
    signal: AbortSignal.timeout(10_000),
  }).catch(() => {
    // Background revalidation is best-effort — the snapshot will be refreshed
    // on the next live request or by the deploy script's seed step.
  })
}
