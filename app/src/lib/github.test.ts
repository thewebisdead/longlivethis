import { test } from 'node:test'
import assert from 'node:assert/strict'
// .ts extension: `node --test` runs this file directly (type stripping).
import { mapIssue, normalizeText, issueTitle, type GhIssue } from './github.ts'

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
  })
})

test('mapIssue falls back to the title when the body is empty', () => {
  assert.equal(mapIssue({ ...base, body: null }).text, 'Add a guestbook')
  assert.equal(mapIssue({ ...base, body: '  ' }).text, 'Add a guestbook')
})

test('mapIssue defaults votes to 0 when reactions are missing', () => {
  assert.equal(mapIssue({ ...base, reactions: undefined }).votes, 0)
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
