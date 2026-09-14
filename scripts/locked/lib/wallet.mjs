/**
 * FROZEN — wallet private-key reader and viem account
 */
import { privateKeyToAccount } from 'viem/accounts'

/** Read WALLET_PRIVATE_KEY from env, normalize to 0x-prefixed, throw if unset. */
export function pk() {
  const raw = process.env.WALLET_PRIVATE_KEY?.trim()
  if (!raw) throw new Error('WALLET_PRIVATE_KEY is required')
  return /** @type {`0x${string}`} */ (raw.startsWith('0x') ? raw : `0x${raw}`)
}

/** viem account derived from WALLET_PRIVATE_KEY. */
export function makeAccount() {
  return privateKeyToAccount(pk())
}
