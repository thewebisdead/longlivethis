#!/usr/bin/env node
/**
 * FROZEN — start the local OpenAI-compatible payment proxy and stay up.
 *
 * Writes {port, baseUrl, provider, pid} to PORT_FILE so agent.yml can point the
 * agent steps at it (and stop it again), then blocks until a signal arrives.
 *
 * Shutting down cleanly matters: a channel-based provider (x402inference)
 * reclaims the unspent deposit in close(), so a proxy that is only ever SIGKILLed
 * strands that balance in the escrow channel. SIGTERM/SIGINT therefore run the
 * provider's settle-up before exiting — bounded, so a hanging refund cannot hold
 * the job open.
 */
import { writeFileSync } from 'node:fs'
import { startProxy } from './inference-proxy.mjs'

const portFile = process.env.PORT_FILE
if (!portFile) {
  console.error('PORT_FILE is required')
  process.exit(1)
}

/** Seconds the settle-up gets before the process exits anyway. */
const SHUTDOWN_TIMEOUT_MS = Number(process.env.PROXY_SHUTDOWN_TIMEOUT_MS || '60000')

const proxy = await startProxy(0)
writeFileSync(
  portFile,
  JSON.stringify({ port: proxy.port, baseUrl: proxy.baseUrl, provider: proxy.provider, pid: process.pid })
)
console.error(`[proxy] listening on ${proxy.baseUrl} (provider=${proxy.provider})`)

let closing = false
async function shutdown(signal) {
  if (closing) return
  closing = true
  console.error(`[proxy] ${signal} — closing (settling up with ${proxy.provider})…`)
  const timer = setTimeout(() => {
    console.error(`[proxy] shutdown timed out after ${SHUTDOWN_TIMEOUT_MS}ms — exiting anyway`)
    process.exit(0)
  }, SHUTDOWN_TIMEOUT_MS)
  timer.unref()
  try {
    await proxy.close()
  } catch (e) {
    console.error(`[proxy] shutdown error: ${e?.message || e}`)
  }
  process.exit(0)
}

process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))

await new Promise(() => {})
