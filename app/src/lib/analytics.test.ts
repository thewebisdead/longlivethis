import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  parseAnalyticsState,
  serializeAnalyticsState,
  setAnalyticsPath,
  getAnalyticsPath,
  recordPageView,
  getAnalytics,
  formatAnalytics,
  emptyState,
} from './analytics.ts'

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'analytics-test-'))
  const store = join(d, 'analytics.json')
  setAnalyticsPath(store)
  return d
}

function cleanup(d: string): void {
  try { rmSync(d, { recursive: true }) } catch { /* ignored */ }
}

test('setAnalyticsPath/getAnalyticsPath round-trip', () => {
  const orig = getAnalyticsPath()
  setAnalyticsPath('/tmp/test-analytics.json')
  assert.equal(getAnalyticsPath(), '/tmp/test-analytics.json')
  setAnalyticsPath(orig)
})

test('empty store returns zeros with no error', async () => {
  const d = tempDir()
  try {
    const state = await getAnalytics()
    assert.equal(state.pageViews, 0)
    assert.equal(state.visitors, 0)
    assert.equal(state.seenIps.length, 0)
    assert.equal(state.totalVisitors, 0)
    assert.equal(state.firstPageViewAt, null)
    assert.equal(state.lastPageViewAt, null)
  } finally {
    cleanup(d)
  }
})

test('recordPageView increments page views', async () => {
  const d = tempDir()
  try {
    const state1 = await recordPageView('')
    assert.equal(state1.pageViews, 1)
    assert.equal(state1.visitors, 0) // empty ip means no visitor counting

    const state2 = await recordPageView('')
    assert.equal(state2.pageViews, 2)
    assert.equal(state2.visitors, 0)
  } finally {
    cleanup(d)
  }
})

test('recordPageView tracks unique visitors per bucket', async () => {
  const d = tempDir()
  try {
    const s1 = await recordPageView('1.2.3.4')
    assert.equal(s1.pageViews, 1)
    assert.equal(s1.visitors, 1)
    assert.equal(s1.totalVisitors, 1)

    // Same IP — counts as same visitor in the bucket.
    const s2 = await recordPageView('1.2.3.4')
    assert.equal(s2.pageViews, 2)
    assert.equal(s2.visitors, 1)
    assert.equal(s2.totalVisitors, 1)

    // New IP — counts as new visitor.
    const s3 = await recordPageView('5.6.7.8')
    assert.equal(s3.pageViews, 3)
    assert.equal(s3.visitors, 2)
    assert.equal(s3.totalVisitors, 2)
  } finally {
    cleanup(d)
  }
})

test('recordPageView sets first and last page view timestamps', async () => {
  const d = tempDir()
  try {
    const s1 = await recordPageView('')
    assert.ok(s1.firstPageViewAt !== null)
    assert.equal(s1.firstPageViewAt, s1.lastPageViewAt)

    const s2 = await recordPageView('')
    assert.equal(s2.firstPageViewAt, s1.firstPageViewAt)
    assert.ok(s2.lastPageViewAt! >= s1.lastPageViewAt!)
  } finally {
    cleanup(d)
  }
})

test('formatAnalytics produces human-readable display', () => {
  const state = emptyState()
  state.pageViews = 1234
  state.visitors = 56
  state.totalVisitors = 789
  state.firstPageViewAt = new Date('2025-01-15T00:00:00Z').getTime()
  state.lastPageViewAt = Date.now()

  const display = formatAnalytics(state)
  assert.equal(display.pageViews, '1,234')
  assert.equal(display.visitorsToday, '56')
  assert.equal(display.totalVisitors, '789')
  assert.ok(typeof display.firstPageView === 'string')
})

test('empty state formatAnalytics', () => {
  const state = emptyState()
  const display = formatAnalytics(state)
  assert.equal(display.pageViews, '0')
  assert.equal(display.visitorsToday, '0')
  assert.equal(display.totalVisitors, '0')
  assert.equal(display.firstPageView, null)
  assert.equal(display.lastPageView, null)
})

test('round-trip serialize / parse', () => {
  const now = Date.now()
  const state: AnalyticsState = {
    pageViews: 100,
    visitors: 5,
    bucketTs: 123,
    seenIps: ['abc', 'def'],
    totalVisitors: 10,
    firstPageViewAt: now - 100000,
    lastPageViewAt: now,
  }
  const parsed = parseAnalyticsState(serializeAnalyticsState(state))
  assert.deepEqual(parsed, state)
})

test('parse backfills missing fields', () => {
  const parsed = parseAnalyticsState('{}')
  assert.equal(parsed.pageViews, 0)
  assert.equal(parsed.visitors, 0)
  assert.equal(parsed.totalVisitors, 0)
  assert.equal(parsed.firstPageViewAt, null)
})

test('recordPageView persists across reads', async () => {
  const d = tempDir()
  try {
    await recordPageView('1.2.3.4')
    await recordPageView('1.2.3.4')
    await recordPageView('5.6.7.8')

    // Read fresh from disk.
    const state = await getAnalytics()
    assert.equal(state.pageViews, 3)
    assert.equal(state.visitors, 2)
    assert.equal(state.totalVisitors, 2)
  } finally {
    cleanup(d)
  }
})

// We need to import AnalyticsState for the test — re-define inline to avoid
// import type issues in the test.
import type { AnalyticsState } from './analytics.ts'
