/**
 * Snapshot endpoint — prerenders the homepage HTML and writes it to the shared
 * snapshot file that Caddy serves for the root path.
 *
 * Caddy hits this endpoint in the background (the stale-while-revalidate path),
 * and the app also self-triggers it after serving a non-cached request. Both
 * paths converge here: fetch the page from the local server, persist the HTML
 * atomically (temp file + rename), and return it.
 *
 * The snapshot directory is mounted from the host at /var/lib/caddy/snapshots
 * (shared between Caddy and the app container — see docker-compose.yml).
 */

import { NextResponse } from 'next/server'
import { writeFile, rename, mkdir } from 'node:fs/promises'
import { join } from 'node:path'

export const dynamic = 'force-dynamic'

const SNAPSHOT_DIR = '/var/lib/caddy/snapshots'
const SNAPSHOT_PATH = join(SNAPSHOT_DIR, 'index.html')
const TMP_PATH = join(SNAPSHOT_DIR, '.index.tmp')

/** Port the app listens on (set in docker-compose.yml as PORT=3000). */
const PORT = process.env['PORT'] ?? '3000'

async function ensureDir(): Promise<void> {
  try {
    await mkdir(SNAPSHOT_DIR, { recursive: true })
  } catch {
    // raced with another writer — ignore
  }
}

export async function GET() {
  try {
    await ensureDir()

    // Fetch the homepage HTML from the local server. The initial snapshot (cold
    // boot) is best-effort — the page renders fine without it, just without the
    // Caddy-level cache benefit until the first revalidation. A failure here
    // serves the current cached copy (if any) via Caddy's file matcher.
    const origin = `http://127.0.0.1:${PORT}`
    const res = await fetch(origin, {
      headers: { Accept: 'text/html' },
      // 10s should be generous for a server-rendered page
      signal: AbortSignal.timeout(10_000),
    })

    if (!res.ok) {
      console.error(`snapshot: homepage returned ${res.status}`)
      return NextResponse.json({ error: 'homepage not available' }, { status: 502 })
    }

    const html = await res.text()

    // Write atomically: temp file + rename. This prevents Caddy from reading a
    // half-written file when the box is migrated mid-write (the carried-state
    // rule: the snapshot dir is inside the carried state).
    await writeFile(TMP_PATH, html, 'utf-8')
    await rename(TMP_PATH, SNAPSHOT_PATH)

    console.error(`snapshot: wrote ${html.length} bytes`)
    return new NextResponse(html, {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    })
  } catch (err) {
    console.error('snapshot: failed', err)
    // Return the current snapshot if it exists, so the caller still gets
    // something useful rather than propagating the error.
    try {
      const { readFile } = await import('node:fs/promises')
      const stale = await readFile(SNAPSHOT_PATH, 'utf-8')
      return new NextResponse(stale, {
        status: 200,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      })
    } catch {
      return NextResponse.json({ error: 'snapshot generation failed' }, { status: 500 })
    }
  }
}
