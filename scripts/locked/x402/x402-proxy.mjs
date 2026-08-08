#!/usr/bin/env node
/** Start local OpenAI proxy → x402inference. Writes {port,baseUrl,refundUrl} to PORT_FILE and stays up. */
import { writeFileSync } from 'node:fs'
import { startProxy } from './x402inference.mjs'

const portFile = process.env.PORT_FILE
if (!portFile) {
  console.error('PORT_FILE is required')
  process.exit(1)
}

const { port, baseUrl, refundUrl } = await startProxy(0)
writeFileSync(portFile, JSON.stringify({ port, baseUrl, refundUrl }))
console.error(`x402inference proxy listening on ${baseUrl}`)
await new Promise(() => {})
