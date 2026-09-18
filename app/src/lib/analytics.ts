/**
 * Website analytics — tracks unique visitors and total page views.
 *
 * These are simple, privacy-preserving counters stored on the durable state
 * volume. They survive restarts and migrations, and are displayed on the
 * homepage after the proposals section to give visitors a sense of the site's
 * activity.
 *
 * What is counted:
 *   visitors  — incremented once per unique IP per rolling 24h window (tracked
 *               by a bucket that rounds to the current day).
 *   pageViews — total page loads (incremented on every request).
 *
 * No cookies, no fingerprinting, no external services — just two numbers on
 * disk, updated atomically.
 */

import { readFile, writeFile, mkdir, rename } from 'node:fs/promises'

// ─── Types ────────────────────────────────────────────────────────────────

export interface AnalyticsState {
  /** Total number of page loads since the counter was created. */
  pageViews: number
  /** Unique visitors in the current rolling 24h window. */
  visitors: number
  /** Unix ms bucket key — rounded to the start of the current day (UTC). */
  bucketTs: number
  /** Set of IP hashes seen in the current bucket (in-memory during read). */
  seenIps: string[]
  /** Total unique visitors all-time (cumulative). */
  totalVisitors: number
  /** Unix ms of the first recorded page view. */
  firstPageViewAt: number | null
  /** Unix ms of the most recent page view. */
  lastPageViewAt: number | null
}

// ─── Config ───────────────────────────────────────────────────────────────

let storePath = '/var/lib/longlive/state/analytics.json'

export function setAnalyticsPath(path: string): void {
  storePath = path
}

export function getAnalyticsPath(): string {
  return storePath
}

// ─── Helpers ──────────────────────────────────────────────────────────────

/** Round a unix ms timestamp to the start of its UTC day. */
function dayBucket(ts: number): number {
  const d = new Date(ts)
  d.setUTCHours(0, 0, 0, 0)
  return d.getTime()
}

/** Simple non-cryptographic hash of an IP string — stable within a process. */
function hashIp(ip: string): string {
  let h = 0
  for (let i = 0; i < ip.length; i++) {
    h = (Math.imul(31, h) + ip.charCodeAt(i)) | 0
  }
  return h.toString(16)
}

// ─── Store I/O ────────────────────────────────────────────────────────────

export function parseAnalyticsState(data: string): AnalyticsState {
  if (!data.trim()) return emptyState()
  const parsed = JSON.parse(data) as Partial<AnalyticsState>
  return {
    pageViews: typeof parsed.pageViews === 'number' ? parsed.pageViews : 0,
    visitors: typeof parsed.visitors === 'number' ? parsed.visitors : 0,
    bucketTs: typeof parsed.bucketTs === 'number' ? parsed.bucketTs : dayBucket(Date.now()),
    seenIps: Array.isArray(parsed.seenIps) ? parsed.seenIps : [],
    totalVisitors: typeof parsed.totalVisitors === 'number' ? parsed.totalVisitors : 0,
    firstPageViewAt: typeof parsed.firstPageViewAt === 'number' ? parsed.firstPageViewAt : null,
    lastPageViewAt: typeof parsed.lastPageViewAt === 'number' ? parsed.lastPageViewAt : null,
  }
}

export function serializeAnalyticsState(state: AnalyticsState): string {
  return JSON.stringify(state) + '\n'
}

export function emptyState(): AnalyticsState {
  return {
    pageViews: 0,
    visitors: 0,
    bucketTs: dayBucket(Date.now()),
    seenIps: [],
    totalVisitors: 0,
    firstPageViewAt: null,
    lastPageViewAt: null,
  }
}

async function readAnalytics(): Promise<AnalyticsState> {
  try {
    const data = await readFile(storePath, 'utf8')
    return parseAnalyticsState(data)
  } catch (err: unknown) {
    if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
      return emptyState()
    }
    console.error('analytics: failed to read store:', err)
    return emptyState()
  }
}

async function writeAnalytics(state: AnalyticsState): Promise<void> {
  const dir = storePath.substring(0, storePath.lastIndexOf('/'))
  await mkdir(dir, { recursive: true })
  const tmp = storePath + '.tmp.' + Date.now()
  await writeFile(tmp, serializeAnalyticsState(state), 'utf8')
  await rename(tmp, storePath)
}

// ─── Public API ───────────────────────────────────────────────────────────

/**
 * Record a page view. Call once per request.
 *
 * @param ip The visitor's IP address (or a forwarded-for header value).
 *        Pass an empty string to count page views only (no visitor tracking).
 * @returns The updated analytics state.
 */
export async function recordPageView(ip: string): Promise<AnalyticsState> {
  const state = await readAnalytics()
  const now = Date.now()
  const today = dayBucket(now)

  // Rotate bucket if the day has changed.
  if (state.bucketTs !== today) {
    state.bucketTs = today
    state.seenIps = []
    state.visitors = 0
  }

  // Count visitor (unique per rolling 24h bucket).
  if (ip) {
    const hashed = hashIp(ip)
    if (!state.seenIps.includes(hashed)) {
      state.seenIps.push(hashed)
      state.visitors = state.seenIps.length
      state.totalVisitors++
    }
  }

  // Always count the page view.
  state.pageViews++
  if (state.firstPageViewAt === null) state.firstPageViewAt = now
  state.lastPageViewAt = now

  await writeAnalytics(state)
  return state
}

/**
 * Get the current analytics counters without recording a new view.
 */
export async function getAnalytics(): Promise<AnalyticsState> {
  return readAnalytics()
}

/**
 * Format analytics for display — returns human-readable numbers.
 */
export interface AnalyticsDisplay {
  pageViews: string
  visitorsToday: string
  totalVisitors: string
  firstPageView: string | null
  lastPageView: string | null
}

export function formatAnalytics(state: AnalyticsState): AnalyticsDisplay {
  return {
    pageViews: state.pageViews.toLocaleString(),
    visitorsToday: state.visitors.toLocaleString(),
    totalVisitors: state.totalVisitors.toLocaleString(),
    firstPageView: state.firstPageViewAt
      ? new Date(state.firstPageViewAt).toLocaleDateString(undefined, {
          year: 'numeric',
          month: 'short',
          day: 'numeric',
        })
      : null,
    lastPageView: state.lastPageViewAt
      ? new Date(state.lastPageViewAt).toLocaleDateString(undefined, {
          year: 'numeric',
          month: 'short',
          day: 'numeric',
        })
      : null,
  }
}
