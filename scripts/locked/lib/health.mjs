/**
 * FROZEN — public health-check poll. 
 */
import { execFileSync } from 'node:child_process'

/**
 * Poll every path in `paths` on `baseUrl` with `curl -sf` until all return
 * success or `attempts` is exhausted. Returns true once healthy, false if
 * never healthy within the budget. Never throws — callers decide how to react
 * to a failed check (fail / rollback / etc.).
 *
 * Default budget matches the previous inline loops: 20 attempts, 15s between
 * attempts, 10s per request.
 */
export function healthCheck(baseUrl, { paths = ['/'], attempts = 20, sleepSec = 15, maxTime = 10 } = {}) {
  for (let i = 0; i < attempts; i++) {
    let ok = true
    for (const path of paths) {
      try {
        execFileSync('curl', ['-sf', '-o', '/dev/null', '--max-time', String(maxTime), `${baseUrl}${path}`])
      } catch {
        ok = false
        break
      }
    }
    if (ok) return true
    if (i < attempts - 1) execFileSync('sleep', [String(sleepSec)])
  }
  return false
}
