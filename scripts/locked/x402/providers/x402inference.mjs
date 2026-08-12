/**
 * FROZEN — x402inference.com adapter (the default provider).
 *
 * Payment scheme: x402 `batch-settlement`. One ERC-3009 deposit opens an
 * on-chain escrow channel; after that each request is a plain EIP-712 voucher —
 * no new signature deposit, no gas, no per-request settlement — until the
 * channel needs topping up. Unspent channel balance is reclaimed cooperatively
 * with refund() when the run ends (see close()).
 *
 * The gateway needs no account, no API key and no wallet whitelist: the payment
 * authorization IS the credential. Model ids are exactly what
 * GET /accountless/models lists.
 */
import { createPublicClient, http } from 'viem'
import { base } from 'viem/chains'
import { x402Client, wrapFetchWithPayment } from '@x402/fetch'
import { BatchSettlementEvmScheme, toClientEvmSigner } from '@x402/evm'
import { assertSpendAllowed, invalidateSpendCache } from '../spend-cap.mjs'

/**
 * How much headroom each on-chain deposit buys, as a multiple of the offer's
 * per-request ceiling.
 *
 * NOT a tuning knob to lower. Depositing only the exact shortfall (the SDK's
 * `context.minimumDepositAmount`) produces dust top-ups of tens to hundreds of
 * atomic units once a channel has partial headroom, and the gateway rejects any
 * deposit below 1000 atomic units ($0.001) with `amount_too_low` — a floor
 * bisected exactly. Padding well past that floor is what makes the channel
 * behave as designed: one deposit, many voucher-only requests, refund the rest.
 */
const DEPOSIT_MULTIPLIER = 5

/** Map a local proxy path (`/v1/chat/completions`) onto the gateway's path. */
function targetUrl(baseUrl, path) {
  const rest = String(path).replace(/^\/+/, '').replace(/^v1\//, '')
  return `${baseUrl}/${rest}`
}

export const x402inference = {
  id: 'x402inference',
  defaultBaseUrl: 'https://x402inference.com/accountless',
  hosts: ['x402inference.com'],
  targetUrl,

  async open({ account, baseUrl }) {
    // readContract is required: the scheme reads the channel's on-chain balance
    // before deciding whether a request needs a deposit. A bare account has no
    // readContract, so it must be composed with a public client.
    const publicClient = createPublicClient({ chain: base, transport: http() })
    const signer = toClientEvmSigner(account, publicClient)
    const scheme = new BatchSettlementEvmScheme(signer, {
      depositPolicy: { depositMultiplier: DEPOSIT_MULTIPLIER },
    })
    const client = new x402Client().register('eip155:8453', scheme)
    const pay = wrapFetchWithPayment(fetch, client)

    return {
      /**
       * One upstream request. wrapFetchWithPayment handles the 402 → sign →
       * retry dance itself, so the spend cap is checked HERE, before the call,
       * rather than at the moment of payment.
       */
      async fetch(url, init) {
        await assertSpendAllowed()
        return pay(url, init)
      },

      /** Nothing to refresh: the scheme tops the channel up on its own. */
      async refresh() {
        invalidateSpendCache()
      },

      /**
       * End of run: hand back whatever of the deposit was not consumed. Best
       * effort — a failed refund strands the remainder in the channel, where
       * the next run's scheme picks it up (or a timed withdrawal recovers it),
       * so it must never fail the job.
       */
      async close() {
        try {
          const settle = await scheme.refund(targetUrl(baseUrl, 'chat/completions'))
          console.error(`[x402inference] refunded unused channel balance: ${JSON.stringify(settle).slice(0, 300)}`)
        } catch (e) {
          console.error(`[x402inference] refund failed (balance stays in the channel): ${e?.message || e}`)
        }
      },
    }
  },
}
