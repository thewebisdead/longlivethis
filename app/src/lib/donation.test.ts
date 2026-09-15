import { test } from 'node:test'
import assert from 'node:assert/strict'
import { donateUri, explorerUrl, normalizeAddress, BASE_CHAIN_ID } from './donation.ts'
import { USDC_ADDRESS } from './treasury.ts'

test('normalizeAddress strips 0x prefix and lowercases', () => {
  assert.equal(
    normalizeAddress('0xABCDEF0123456789012345678901234567890123'),
    'abcdef0123456789012345678901234567890123'
  )
  assert.equal(
    normalizeAddress('abcdef0123456789012345678901234567890123'),
    'abcdef0123456789012345678901234567890123'
  )
})

test('normalizeAddress throws on invalid hex', () => {
  assert.throws(() => normalizeAddress(''), /invalid address/)
  assert.throws(() => normalizeAddress('0xzzz'), /invalid address/)
  assert.throws(() => normalizeAddress('0x1234'), /invalid address/)
})

test('explorerUrl builds basescan link', () => {
  const url = explorerUrl('0xAbCdef0123456789012345678901234567890123')
  assert.equal(url, 'https://basescan.org/address/0xabcdef0123456789012345678901234567890123')
})

test('explorerUrl throws on invalid address', () => {
  assert.throws(() => explorerUrl(''), /invalid address/)
})

test('donateUri builds an EIP-681 transfer URI', () => {
  const addr = '0xAbCdef0123456789012345678901234567890123'
  const uri = donateUri(addr)
  // Should contain the token, chain, recipient and amount.
  assert.ok(uri.startsWith('ethereum:'))
  assert.ok(uri.includes(USDC_ADDRESS))
  assert.ok(uri.includes(`@${BASE_CHAIN_ID}`))
  assert.ok(uri.includes('transfer?'))
  assert.ok(uri.includes('address=0xabcdef0123456789012345678901234567890123'))
  // Default amount 1 USDC = 1000000 (6 decimals)
  assert.ok(uri.includes('uint256=1000000'))
})

test('donateUri accepts a custom amount', () => {
  const addr = '0x0000000000000000000000000000000000000000'
  const uri = donateUri(addr, 5)
  assert.ok(uri.includes('uint256=5000000'))
})

test('donateUri accepts fractional amounts', () => {
  const addr = '0x0000000000000000000000000000000000000000'
  const uri = donateUri(addr, 0.5)
  assert.ok(uri.includes('uint256=500000'), '0.5 USDC = 500000/1e6')
})

test('donateUri never emits a zero amount', () => {
  const addr = '0x0000000000000000000000000000000000000000'
  // Sub-micro amounts round to 0 wei — clamped up to the smallest transferable
  // unit so the link is never an empty transfer.
  const uri = donateUri(addr, 0.0000000001)
  assert.ok(uri.includes('uint256=1'))
})

test('donateUri validates the address', () => {
  assert.throws(() => donateUri(''), /invalid address/)
  assert.throws(() => donateUri('not-an-address'), /invalid address/)
})
