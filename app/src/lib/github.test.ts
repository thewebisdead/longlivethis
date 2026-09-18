import { test } from 'node:test'
import assert from 'node:assert/strict'
// .ts extension: `node --test` runs this file directly (type stripping).
import {
  mapIssue,
  normalizeText,
  issueTitle,
  extractCategory,
  embedCategory,
  extractEconomics,
  embedEconomics,
  hasEconomics,
  type GhIssue,
} from './github.ts'
import { EMPTY_ECONOMICS } from './types.ts'

const base: GhIssue = {
  number: 7,
  title: 'Add a guestbook',
  body: 'Add a guestbook where visitors can leave a note.',
  html_url: 'https://github.com/o/r/issues/7',
  created_at: '2026-07-16T00:00:00Z',
  reactions: { '+1': 4 },
}

test('mapIssue maps an open issue to a proposal', () => {
  assert.deepEqual(mapIssue(base), {
    id: 7,
    title: 'Add a guestbook',
    text: 'Add a guestbook where visitors can leave a note.',
    votes: 4,
    url: 'https://github.com/o/r/issues/7',
    created_at: '2026-07-16T00:00:00Z',
    category: 'standard',
    economics: { ...EMPTY_ECONOMICS },
  })
})

test('mapIssue falls back to the title when the body is empty', () => {
  assert.equal(mapIssue({ ...base, body: null }).text, 'Add a guestbook')
  assert.equal(mapIssue({ ...base, body: '  ' }).text, 'Add a guestbook')
})

test('mapIssue defaults votes to 0 when reactions are missing', () => {
  assert.equal(mapIssue({ ...base, reactions: undefined }).votes, 0)
})

test('extractCategory reads the embedded category from the body', () => {
  assert.equal(extractCategory('<!-- category: revenue -->\n\nSell API access'), 'revenue')
  assert.equal(extractCategory('<!-- category: feature -->\n\nAdd dark mode'), 'feature')
  assert.equal(extractCategory('<!-- category: cost-saving -->\n\nCut spend'), 'cost-saving')
  assert.equal(extractCategory('<!-- category: bogus -->\n\nNope'), 'standard')
  assert.equal(extractCategory('no category here'), 'standard')
  assert.equal(extractCategory(null), 'standard')
})

test('mapIssue surfaces a revenue category from the embedded comment', () => {
  const p = mapIssue({
    ...base,
    body: '<!-- category: revenue -->\n\nGenerate revenue by selling API keys.',
  })
  assert.equal(p.category, 'revenue')
  assert.equal(p.text, '<!-- category: revenue -->\n\nGenerate revenue by selling API keys.')
})

test('embedCategory prepends the category comment to a body', () => {
  const embedded = embedCategory('Sell API access', 'revenue')
  assert.ok(embedded.startsWith('<!-- category: revenue -->'))
  assert.ok(embedded.includes('Sell API access'))
  // Round-trips back to the same category.
  assert.equal(extractCategory(embedded), 'revenue')
})

test('mapIssue counts only 👍 and 👎, ignoring other emojis', () => {
  // 2 👍, 3 👎 → net −1 (other emojis on the issue don't affect the score)
  const p = mapIssue({ ...base, reactions: { '+1': 2, '-1': 3 } })
  assert.equal(p.votes, -1)
})

test('normalizeText collapses whitespace and case for dedupe', () => {
  assert.equal(normalizeText('  Add   a\nGuestbook '), 'add a guestbook')
})

test('issueTitle keeps short single lines and truncates long ones', () => {
  assert.equal(issueTitle('Add a guestbook'), 'Add a guestbook')
  assert.equal(issueTitle('first line\nsecond line'), 'first line')
  const long = 'x'.repeat(200)
  const t = issueTitle(long)
  assert.ok(t.length <= 80)
  assert.ok(t.endsWith('…'))
})

test('extractEconomics reads embedded estimate comments from a body', () => {
  const body =
    '<!-- ec-cost: 12.5 -->\n<!-- ec-recurring: 2 -->\n<!-- ec-benefit: 30 -->\n<!-- ec-kind: revenue -->\n<!-- ec-runway: 14 -->\n\nSell API access'
  assert.deepEqual(extractEconomics(body), {
    estimatedCostUsdc: 12.5,
    recurringCostUsdc: 2,
    expectedBenefitUsdc: 30,
    benefitKind: 'revenue',
    runwayImpactDays: 14,
  })
})

test('extractEconomics defaults to empty when no comments present', () => {
  assert.deepEqual(extractEconomics('Add a guestbook'), { ...EMPTY_ECONOMICS })
  assert.deepEqual(extractEconomics(null), { ...EMPTY_ECONOMICS })
  assert.deepEqual(extractEconomics(undefined), { ...EMPTY_ECONOMICS })
})

test('extractEconomics tolerates partially-specified and malformed comments', () => {
  // Only a savings kind and a runway; the numeric fields stay null.
  const p = extractEconomics('<!-- ec-kind: savings -->\n<!-- ec-runway: -3 -->\nCut spend')
  assert.equal(p.benefitKind, 'savings')
  assert.equal(p.runwayImpactDays, -3)
  assert.equal(p.estimatedCostUsdc, null)
  // Malformed kind is ignored, not stored.
  assert.equal(extractEconomics('<!-- ec-kind: nope -->\nx').benefitKind, null)
})

test('mapIssue surfaces economics from the embedded comments', () => {
  const p = mapIssue({
    ...base,
    body: '<!-- ec-cost: 5 -->\n<!-- ec-benefit: 20 -->\n<!-- ec-kind: savings -->\n\nCut hosting spend',
  })
  assert.equal(p.economics.estimatedCostUsdc, 5)
  assert.equal(p.economics.expectedBenefitUsdc, 20)
  assert.equal(p.economics.benefitKind, 'savings')
})

test('embedEconomics appends estimate comments to a body and round-trips', () => {
  const body = embedEconomics('Pay for the API key', {
    estimatedCostUsdc: 8,
    recurringCostUsdc: null,
    expectedBenefitUsdc: 40,
    benefitKind: 'revenue',
    runwayImpactDays: 21,
  })
  assert.ok(body.startsWith('Pay for the API key'))
  assert.equal(extractEconomics(body).estimatedCostUsdc, 8)
  assert.equal(extractEconomics(body).benefitKind, 'revenue')
  assert.equal(extractEconomics(body).runwayImpactDays, 21)
  assert.equal(extractEconomics(body).recurringCostUsdc, null)
})

test('embedEconomics leaves the body unchanged when economics are empty', () => {
  assert.equal(embedEconomics('Just a body', { ...EMPTY_ECONOMICS }), 'Just a body')
})

test('hasEconomics reports whether any estimate exists', () => {
  assert.equal(hasEconomics({ ...EMPTY_ECONOMICS }), false)
  assert.equal(hasEconomics({ ...EMPTY_ECONOMICS, estimatedCostUsdc: 1 }), true)
  assert.equal(hasEconomics({ ...EMPTY_ECONOMICS, runwayImpactDays: 10 }), true)
})
