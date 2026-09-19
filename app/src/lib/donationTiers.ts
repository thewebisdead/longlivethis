/**
 * Donation reward tiers — recognisable funding levels with concrete returns.
 *
 * One-off donations are the honest floor of this app's income, but a bare
 * "send USDC" button gives a supporter nothing to point at afterwards. This
 * module turns that one-off act into a structured menu: give a fixed amount,
 * get an identifiable tier — a thank-you line, a badge, a named sponsor slot
 * or a founder spot on the homepage. Supporters see exactly what different
 * amounts buy, and the app gets repeatable, tiered funding.
 *
 * The treasury is a receive-only USDC wallet: the app cannot read who sent
 * what (no wallet key, no payment processor). So a tier is **claimed**, not
 * attributed: a donor sends USDC for a tier's amount, then submits a claim
 * with the display name they want recognized. Claims are self-attesting and
 * public — the app records them on the durable state volume and renders the
 * recognition live on the homepage. A claim has an optional wallet address so
 * a recognizable on-chain address can be shown, but only the display name is
 * required.
 */

import { readFile, writeFile, mkdir, rename } from 'node:fs/promises'

// ─── Import pure tier definitions from the shared constants file ────────

import {
  DONATION_TIERS,
  tierForAmount,
  reachesTier,
} from './donationTiers.common.ts'

export type { TierRecognition, DonationTier } from './donationTiers.common.ts'
export { DONATION_TIERS, tierForAmount, reachesTier }

// ─── Types ────────────────────────────────────────────────────────────────

export interface TierClaim {
  /** Tier id this claim is for. */
  tierId: string
  /** Display name the supporter wants recognized. */
  name: string
  /** Optional on-chain address shown next to the name. */
  address?: string
  /** Unix ms the claim was recorded. */
  claimedAt: number
}

export interface DonationTierStore {
  /** Claims in the order they were recorded (oldest first). */
  claims: TierClaim[]
}

// ─── Config ───────────────────────────────────────────────────────────────

/**
 * Path to the tier-claims store on the durable state volume. Overridable for
 * tests.
 */
let storePath = '/var/lib/longlive/state/donation-tiers.json'

export function setDonationTiersPath(path: string): void {
  storePath = path
}

export function getDonationTiersPath(): string {
  return storePath
}

// ─── Store I/O ────────────────────────────────────────────────────────────

export function emptyDonationTierStore(): DonationTierStore {
  return { claims: [] }
}

export function parseDonationTierStore(data: string): DonationTierStore {
  if (!data.trim()) return emptyDonationTierStore()
  const parsed = JSON.parse(data) as Partial<DonationTierStore>
  if (!parsed || !Array.isArray(parsed.claims)) {
    throw new Error('donation tier store has no claims array')
  }
  const claims = parsed.claims
    .filter(
      (c): c is TierClaim =>
        !!c &&
        typeof (c as TierClaim).tierId === 'string' &&
        typeof (c as TierClaim).name === 'string' &&
        typeof (c as TierClaim).claimedAt === 'number'
    )
    .map((c) => ({
      tierId: String((c as TierClaim).tierId),
      name: String((c as TierClaim).name),
      address: typeof (c as TierClaim).address === 'string' ? (c as TierClaim).address : undefined,
      claimedAt: (c as TierClaim).claimedAt,
    }))
  return { claims }
}

export function serializeDonationTierStore(store: DonationTierStore): string {
  return JSON.stringify(store) + '\n'
}

async function readDonationTierStore(): Promise<DonationTierStore> {
  try {
    const data = await readFile(storePath, 'utf8')
    return parseDonationTierStore(data)
  } catch (err: unknown) {
    if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
      return emptyDonationTierStore()
    }
    console.error('donationTiers: failed to read store:', err)
    return emptyDonationTierStore()
  }
}

async function writeDonationTierStore(store: DonationTierStore): Promise<void> {
  const dir = storePath.substring(0, storePath.lastIndexOf('/'))
  await mkdir(dir, { recursive: true })
  const tmp = storePath + '.tmp.' + Date.now()
  await writeFile(tmp, serializeDonationTierStore(store), 'utf8')
  await rename(tmp, storePath)
}

// ─── Public API ───────────────────────────────────────────────────────────

/** All recorded tier claims, oldest first. */
export async function listTierClaims(): Promise<TierClaim[]> {
  const store = await readDonationTierStore()
  return store.claims
}

/**
 * Claims that are currently recognized on the homepage. Founder and sponsor
 * claims make the top strip; badge/thanks claims appear in the badge row.
 * Start with founders so permanent top billing stays visible. Pure.
 */
export function recognitionStrip(claims: TierClaim[]): {
  founders: TierClaim[]
  sponsors: TierClaim[]
  badges: TierClaim[]
} {
  const founders: TierClaim[] = []
  const sponsors: TierClaim[] = []
  const badges: TierClaim[] = []
  for (const c of claims) {
    const tier = DONATION_TIERS.find((t) => t.id === c.tierId)
    if (!tier) continue
    if (tier.recognition === 'founder') founders.push(c)
    else if (tier.recognition === 'sponsor') sponsors.push(c)
    else badges.push(c)
  }
  return { founders, sponsors, badges }
}

export interface TierClaimInput {
  tierId: string
  name: string
  address?: string
}

/**
 * Record a supporter's claim to a tier. The tier must exist and the name must
 * be non-empty; the address, when given, is stored verbatim for display.
 */
export async function claimTier(input: TierClaimInput): Promise<TierClaim> {
  const tier = DONATION_TIERS.find((t) => t.id === input.tierId)
  if (!tier) throw new Error(`unknown tier: ${String(input.tierId)}`)
  const name = input.name.trim()
  if (!name) throw new Error('name required')
  if (name.length > 60) throw new Error('name too long')
  const address = input.address?.trim()
  if (address && address.length > 64) throw new Error('address too long')

  const store = await readDonationTierStore()
  const claim: TierClaim = {
    tierId: tier.id,
    name,
    ...(address ? { address } : {}),
    claimedAt: Date.now(),
  }
  store.claims.push(claim)
  await writeDonationTierStore(store)
  return claim
}
