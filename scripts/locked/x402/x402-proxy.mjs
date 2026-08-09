#!/usr/bin/env node
/** Start local OpenAI proxy → x402gate. Writes {port,baseUrl} to PORT_FILE and stays up. */
import { writeFileSync } from 'node:fs'
import { startProxy } from './x402gate.mjs'

const portFile = process.env.PORT_FILE
if (!portFile) {
  console.error('PORT_FILE is required')
  process.exit(1)
}

const { port, baseUrl } = await startProxy(0)
writeFileSync(portFile, JSON.stringify({ port, baseUrl }))
console.error(`x402gate proxy listening on ${baseUrl}`)
await new Promise(() => {})
