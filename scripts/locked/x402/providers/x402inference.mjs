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
import { createSerializer } from '../serialize.mjs'

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

/**
 * Absolute floor for any deposit, in atomic USDC units — 2x the gateway's
 * measured `amount_too_low` cutoff of 1000 ($0.001).
 *
 * The multiplier alone does NOT clear that cutoff: the SDK computes
 * `depositMultiplier * requestAmount`, and a cheap route's per-request ceiling
 * is small enough that 5x it still lands under 1000, so the FIRST top-up on a
 * partly-funded channel would be rejected even though the initial deposit went
 * through. The floor below is what makes every deposit — first and subsequent —
 * a legal one.
 */
const DEPOSIT_FLOOR_ATOMIC = 2000n

/**
 * Size a deposit: the SDK's multiplier-derived amount, raised to the dust floor,
 * and never below the shortfall the request actually needs (the SDK rejects a
 * strategy that returns less than `minimumDepositAmount`).
 */
function depositStrategy(context) {
  const computed = BigInt(context.depositAmount)
  const minimum = BigInt(context.minimumDepositAmount)
  let amount = computed > DEPOSIT_FLOOR_ATOMIC ? computed : DEPOSIT_FLOOR_ATOMIC
  if (amount < minimum) amount = minimum
  return amount.toString()
}

/**
 * Refund retries at shutdown, and the base wait between them (it grows with
 * each attempt). Bounded well under the 60s the workflow's "Stop payment proxy"
 * step allows a SIGTERM to take: an unclaimed refund is recoverable later, a
 * job that never exits is not.
 */
const REFUND_ATTEMPTS = 3
const REFUND_RETRY_MS = 5000

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
      depositStrategy,
    })
    const client = new x402Client().register('eip155:8453', scheme)
    const pay = wrapFetchWithPayment(fetch, client)

    // A batch-settlement channel is STATEFUL on the client side: every voucher
    // is signed against the channel's running total (`chargedCumulativeAmount`
    // plus this request's amount) read out of the scheme's local storage, and a
    // deposit is signed against the balance read at the same moment. Two
    // payments in flight at once therefore both read the same running total,
    // both sign the same cumulative claim, and both try to open/top up the same
    // channel — which the gateway answers with a bare 402
    // (`invalid_batch_settlement_evm_channel_busy`), killing the agent run.
    // opencode's implement session fires concurrent model calls as a matter of
    // course, so this is not a rare race: one payment must fully land (payload
    // signed, upstream answered, local channel state updated) before the next
    // one starts.
    const serialize = createSerializer()

    return {
      /**
       * One upstream request. wrapFetchWithPayment handles the 402 → sign →
       * retry dance itself, so the spend cap is checked HERE, before the call,
       * rather than at the moment of payment.
       */
      async fetch(url, init) {
        return serialize(async () => {
          await assertSpendAllowed()
          return pay(url, init)
        })
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
        // The local queue cannot see a request the GATEWAY is still working on:
        // when an upstream call times out at the edge (524) the channel stays
        // locked server-side until that generation finishes, so a refund fired
        // right after a failed run is answered "channel busy" and the deposit is
        // stranded. Wait it out a few times before giving up.
        for (let attempt = 1; attempt <= REFUND_ATTEMPTS; attempt++) {
          try {
            // Through the same queue: a refund issued while a payment is still in
            // flight is exactly the "channel busy" collision above, and it would
            // strand the deposit instead of reclaiming it.
            const settle = await serialize(() => scheme.refund(targetUrl(baseUrl, 'chat/completions')))
            console.error(`[x402inference] refunded unused channel balance: ${JSON.stringify(settle).slice(0, 300)}`)
            return
          } catch (e) {
            const last = attempt === REFUND_ATTEMPTS
            const msg = e?.message || e
            if (last) {
              console.error(`[x402inference] refund failed (balance stays in the channel): ${msg}`)
              return
            }
            const delay = REFUND_RETRY_MS * attempt
            console.error(`[x402inference] refund attempt ${attempt}/${REFUND_ATTEMPTS} failed (${msg}) — retrying in ${delay}ms`)
            await new Promise((r) => setTimeout(r, delay))
          }
        }
      },
    }
  },
}
