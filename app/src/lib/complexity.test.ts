import { test } from 'node:test'
import assert from 'node:assert/strict'
import { estimateComplexity } from './complexity.ts'

test('short simple text is classified as cheap', () => {
  assert.equal(estimateComplexity('Change the button color to red'), 'cheap')
  assert.equal(estimateComplexity('Fix typo in the header'), 'cheap')
  assert.equal(estimateComplexity('Rename the submit button'), 'cheap')
})

test('moderate proposals are classified as standard', () => {
  assert.equal(estimateComplexity('Add a dark mode toggle to the settings page'), 'standard')
  assert.equal(
    estimateComplexity('Add a footer with links to privacy policy and terms of service'),
    'standard'
  )
})

test('complex signals trigger the complex tier', () => {
  assert.equal(
    estimateComplexity('Migrate the database to PostgreSQL and add authentication'),
    'complex'
  )
  assert.equal(
    estimateComplexity('Add real-time WebSocket notifications for new proposals'),
    'complex'
  )
  assert.equal(
    estimateComplexity('Refactor entire architecture to use microservices with infrastructure-as-code'),
    'complex'
  )
})

test('long proposals default to complex regardless of signals', () => {
  // 41+ words triggers the long-proposal threshold
  const long = Array(42).fill('word').join(' ')
  assert.equal(estimateComplexity(long), 'complex')
})

test('very short proposals without cheap signals are cheap', () => {
  assert.equal(estimateComplexity('Add link to readme'), 'cheap')
})
