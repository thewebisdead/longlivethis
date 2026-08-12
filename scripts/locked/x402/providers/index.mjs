/**
 * FROZEN — the inference-provider seam.
 *
 * Every gateway the agent's inference can be bought from lives behind one small
 * interface, so swapping providers is a repo VARIABLE change plus one adapter
 * file — never a change to the proxy, the agent steps, or anything that spends.
 *
 * A provider adapter is an object:
 *
 *   id             string   — the INFERENCE_PROVIDER value that selects it
 *   defaultBaseUrl string   — used when INFERENCE_BASE_URL is unset
 *   hosts          string[] — hostnames that imply this provider when only
 *                             INFERENCE_BASE_URL is set
 *   targetUrl(baseUrl, path) -> string
 *                           — map a local proxy path ("/v1/chat/completions")
 *                             onto the gateway's URL
 *   open({ account, baseUrl }) -> Promise<session>
 *                           — one-time per-run setup (open a channel, top a
 *                             prepaid balance up, …)
 *
 * A session is:
 *
 *   fetch(url, init, path) -> Promise<Response>
 *                           — one upstream request, PAID however this gateway
 *                             requires. Must call assertSpendAllowed() before
 *                             anything that can move USDC.
 *   refresh()               — called before the proxy retries a failed request
 *   close()                 — end of run (refunds, teardown); best effort
 *
 * What an adapter must NOT do: hold or log the wallet key (it receives a viem
 * account, never the key), bypass spend-cap.mjs, or reach anything but its own
 * gateway.
 */
import { x402inference } from './x402inference.mjs'
import { x402gate } from './x402gate.mjs'

/** Every known provider, keyed by id. Add an adapter here to make it selectable. */
export const PROVIDERS = {
  [x402inference.id]: x402inference,
  [x402gate.id]: x402gate,
}

/** The provider used when INFERENCE_PROVIDER and INFERENCE_BASE_URL are both unset. */
export const DEFAULT_PROVIDER_ID = x402inference.id

/**
 * Resolve the provider and base URL for this run.
 *
 * Precedence:
 *   1. INFERENCE_PROVIDER names the adapter (hard failure on an unknown id —
 *      falling back to a different gateway would spend on a route nobody chose).
 *   2. Otherwise the host of INFERENCE_BASE_URL picks it, so a repo that only
 *      ever set the URL keeps working.
 *   3. Otherwise the default provider.
 *
 * INFERENCE_BASE_URL always wins for the URL itself when set — including a
 * self-hosted deployment of a known gateway — and the provider's own
 * defaultBaseUrl fills in when it is not.
 */
export function resolveProvider(env = process.env) {
  const wanted = (env.INFERENCE_PROVIDER || '').trim()
  const baseUrl = (env.INFERENCE_BASE_URL || '').trim().replace(/\/+$/, '')

  let provider
  if (wanted) {
    provider = PROVIDERS[wanted]
    if (!provider) {
      throw new Error(
        `INFERENCE_PROVIDER="${wanted}" is not a known provider. Known: ${Object.keys(PROVIDERS).join(', ')}. ` +
          'Fix the INFERENCE_PROVIDER repo variable (Settings → Secrets and variables → Actions → Variables).'
      )
    }
  } else if (baseUrl) {
    let host = ''
    try {
      host = new URL(baseUrl).host.replace(/^www\./, '')
    } catch {
      throw new Error(`INFERENCE_BASE_URL="${baseUrl}" is not a valid URL.`)
    }
    provider = Object.values(PROVIDERS).find((p) => p.hosts.includes(host))
    if (!provider) {
      throw new Error(
        `INFERENCE_BASE_URL host "${host}" matches no known provider — set INFERENCE_PROVIDER to one of: ` +
          `${Object.keys(PROVIDERS).join(', ')}.`
      )
    }
  } else {
    provider = PROVIDERS[DEFAULT_PROVIDER_ID]
  }

  return { provider, baseUrl: baseUrl || provider.defaultBaseUrl }
}
