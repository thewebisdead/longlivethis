import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  DONATION_TIERS,
  tierForAmount,
  reachesTier,
  emptyDonationTierStore,
  parseDonationTierStore,
  serializeDonationTierStore,
  setDonationTiersPath,
  getDonationTiersPath,
  listTierClaims,
  claimTier,
  recognitionStrip,
} from './donationTiers.ts'

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'donation-tiers-test-'))
  const store = join(d, 'donation-tiers.json')
  setDonationTiersPath(store)
  return d
}

function cleanup(d: string): void {
  try { rmSync(d, { recursive: true }) } catch { /* ignored */ }
}

test('DONATION_TIERS are ordered low to high', () => {
  for (let i = 1; i < DONATION_TIERS.length; i++) {
    assert.ok(
      DONATION_TIERS[i].minUsdc > DONATION_TIERS[i - 1].minUsdc,
      `tier ${DONATION_TIERS[i].id} should cost more than ${DONATION_TIERS[i - 1].id}`
    )
  }
})

test('tierForAmount picks the correct tier', () => {
  assert.equal(tierForAmount(4).id, 'supporter') // below minimum still gets the first tier
  assert.equal(tierForAmount(5).id, 'supporter')
  assert.equal(tierForAmount(20).id, 'friend')
  assert.equal(tierForAmount(50).id, 'patron')
  assert.equal(tierForAmount(100).id, 'guardian')
  assert.equal(tierForAmount(250).id, 'founder')
  assert.equal(tierForAmount(500).id, 'founder')
})

test('reachesTier checks thresholds', () => {
  assert.equal(reachesTier(5, 'supporter'), true)
  assert.equal(reachesTier(4, 'supporter'), false)
  assert.equal(reachesTier(20, 'friend'), true)
  assert.equal(reachesTier(19, 'friend'), false)
  assert.equal(reachesTier(250, 'founder'), true)
  assert.equal(reachesTier(249, 'founder'), false)
  assert.equal(reachesTier(100, 'nonexistent'), false)
})

test('setDonationTiersPath/getDonationTiersPath round-trip', () => {
  const orig = getDonationTiersPath()
  setDonationTiersPath('/tmp/test-donation-tiers.json')
  assert.equal(getDonationTiersPath(), '/tmp/test-donation-tiers.json')
  setDonationTiersPath(orig)
})

test('empty store returns no claims', async () => {
  const d = tempDir()
  try {
    const claims = await listTierClaims()
    assert.deepEqual(claims, [])
  } finally {
    cleanup(d)
  }
})

test('claimTier adds a claim', async () => {
  const d = tempDir()
  try {
    const claim = await claimTier({ tierId: 'supporter', name: 'Alice' })
    assert.equal(claim.tierId, 'supporter')
    assert.equal(claim.name, 'Alice')
    assert.equal(claim.address, undefined)
    assert.ok(claim.claimedAt > 0)

    const all = await listTierClaims()
    assert.equal(all.length, 1)
    assert.equal(all[0].name, 'Alice')
  } finally {
    cleanup(d)
  }
})

test('claimTier accepts optional address', async () => {
  const d = tempDir()
  try {
    const claim = await claimTier({
      tierId: 'founder',
      name: 'Bob',
      address: '0x1234567890abcdef1234567890abcdef12345678',
    })
    assert.equal(claim.address, '0x1234567890abcdef1234567890abcdef12345678')
  } finally {
    cleanup(d)
  }
})

test('claimTier rejects unknown tier', async () => {
  const d = tempDir()
  try {
    await assert.rejects(() => claimTier({ tierId: 'bogus', name: 'X' }), /unknown tier/)
  } finally {
    cleanup(d)
  }
})

test('claimTier rejects empty name', async () => {
  const d = tempDir()
  try {
    await assert.rejects(() => claimTier({ tierId: 'supporter', name: '' }), /name required/)
  } finally {
    cleanup(d)
  }
})

test('claimTier rejects long name', async () => {
  const d = tempDir()
  try {
    await assert.rejects(() => claimTier({ tierId: 'supporter', name: 'x'.repeat(61) }), /name too long/)
  } finally {
    cleanup(d)
  }
})

test('recognitionStrip groups claims by tier recognition', () => {
  const claims = [
    { tierId: 'supporter', name: 'A', claimedAt: 1 },
    { tierId: 'friend', name: 'B', claimedAt: 2 },
    { tierId: 'patron', name: 'C', claimedAt: 3, address: '0x1234' },
    { tierId: 'guardian', name: 'D', claimedAt: 4 },
    { tierId: 'founder', name: 'E', claimedAt: 5 },
    { tierId: 'founder', name: 'F', claimedAt: 6 },
  ]
  const r = recognitionStrip(claims)
  assert.equal(r.founders.length, 2)
  assert.equal(r.founders[0].name, 'E')
  assert.equal(r.founders[1].name, 'F')
  assert.equal(r.sponsors.length, 2) // patron + guardian
  assert.equal(r.badges.length, 2) // supporter + friend
})

test('recognitionStrip skips unknown tiers', () => {
  const claims = [
    { tierId: 'supporter', name: 'A', claimedAt: 1 },
    { tierId: 'fake-tier', name: 'B', claimedAt: 2 },
  ]
  const r = recognitionStrip(claims)
  assert.equal(r.founders.length, 0)
  assert.equal(r.sponsors.length, 0)
  assert.equal(r.badges.length, 1)
})

test('round-trip serialize / parse', () => {
  const store = emptyDonationTierStore()
  store.claims.push(
    { tierId: 'supporter', name: 'Alice', claimedAt: 100 },
    { tierId: 'founder', name: 'Bob', address: '0xabcd', claimedAt: 200 },
  )
  const serialized = serializeDonationTierStore(store)
  const parsed = parseDonationTierStore(serialized)
  assert.equal(parsed.claims.length, 2)
  assert.equal(parsed.claims[0].name, 'Alice')
  assert.equal(parsed.claims[1].name, 'Bob')
  assert.equal(parsed.claims[1].address, '0xabcd')
})

test('parseDonationTierStore rejects malformed data', () => {
  assert.throws(() => parseDonationTierStore('not json'), /JSON/)
  assert.throws(() => parseDonationTierStore('{}'), /no claims array/)
})

test('empty input returns empty store', () => {
  const store = parseDonationTierStore('')
  assert.deepEqual(store.claims, [])
})

test('persists claims across reads', async () => {
  const d = tempDir()
  try {
    await claimTier({ tierId: 'patron', name: 'Charlie' })
    const all = await listTierClaims()
    assert.equal(all.length, 1)
    assert.equal(all[0].name, 'Charlie')

    // Re-read to confirm persistence
    const all2 = await listTierClaims()
    assert.equal(all2.length, 1)
  } finally {
    cleanup(d)
  }
})
