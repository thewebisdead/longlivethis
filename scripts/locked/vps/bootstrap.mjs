#!/usr/bin/env node
/**
 * FROZEN — the initial-deploy entry point (bootstrap-vps.yml). Idempotent:
 * no-ops when X402_COMPUTE_INSTANCE_ID already names a live box. Otherwise it
 * sizes a plan to the wallet balance, provisions + bootstraps the box (shared
 * with migrate-vps.mjs via provision-vps.mjs), points DNS at it, persists the
 * deploy-target secrets, and verifies the public URL.
 *
 * Env: WALLET_PRIVATE_KEY, APP_ENV, REPO_URL, VPS_USER, PUBLIC_URL,
 *      CF_API_TOKEN, CF_ZONE_ID, ACME_EMAIL, GH_TOKEN, GITHUB_REPOSITORY,
 *      TARGET_RUNWAY_DAYS, RAM_FLOOR_MB
 */
import { createPublicClient, http, erc20Abi, formatUnits } from 'viem'
import { base } from 'viem/chains'
import { getInstance, orderIp, pickPlan } from '../x402/x402compute.mjs'
import { upsertA, upsertWildcardCname } from './dns.mjs'
import { makeAccount } from '../lib/wallet.mjs'
import { setSecretOrThrow } from '../lib/github-secrets.mjs'
import { healthCheck } from '../lib/health.mjs'
import { repoUrl as deriveRepoUrl } from '../lib/repo.mjs'
import { log, fail } from '../lib/log.mjs'
import { USDC_BASE, HEALTH_PATHS, RAM_FLOOR_MB, TARGET_DAYS } from '../lib/constants.mjs'
import { provisionAndBootstrap, planForBalance } from './provision-vps.mjs'

async function isDeployed(account) {
  const instanceId = process.env.X402_COMPUTE_INSTANCE_ID?.trim()
  if (!instanceId) return false
  try {
    const inst = await getInstance(account, instanceId)
    if (!inst) return false
    const ip = orderIp(inst)
    if (!ip) return false
    log(`Instance ${instanceId} at ${ip} is active — deployment exists.`)
    return true
  } catch (e) {
    log(`::warning:: Instance check failed (${e?.message ?? e}) — will re-provision.`)
    return false
  }
}

/** Wallet USDC, or 0 when unreadable (the caller falls back to the cheapest plan). */
async function readBalance(account) {
  try {
    const pub = createPublicClient({ chain: base, transport: http() })
    const raw = await pub.readContract({ address: USDC_BASE, abi: erc20Abi, functionName: 'balanceOf', args: [account.address] })
    const balance = Number(formatUnits(raw, 6))
    log(`Wallet ${account.address}: $${balance.toFixed(2)} USDC.`)
    return balance
  } catch (e) {
    log(`::warning:: Could not read balance (${e?.message ?? e}) — falling back to cheapest plan.`)
    return 0
  }
}

async function main() {
  const publicUrlFromEnv = (process.env.PUBLIC_URL || '').trim().replace(/\/$/, '')
  const appEnv = process.env.APP_ENV ?? ''
  const vpsUser = process.env.VPS_USER?.trim() || 'root'
  const repoUrl = deriveRepoUrl()

  // A domain on Cloudflare is the only supported deployment: init requires it,
  // and the scaffolded Caddyfile serves exactly that vhost while REQUIRING a
  // Cloudflare origin-pull client cert. So a run without a real PUBLIC_URL
  // could not serve traffic at all — fail here rather than burn a box on it.
  const domain = publicUrlFromEnv.replace(/^https:\/\//, '')
  if (!publicUrlFromEnv.startsWith('https://') || !domain) {
    return fail(`PUBLIC_URL must be https://<your-domain> (got "${publicUrlFromEnv}").`)
  }

  if (!appEnv) return fail('APP_ENV unset.')
  if (!repoUrl) return fail('REPO_URL could not be determined.')

  const account = makeAccount()

  if (await isDeployed(account)) {
    log('Already deployed — nothing to do.')
    return
  }

  const balance = await readBalance(account)
  const { plan } = balance > 0
    ? await planForBalance(balance, { targetDays: TARGET_DAYS, ramFloor: RAM_FLOOR_MB })
    : { plan: await pickPlan(RAM_FLOOR_MB) }

  const acmeEmail = process.env.ACME_EMAIL?.trim() || `admin@${domain}`

  const { host, privateKey, hostKey, instanceId } = await provisionAndBootstrap({
    account,
    plan,
    label: 'longlive',
    appEnv,
    repoUrl,
    domain,
    acmeEmail,
  })

  const publicUrl = `https://${domain}`

  // DNS. upsertA throws if the Cloudflare credentials are missing, which is
  // fatal on purpose: a deploy whose record still points at the old box is not
  // a deploy.
  log(`Setting DNS ${domain} → ${host}`)
  await upsertA(domain, host)
  // Every subdomain resolves to whatever the apex names, so a vhost the agent
  // adds later needs no DNS write. Points at the apex NAME, so migration's
  // A-record cutover carries it — see upsertWildcardCname.
  log(`Setting DNS *.${domain} → ${domain}`)
  await upsertWildcardCname(domain)

  log('Writing deploy-target secrets…')
  setSecretOrThrow('VPS_HOST', host)
  setSecretOrThrow('VPS_USER', vpsUser)
  setSecretOrThrow('VPS_SSH_PRIVATE_KEY', privateKey)
  setSecretOrThrow('VPS_HOST_KEY', hostKey)
  setSecretOrThrow('X402_COMPUTE_INSTANCE_ID', instanceId)
  setSecretOrThrow('PUBLIC_URL', publicUrl)

  // No top-up here: the box carries one prepaid day, and the line above just
  // handed it to renew.yml by naming it in X402_COMPUTE_INSTANCE_ID. The cron
  // runs every 6h and extends below the 18h mark, so it has several chances
  // before this window would lapse.

  log('Verifying the public URL…')
  if (!healthCheck(publicUrl, { paths: HEALTH_PATHS })) {
    return fail(`Public health check failed for ${publicUrl} — check VPS logs above.`)
  }

  // CONTRACT: the init CLI parses this line out of the workflow log to learn the
  // public URL and the box's IP — it cannot read secrets, and the VPS details are
  // deliberately NOT written as repo variables (variables are unencrypted and
  // unmasked in logs, which is no place for an SSH key). Keep the format stable.
  log(`Bootstrap complete — ${publicUrl} served by ${host}.`)
}

main().catch((e) => fail(String(e?.stack ?? e)))
