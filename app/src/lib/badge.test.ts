import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderBadge } from './badge.ts'

test('renderBadge produces an SVG with label and message text', () => {
  const svg = renderBadge('treasury', '$12.34 USDC')
  assert.match(svg, /^<svg /)
  assert.match(svg, /<text[^>]*>treasury<\/text>/)
  assert.match(svg, /<text[^>]*>\$12\.34 USDC<\/text>/)
  assert.match(svg, /aria-label="treasury: \$12\.34 USDC"/)
})

test('renderBadge escapes special XML characters', () => {
  const svg = renderBadge('a&b', '<x>')
  assert.match(svg, /a&amp;b/)
  assert.match(svg, /&lt;x&gt;/)
  assert.doesNotMatch(svg, /<x>/)
})

test('renderBadge widens with longer text', () => {
  const short = renderBadge('a', 'b')
  const long = renderBadge('treasury', '$1234567.89 USDC')
  const widthOf = (svg: string) => Number(svg.match(/width="(\d+)"/)?.[1])
  assert.ok(widthOf(long) > widthOf(short))
})

test('renderBadge accepts a custom value color', () => {
  const svg = renderBadge('treasury', 'unknown', { color: '#999' })
  assert.match(svg, /fill="#999"/)
})
