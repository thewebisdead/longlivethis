import { test } from 'node:test'
import assert from 'node:assert/strict'
// .ts extension: `node --test` runs this file directly (type stripping).
import { mapIssue, normalizeText, issueTitle, extractCategory, embedCategory, type GhIssue } from './github.ts'

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
