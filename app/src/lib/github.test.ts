import { test } from 'node:test'
import assert from 'node:assert/strict'
// .ts extension: `node --test` runs this file directly (type stripping).
import { mapIssue, normalizeText, issueTitle, parseBoostTotal, setBoostTotal, type GhIssue } from './github.ts'

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
    text: 'Add a guestbook where visitors can leave a note.',
    votes: 4,
    url: 'https://github.com/o/r/issues/7',
    created_at: '2026-07-16T00:00:00Z',
    boosted: false,
    boostTotal: 0,
  })
})

test('mapIssue falls back to the title when the body is empty', () => {
  assert.equal(mapIssue({ ...base, body: null }).text, 'Add a guestbook')
  assert.equal(mapIssue({ ...base, body: '  ' }).text, 'Add a guestbook')
})

test('mapIssue defaults votes to 0 when reactions are missing', () => {
  assert.equal(mapIssue({ ...base, reactions: undefined }).votes, 0)
})

test('mapIssue marks boosted when the boosted label is present', () => {
  assert.equal(mapIssue({ ...base, labels: [{ name: 'boosted' }] }).boosted, true)
  assert.equal(mapIssue({ ...base, labels: [{ name: 'other' }] }).boosted, false)
  assert.equal(mapIssue({ ...base, labels: [] }).boosted, false)
  assert.equal(mapIssue({ ...base, labels: undefined }).boosted, false)
})

test('parseBoostTotal extracts total from issue body comment', () => {
  assert.equal(parseBoostTotal('some text\n<!-- boost_total: 15.500000 -->'), 15.5)
  assert.equal(parseBoostTotal('no comment here'), 0)
  assert.equal(parseBoostTotal(null), 0)
  assert.equal(parseBoostTotal(undefined), 0)
})

test('setBoostTotal inserts or updates the boost comment in the body', () => {
  const body1 = setBoostTotal('Add a guestbook', 5)
  assert.ok(body1.includes('<!-- boost_total: 5.000000 -->'))
  const body2 = setBoostTotal(body1, 15)
  assert.ok(body2.includes('<!-- boost_total: 15.000000 -->'))
  // Ensure the old value is replaced (only one boost comment)
  assert.equal((body2.match(/boost_total/g) ?? []).length, 1)
})

test('mapIssue strips boost comment from displayed text', () => {
  const bodyWithBoost = 'Add a guestbook\n<!-- boost_total: 7.000000 -->'
  assert.equal(mapIssue({ ...base, body: bodyWithBoost }).text, 'Add a guestbook')
  assert.equal(mapIssue({ ...base, body: bodyWithBoost }).boostTotal, 7)
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
