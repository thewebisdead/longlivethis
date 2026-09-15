// Donation link helpers for the treasury.
//
// The treasury is a receive-only USDC wallet on Base. There is no API key, no
// payment processor and no human operator: a visitor funds it by sending USDC
// from their own wallet. These helpers turn the public wallet address into the
// few things a visitor actually needs — a wallet-deep link that pre-fills a
// transfer of a fixed amount (EIP-681), a block-explorer page for browsers
// without a wallet extension, and the plain address to copy by hand.
import { USDC_ADDRESS } from './treasury.ts'

/** Base chain id — the fixed EVM chain the treasury lives on. */
export const BASE_CHAIN_ID = 8453

/** Big-endian hex checksum-free form of an address, '', or throws if invalid. */
export function normalizeAddress(address: string): string {
  const hex = address.toLowerCase().replace(/^0x/, '')
  if (!/^[0-9a-f]{40}$/.test(hex)) throw new Error(`invalid address: ${address}`)
  return hex
}

/**
 * Base explorer URL for an address — browsers without a wallet extension can
 * at least look the treasury up and send to it from a connected account.
 */
export function explorerUrl(walletAddress: string): string {
  return `https://basescan.org/address/0x${normalizeAddress(walletAddress)}`
}

/**
 * EIP-681 payment URI that pre-fills a transfer of `usdcAmount` USDC to the
 * treasury. Handing this to a wallet (via an <a href>) opens it with the
 * token, recipient and amount already filled in; the user just confirms.
 *
 * Form: ethereum:<token>@<chainId>/transfer?address=<to>&uint256=<amount>
 * `usdcAmount` is in whole USDC (default 1); it is scaled by the token's 6
 * decimals to the integer the standard expects. Anything below one whole USDC
 * rounds down to 0 and is meaningless, so amounts are clamped to >= 1.
 */
export function donateUri(walletAddress: string, usdcAmount = 1): string {
  const to = normalizeAddress(walletAddress)
  const amount = BigInt(Math.max(1, Math.round(usdcAmount * 1e6)))
  return `ethereum:${USDC_ADDRESS}@${BASE_CHAIN_ID}/transfer?address=0x${to}&uint256=${amount}`
}
