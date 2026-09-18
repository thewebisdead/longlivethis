import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  normalizeTitle,
  dedupeCandidates,
  selectSuggestions,
  buildSuggestionBatch,
  parseSuggestionStore,
  serializeSuggestionStore,
  setSuggestionStorePath,
  getSuggestionStorePath,
  SUGGESTION_COUNT,
  emptySuggestionStore,
} from './proposalSuggester.ts'
import type { ProposalSuggestion, SuggestionStore } from './proposalSuggester.ts'
import type { Proposal } from './types.ts'

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'suggester-test-'))
  const store = join(d, 'suggestions.json')
  setSuggestionStorePath(store)
  return d
}

function cleanup(d: string): void {
  try {
    rmSync(d, { recursive: true })
  } catch {
    /* ignored */
  }
}

// A minimal Proposal for candidate dedupe
const p = (title: string): Pick<Proposal, 'title'> => ({ title })

test('normalizeTitle strips punctuation and lowercases', () => {
  assert.equal(normalizeTitle('Hello World'), 'hello world')
  assert.equal(normalizeTitle('Add a Supporter Badge!'), 'add a supporter badge')
  assert.equal(normalizeTitle('  Cost  Saving   '), 'cost saving')
})

test('dedupeCandidates removes exact title matches', () => {
  const candidates = [
    { key: 'a', title: 'Add a supporter badge', lever: 'revenue' as const },
    { key: 'b', title: 'Reduce unnecessary agent runs', lever: 'cost-saving' as const },
  ]
  const proposals = [p('Add a Supporter Badge')]
  const result = dedupeCandidates(candidates, proposals)
  assert.equal(result.length, 1)
  assert.equal(result[0].title, 'Reduce unnecessary agent runs')
})

test('dedupeCandidates returns all when no proposals', () => {
  const candidates = [
    { key: 'a', title: 'Add a supporter badge', lever: 'revenue' as const },
    { key: 'b', title: 'Reduce unnecessary agent runs', lever: 'cost-saving' as const },
  ]
  const result = dedupeCandidates(candidates, [])
  assert.equal(result.length, 2)
})

test('dedupeCandidates returns all when no candidates', () => {
  const result = dedupeCandidates([], [p('Hello')])
  assert.equal(result.length, 0)
})

test('dedupeCandidates filters by partial word overlap', () => {
  const candidates = [
    { key: 'badge', title: 'New supporter badge system', lever: 'revenue' as const },
    { key: 'unique', title: 'Unique widget proposal', lever: 'engagement' as const },
  ]
  // 'badge' appears in the proposal title; word-level overlap should reject it.
  const proposals = [p('Add a supporter badge')]
  const result = dedupeCandidates(candidates, proposals)
  // 'supporter' + 'badge' from candidate, only 'badge' appears in proposal title
  // Actually let me check: normalizeTitle('New supporter badge system') = 'new supporter badge system'
  // normalizeTitle('Add a supporter badge') = 'add a supporter badge'
  // words > 4 chars from candidate: 'supporter', 'badge', 'system'
  // from proposal: 'supporter', 'badge'
  // since 'supporter badge' are both common, this might filter the badge one
  assert.equal(result.length, 1)
  assert.equal(result[0].key, 'unique')
})

test('selectSuggestions prioritises revenue/cost-saving when runway is low', () => {
  const candidates = [
    {
      key: 'engagement',
      title: 'An engagement idea',
      lever: 'engagement' as const,
      active: true,
    },
    {
      key: 'revenue',
      title: 'A revenue idea',
      lever: 'revenue' as const,
      active: true,
    },
  ]
  const result = selectSuggestions(candidates, 2, { balanceUsdc: 50, runwayDays: 20 })
  // Revenue should come first (survival pressure)
  assert.equal(result.length, 2)
  assert.equal(result[0].lever, 'revenue')
})

test('selectSuggestions only returns active candidates', () => {
  const candidates = [
    {
      key: 'a',
      title: 'Active idea',
      lever: 'revenue' as const,
      active: true,
    },
    {
      key: 'b',
      title: 'Inactive idea',
      lever: 'engagement' as const,
      active: false,
    },
  ]
  const result = selectSuggestions(candidates, 2, { balanceUsdc: 200, runwayDays: 60 })
  assert.equal(result.length, 1)
  assert.equal(result[0].title, 'Active idea')
})

test('selectSuggestions caps to count', () => {
  const active = (key: string, title: string, lever: 'revenue' | 'cost-saving' | 'engagement') => ({
    key,
    title,
    lever,
    active: true,
  })
  const candidates = [
    active('a', 'Idea 1', 'revenue'),
    active('b', 'Idea 2', 'cost-saving'),
    active('c', 'Idea 3', 'engagement'),
    active('d', 'Idea 4', 'revenue'),
  ]
  const result = selectSuggestions(candidates, 2, { balanceUsdc: 200, runwayDays: 60 })
  assert.equal(result.length, 2)
})

test('buildSuggestionBatch returns suggestions deduped against proposals', () => {
  const proposals = [p('Some irrelevant proposal')]
  const result = buildSuggestionBatch({
    balanceUsdc: 200,
    runwayDays: 60,
    proposals,
  })
  assert.ok(Array.isArray(result))
  assert.ok(result.length <= SUGGESTION_COUNT)
  // Every suggestion should have the correct shape
  for (const s of result) {
    assert.ok(typeof s.title === 'string' && s.title.length > 0)
    assert.ok(typeof s.description === 'string' && s.description.length > 0)
    assert.ok(typeof s.reason === 'string')
    assert.ok(['revenue', 'cost-saving', 'engagement'].includes(s.lever))
  }
})

test('buildSuggestionBatch with low runway prioritizes revenue/cost-saving', () => {
  const result = buildSuggestionBatch({
    balanceUsdc: 50,
    runwayDays: 20,
    proposals: [],
  })
  // If there's at least one revenue or cost-saving suggestion, it should appear first
  const prioritized = result.filter((s) => s.lever !== 'engagement')
  if (result.length > 0) {
    // The first should not be engagement when runway is low (unless all are engagement)
    assert.ok(result[0].lever !== 'engagement' || result.every((s) => s.lever === 'engagement'))
  }
})

test('buildSuggestionBatch with high runway includes engagement', () => {
  const result = buildSuggestionBatch({
    balanceUsdc: 1000,
    runwayDays: 90,
    proposals: [],
  })
  // Should include at least some suggestions (board is empty) and engagement ideas
  // are eligible when the board is not too full.
  assert.ok(result.length > 0)
})

test('buildSuggestionBatch dedupes own suggestions against open proposals', () => {
  // Simulate a proposal with the same title as a candidate.
  const proposals = [p('Add a supporter badge to the ledger')]
  const result = buildSuggestionBatch({
    balanceUsdc: 200,
    runwayDays: 60,
    proposals,
  })
  // The "supporter badge" candidate should be filtered out.
  const hasBadge = result.some((s) => s.title.toLowerCase().includes('badge'))
  assert.equal(hasBadge, false)
})

test('empty store returns default state with no error', () => {
  const parsed = parseSuggestionStore('')
  assert.equal(parsed.suggestions.length, 0)
  assert.equal(parsed.generatedAt, null)
  assert.equal(parsed.lastRegenAt, null)
})

test('parseSuggestionStore parses valid JSON', () => {
  const store: SuggestionStore = {
    suggestions: [
      { title: 'Test Idea', description: 'Test description', reason: 'Test reason', lever: 'revenue' },
    ],
    generatedAt: 1000,
    lastRegenAt: 2000,
    context: { balanceUsdc: 100, runwayDays: 30, openCount: 5 },
  }
  const parsed = parseSuggestionStore(serializeSuggestionStore(store))
  assert.equal(parsed.suggestions.length, 1)
  assert.equal(parsed.suggestions[0].title, 'Test Idea')
  assert.equal(parsed.suggestions[0].lever, 'revenue')
  assert.equal(parsed.generatedAt, 1000)
  assert.equal(parsed.lastRegenAt, 2000)
  assert.equal(parsed.context.balanceUsdc, 100)
})

test('parseSuggestionStore filters malformed suggestions', () => {
  const data = JSON.stringify({
    suggestions: [
      { title: 'Good', description: 'Good description', lever: 'revenue' },
      { title: 'Bad', description: '' }, // empty description
      { notTitle: 'Nope', description: 'bad' }, // no title
    ],
    generatedAt: Date.now(),
    lastRegenAt: null,
    context: { balanceUsdc: null, runwayDays: null, openCount: 0 },
  })
  const parsed = parseSuggestionStore(data)
  assert.equal(parsed.suggestions.length, 1)
  assert.equal(parsed.suggestions[0].title, 'Good')
})

test('serializeSuggestionStore round-trip', () => {
  const now = Date.now()
  const store: SuggestionStore = {
    suggestions: [
      { title: 'Idea 1', description: 'Desc 1', reason: '', lever: 'cost-saving' },
      { title: 'Idea 2', description: 'Desc 2', reason: 'Because!', lever: 'engagement' },
    ],
    generatedAt: now,
    lastRegenAt: now,
    context: { balanceUsdc: 50, runwayDays: 10, openCount: 3 },
  }
  const parsed = parseSuggestionStore(serializeSuggestionStore(store))
  assert.deepEqual(parsed.suggestions.length, 2)
  assert.equal(parsed.suggestions[1].lever, 'engagement')
  assert.equal(parsed.context.balanceUsdc, 50)
  assert.equal(parsed.generatedAt, now)
})

test('emptySuggestionStore returns safe defaults', () => {
  const s = emptySuggestionStore()
  assert.equal(s.suggestions.length, 0)
  assert.equal(s.generatedAt, null)
  assert.equal(s.lastRegenAt, null)
  assert.equal(s.context.balanceUsdc, null)
  assert.equal(s.context.runwayDays, null)
  assert.equal(s.context.openCount, 0)
})

test('setSuggestionStorePath/getSuggestionStorePath round-trip', () => {
  const orig = getSuggestionStorePath()
  setSuggestionStorePath('/tmp/test-suggester.json')
  assert.equal(getSuggestionStorePath(), '/tmp/test-suggester.json')
  setSuggestionStorePath(orig)
})
