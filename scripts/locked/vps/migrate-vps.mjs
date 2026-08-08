#!/usr/bin/env node
/**
 * FROZEN — balance-driven server migration. Sizes the VPS to the wallet's USDC
 * balance: when the balance can no longer buy the current box a comfortable
 * runway it moves the app to a cheaper box; when the balance grows it moves to a
 * bigger one. Same domain throughout — only DNS, the deploy target, and the
 * renewed instance change. Runs from migrate.yml (Actions), the only place the
 * spend key + secrets-rotation token live.
 *
 * Safety model:
 *   - The NEW box is fully bootstrapped and health-checked BEFORE anything the
 *     live site depends on changes. Any failure before cutover tears the new box
 *     down and leaves the current deployment untouched.
 *   - Cutover = flip Cloudflare DNS, then rotate the deploy secrets (VPS_HOST,
 *     SSH key, host key), then repoint the renew instance id LAST.
 *   - If the post-cutover public health check fails, it rolls DNS + secrets back
 *     to the old box and destroys the new one.
 *   - Same-domain migration ⇒ app.env / PUBLIC_URL are byte-identical, so there
 *     is no app-config drift to reconcile.
 *
 * Env (from migrate.yml):
 *   WALLET_PRIVATE_KEY          pays for the new box (USDC on Base)
 *   X402_COMPUTE_INSTANCE_ID    the box we are currently on
 *   PUBLIC_URL                  https://<domain> — domain is derived from this
 *   APP_ENV                     receive-only app config, written to the new box
 *   REPO_URL                    git URL (defaults from GITHUB_SERVER_URL/REPOSITORY)
 *   VPS_USER                    ssh user (default root)
 *   CF_API_TOKEN, CF_ZONE_ID    Cloudflare (DNS:Edit on one zone) — required
 *   GH_TOKEN                    short-lived token from the secret-rotator app
 *                               (secrets:write) — rotates the deploy-target secrets
 *   GITHUB_REPOSITORY           owner/repo (for `gh secret set`)
 *   TARGET_RUNWAY_DAYS  (21)    size so the new box has >= this many days of runway
 *   MIN_RUNWAY_DAYS     (10)    only downsize once the current box drops below this
 *   MAX_MIGRATIONS_PER_DAY (1)  runaway guard
 */
import { execFileSync } from 'node:child_process'
import { createPublicClient, http, erc20Abi, formatUnits } from 'viem'
import { base } from 'viem/chains'
import {
  makeAccount,
  getInstance,
  listInstances,
  isEligiblePlan,
  planDaily,
  destroyInstance,
  orderId,
  orderIp,
  orderPlanId,
  orderRam,
  orderActive,
} from '../x402/x402compute.mjs'
import { planForBalance, provisionAndBootstrap, assertHealthyInternally } from './provision-vps.mjs'
import { setSecretOrThrow } from '../lib/github-secrets.mjs'
import { ssh } from '../lib/ssh.mjs'
import { healthCheck } from '../lib/health.mjs'
import { repoUrl as deriveRepoUrl } from '../lib/repo.mjs'
import { log, fail } from '../lib/log.mjs'
import { USDC_BASE, HEALTH_PATHS, RAM_FLOOR_MB, TARGET_DAYS } from '../lib/constants.mjs'
import { upsertA, assertDnsConfigured, getA } from './dns.mjs'

const INSTANCE_ID = process.env.X402_COMPUTE_INSTANCE_ID?.trim()
const PUBLIC_URL = (process.env.PUBLIC_URL || '').trim().replace(/\/$/, '')
const DOMAIN = PUBLIC_URL.replace(/^https?:\/\//, '')
// `let`: validate() realigns the PUBLIC_URL line in place rather than failing on drift.
let APP_ENV = process.env.APP_ENV ?? ''
const VPS_USER = process.env.VPS_USER?.trim() || 'root'
const REPO_URL = deriveRepoUrl()
const REPO = process.env.GITHUB_REPOSITORY?.trim()
const MIN_DAYS = Number(process.env.MIN_RUNWAY_DAYS || '10')
const MAX_PER_DAY = Number(process.env.MAX_MIGRATIONS_PER_DAY || '1')
const ACME_EMAIL = process.env.ACME_EMAIL?.trim() || `admin@${DOMAIN}`
/** Deploy credentials rollback restores from env. Checked up front by validate(). */
const ROLLBACK_SECRETS = ['VPS_SSH_PRIVATE_KEY', 'VPS_HOST_KEY']

/**
 * Value of `key` in the APP_ENV blob (env-file format), or '' if absent/empty.
 */
function appEnvValue(key) {
  const line = APP_ENV.split('\n').find((l) => l.trim().startsWith(`${key}=`))
  return line ? line.slice(line.indexOf('=') + 1).trim() : ''
}

/**
 * Fatal-check the inputs. Returns false when there is simply nothing to migrate
 * (we are not on x402Compute); calls fail() — which exits the process — on a
 * real misconfiguration, so nothing downstream runs against bad inputs.
 */
function validate() {
  if (!INSTANCE_ID) {
    log('No X402_COMPUTE_INSTANCE_ID — not on x402Compute; nothing to migrate.')
    return false
  }
  if (!DOMAIN) fail('PUBLIC_URL unset — cannot determine the domain to migrate.')
  try {
    assertDnsConfigured()
  } catch (e) {
    fail(`${e.message} Migration cuts DNS over unattended and cannot proceed without it.`)
  }
  if (!REPO_URL) fail('REPO_URL could not be determined.')

  const missingAppEnv = ['PUBLIC_URL', 'WALLET_ADDRESS', 'GITHUB_APP_ID', 'GITHUB_REPO'].filter(
    (k) => !appEnvValue(k)
  )
  if (missingAppEnv.length) {
    fail(
      `APP_ENV secret is missing values for ${missingAppEnv.join(', ')} — refusing to deploy a box ` +
        `without app config. Re-run create-longlive to refresh the APP_ENV secret.`
    )
  }
  // PUBLIC_URL drift used to be fatal ("refresh the APP_ENV secret"), which
  // meant one stale line froze every future migration until someone re-ran the
  // CLI. It is repairable in place instead: the PUBLIC_URL *secret* is what DNS,
  // the cert and the health check all use, so it is the authority, and APP_ENV's
  // copy is simply brought into line. Only this one line is ever rewritten —
  // values the workflow cannot derive are still a hard stop above.
  const appEnvUrl = appEnvValue('PUBLIC_URL').replace(/\/$/, '')
  if (appEnvUrl !== PUBLIC_URL) {
    log(`::warning:: APP_ENV's PUBLIC_URL (${appEnvUrl}) disagrees with the PUBLIC_URL secret (${PUBLIC_URL}) — realigning it.`)
    APP_ENV = APP_ENV.replace(/^PUBLIC_URL=.*$/m, `PUBLIC_URL=${PUBLIC_URL}`)
    setSecretOrThrow('APP_ENV', APP_ENV)
  }
  if (!(TARGET_DAYS > MIN_DAYS)) fail(`TARGET_RUNWAY_DAYS (${TARGET_DAYS}) must exceed MIN_RUNWAY_DAYS (${MIN_DAYS}).`)

  // Rollback restores the old box's deploy credentials from this process's env
  // (cutover overwrites the SECRETS, not the env). Checking them here — before
  // anything moves — is what keeps a failed cutover self-healing: without them
  // a rollback could restore DNS but not SSH, which is exactly the half-undone
  // state that needs a human. Missing ⇒ we simply never start.
  const missingRollback = ROLLBACK_SECRETS.filter((k) => !process.env[k]?.trim())
  if (missingRollback.length) {
    fail(
      `${missingRollback.join(' + ')} missing from this run's env — refusing to migrate. Rollback needs ` +
        `the old box's deploy credentials to undo a failed cutover unattended; aborting now leaves the ` +
        `live box untouched, migrating without them could not.`
    )
  }
  return true
}

/** Wallet USDC balance (a read failure throws — main() has no plan without it). */
async function readBalance(account) {
  const pub = createPublicClient({ chain: base, transport: http() })
  const raw = await pub.readContract({ address: USDC_BASE, abi: erc20Abi, functionName: 'balanceOf', args: [account.address] })
  const balance = Number(formatUnits(raw, 6))
  log(`Wallet ${account.address}: $${balance.toFixed(2)} USDC.`)
  return balance
}

/**
 * Size the box the balance can afford and apply the hysteresis rules. Returns
 * the plan to move to, or null when the right move is to stay put — every null
 * path logs its own reason, and renew.yml keeps the current box alive.
 */
async function decideMigration(balance, current) {
  const { plan: target, all: plans } = await planForBalance(balance, { targetDays: TARGET_DAYS, ramFloor: RAM_FLOOR_MB })

  // The provider does not always report the plan we ordered, so fall back to
  // the cheapest eligible plan at the same RAM as a rate proxy.
  const byId = plans.find((p) => p.id === orderPlanId(current))
  const currentRam = byId?.ram ?? orderRam(current)
  const rateProxy =
    byId ??
    (currentRam
      ? plans.filter((p) => isEligiblePlan(p) && p.ram === currentRam).sort((a, b) => a.our_hourly - b.our_hourly)[0]
      : null)
  const currentDaily = planDaily(rateProxy)

  log(`Target for $${balance.toFixed(2)} @ ${TARGET_DAYS}d runway: ${target.id} (${target.ram}MB, $${planDaily(target)}/day).`)

  if (!currentRam || !currentDaily) {
    log('Cannot size the current box (no plan/ram reported) — holding; renew.yml keeps it alive.')
    return null
  }
  const runway = balance / currentDaily
  log(`Current box: ~${currentRam}MB, ~$${currentDaily}/day — runway ${runway.toFixed(1)}d.`)

  if (target.ram === currentRam) {
    log('Already the right size — no migration.')
    return null
  }
  if (target.ram < currentRam) {
    // Downsizing costs a cutover, so only do it once the runway is genuinely short.
    if (runway >= MIN_DAYS) {
      log(`Could downsize to ${target.ram}MB but current runway ${runway.toFixed(1)}d ≥ ${MIN_DAYS}d — holding.`)
      return null
    }
    log(`Runway ${runway.toFixed(1)}d < ${MIN_DAYS}d — downsizing ${currentRam}→${target.ram}MB (${target.id}) to extend life.`)
  } else {
    log(`Balance supports a bigger box — upsizing ${currentRam}→${target.ram}MB (${target.id}).`)
  }
  return target
}

/**
 * Establish a single agreed answer to "which box is live", and return it along
 * with the IP to roll back to.
 *
 * A disagreement between X402_COMPUTE_INSTANCE_ID and the A record means a
 * previous cutover did not finish. That used to be fatal ("fix the secret, then
 * re-run"), which left the site running on an unmanaged box until someone
 * noticed. It is now reconciled in place, because both halves of the
 * disagreement are recoverable without a human:
 *
 *   - the A record names a box we own ⇒ that box is what users are hitting, so
 *     it is the truth; adopt it into the secret,
 *   - the A record names something we do not own (or does not exist) ⇒ the
 *     record is the stale half; repoint it at the recorded box.
 *
 * Returns { current, liveRecord, wasProxied, oldIp } — `current` may be a
 * different instance than the one passed in.
 */
async function reconcileLiveRecord(fleet, current) {
  const liveRecord = await getA(DOMAIN)
  const recordedIp = orderIp(current)

  if (!recordedIp && !liveRecord?.ip) {
    fail(
      `Cannot determine the current box's IP (provider reported none and no A record for ${DOMAIN}) — ` +
        `refusing to cut over, because rollback would be impossible.`
    )
  }

  if (liveRecord?.ip && recordedIp && recordedIp !== liveRecord.ip) {
    const serving = fleet.find((i) => orderActive(i) && orderIp(i) === liveRecord.ip)
    if (serving) {
      const servingId = orderId(serving)
      log(
        `::warning:: ${DOMAIN} points at ${liveRecord.ip} (instance ${servingId}), but ` +
          `X402_COMPUTE_INSTANCE_ID names ${INSTANCE_ID} at ${recordedIp} — a previous cutover did not ` +
          `finish. Adopting the box actually serving traffic.`
      )
      setSecretOrThrow('X402_COMPUTE_INSTANCE_ID', servingId)
      return { current: serving, liveRecord, wasProxied: liveRecord.proxied, oldIp: liveRecord.ip }
    }
    log(
      `::warning:: ${DOMAIN} points at ${liveRecord.ip}, which is not a live box we own. Repointing it ` +
        `at the recorded box ${INSTANCE_ID} (${recordedIp}) before migrating.`
    )
    await upsertA(DOMAIN, recordedIp, { proxied: liveRecord.proxied })
    return { current, liveRecord: { ...liveRecord, ip: recordedIp }, wasProxied: liveRecord.proxied, oldIp: recordedIp }
  }

  // No record at all, but we know the box: create it, so rollback has a target
  // that matches reality rather than silently depending on one existing.
  if (!liveRecord && recordedIp) {
    log(`::warning:: No A record for ${DOMAIN} — creating it against the current box ${recordedIp}.`)
    await upsertA(DOMAIN, recordedIp)
    return { current, liveRecord: { ip: recordedIp, proxied: false }, wasProxied: false, oldIp: recordedIp }
  }

  return { current, liveRecord, wasProxied: liveRecord?.proxied ?? false, oldIp: recordedIp || liveRecord.ip }
}

/**
 * Runaway guard: false when today's migration budget is already spent. Failed
 * attempts count — each one provisioned a box and paid for it, which is exactly
 * what the guard exists to bound.
 */
function withinDailyBudget(fleet) {
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '')
  const todaysMigrations = fleet.filter((i) => (i.label ?? '').startsWith('longlive-mig-') && (i.label ?? '').endsWith(today))
  if (todaysMigrations.length >= MAX_PER_DAY) {
    log(`Already migrated ${todaysMigrations.length}/${MAX_PER_DAY} today — holding (runaway guard).`)
    return false
  }
  return true
}

/**
 * Block until no deploy run is in flight.
 *
 * deploy.yml SSHes to VPS_HOST using the very credentials cutover is about to
 * rotate. A deploy that spans the cutover writes its commit to the box we are
 * retiring, then health-checks the domain — which by then answers from the NEW
 * box — and reports success. The commit is deployed nowhere and nothing says so.
 *
 * Waiting HERE rather than at the top of the run is deliberate: a deploy during
 * provisioning is harmless, because it lands on the box still serving and
 * resyncToMain() picks its commit up moments later. The only interval that has
 * to be quiet is the cutover itself. Deploys take ~30s.
 *
 * Every exit that is not "quiet" throws, which lands in the pre-cutover catch:
 * the new box is destroyed and the live box is untouched. That is the cheap
 * failure (one prepaid day) and it is always preferable to racing a deploy.
 */
async function settleDeploys({ timeoutMs = 300_000, pollMs = 15_000 } = {}) {
  if (!REPO) return
  const deadline = Date.now() + timeoutMs
  for (;;) {
    let busy
    try {
      const out = execFileSync(
        'gh',
        [
          'api',
          `repos/${REPO}/actions/runs?status=in_progress&per_page=100`,
          '--jq',
          '[.workflow_runs[] | select(.name=="deploy")] | length',
        ],
        { encoding: 'utf8' }
      )
      busy = Number(out.trim())
    } catch (e) {
      // Not knowing is not permission to proceed — cutting over blind is the
      // exact failure this function exists to prevent.
      throw new Error(`Could not check for in-flight deploys (${e?.message ?? e}) — refusing to cut over blind.`)
    }
    if (!Number.isFinite(busy)) throw new Error('Unreadable deploy-run count — refusing to cut over blind.')
    if (busy === 0) return
    if (Date.now() >= deadline) {
      throw new Error(
        `A deploy has been in flight for over ${Math.round(timeoutMs / 60_000)}min — aborting before cutover ` +
          `rather than racing it. The next scheduled migration will retry.`
      )
    }
    log(`Waiting for ${busy} in-flight deploy(s) to finish before cutting over…`)
    await new Promise((resolve) => setTimeout(resolve, pollMs))
  }
}

/**
 * Bring the new box up to origin/main before it goes live.
 *
 * The box was cloned when it was provisioned, minutes ago. Anything merged since
 * — including a commit whose own deploy was skipped precisely because this
 * migration was running — is not on it, so without this the cutover silently
 * rolls the site back to whatever HEAD was when provisioning started.
 *
 * Deliberately the same command deploy.yml runs, so the box lands in exactly the
 * state a normal deploy leaves it in, and re-checked afterwards because it has
 * just been given code the earlier health check never saw.
 */
function resyncToMain({ host, keyPath }) {
  log('Re-syncing the new box to origin/main…')
  ssh(
    host,
    keyPath,
    `set -euo pipefail
cd /opt/longlive
git fetch origin main
git reset --hard origin/main
bash scripts/deploy.sh`
  )
  assertHealthyInternally(host, keyPath)
}

/**
 * Point the live site at the new box: DNS first, then the deploy secrets. From
 * the first line of this function the old box is no longer the live target, so
 * every failure after it is a rollback (never a silent abort).
 */
async function cutover({ host, privateKey, hostKey, newId, wasProxied }) {
  log(`Cutover: DNS ${DOMAIN} → ${host} (proxied=${wasProxied}).`)
  await upsertA(DOMAIN, host, { proxied: wasProxied })

  log('Rotating deploy secrets to the new box…')
  setSecretOrThrow('VPS_HOST', host)
  setSecretOrThrow('VPS_USER', VPS_USER)
  setSecretOrThrow('VPS_SSH_PRIVATE_KEY', privateKey)
  setSecretOrThrow('VPS_HOST_KEY', hostKey)
  setSecretOrThrow('X402_COMPUTE_INSTANCE_ID', newId)

  log('Verifying the public URL…')
  return healthCheck(PUBLIC_URL, { paths: HEALTH_PATHS })
}

/**
 * Undo a cutover: DNS and the deploy secrets go back to the old box, then the
 * new box is destroyed. Called for ANY cutover failure — a failed health check
 * or a throw partway through the secret rotation — so there is no half-cut-over
 * state that survives the run.
 *
 * Every step is attempted even if an earlier one failed: a rollback that gives
 * up on the first error is how DNS ends up pointing one way and the deploy
 * secrets the other. The old box's credentials come from this process's env
 * (cutover overwrote the SECRETS, not the env); validate() has already
 * guaranteed they are present, so the only way to lose one here is a GitHub API
 * failure that outlasts setSecretOrThrow's retries.
 *
 * Returns true when the live site is fully back on the old box.
 */
async function rollback({ account, newId, oldId, oldIp, wasProxied }) {
  log('::warning:: Cutover failed — rolling back to the old box.')
  const failures = []
  const step = async (what, fn) => {
    try {
      await fn()
    } catch (e) {
      failures.push(`${what} (${e?.message ?? e})`)
    }
  }

  await step(`DNS ${DOMAIN} → ${oldIp}`, () => upsertA(DOMAIN, oldIp, { proxied: wasProxied }))
  await step('VPS_HOST', () => setSecretOrThrow('VPS_HOST', oldIp))
  await step('X402_COMPUTE_INSTANCE_ID', () => setSecretOrThrow('X402_COMPUTE_INSTANCE_ID', oldId))
  for (const name of ROLLBACK_SECRETS) {
    await step(name, () => setSecretOrThrow(name, process.env[name] ?? ''))
  }

  await destroyInstance(account, newId)

  if (failures.length) {
    console.error(
      `::error::Rollback could not restore: ${failures.join('; ')}. The live site may still be pointed ` +
        `at the retired box ${newId}. The next migrate run reconciles DNS against the recorded instance, ` +
        `but a failed SECRET restore blocks deploys until the next successful cutover.`
    )
    return false
  }
  log(`Rollback complete — ${DOMAIN} is back on ${oldIp} and the new box is destroyed.`)
  return true
}

/**
 * Provision the target box, cut over to it, and roll back if the public health
 * check fails. Nothing the live site depends on changes until `cutover` starts:
 * a failure before that destroys the new box and leaves the old one serving.
 */
async function migrate({ account, target, wasProxied, oldId, oldIp }) {
  const label = `longlive-mig-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}`
  let newId
  let cutoverStarted = false
  try {
    const { host, privateKey, hostKey, instanceId, keyPath } = await provisionAndBootstrap({
      account,
      plan: target,
      label,
      appEnv: APP_ENV,
      repoUrl: REPO_URL,
      domain: DOMAIN,
      acmeEmail: ACME_EMAIL,
    })
    newId = instanceId

    // No top-up here. The box carries one prepaid day and renew.yml (every 6h)
    // takes it from there, which it can only do once the cutover below points
    // X402_COMPUTE_INSTANCE_ID at it. Buying a second day pre-cutover would be
    // paying to extend a box that might be destroyed minutes later by a failed
    // health check — and the decision to migrate at all already established the
    // balance covers this plan for TARGET_RUNWAY_DAYS.

    // Order matters: wait for deploys to drain FIRST, then sync. Syncing first
    // would race a deploy that pushes a commit in between, and this box is about
    // to become the only one.
    await settleDeploys()
    resyncToMain({ host, keyPath })

    // From here the live site is being repointed. A throw inside cutover (a
    // secret write that will not land, a DNS API outage) is treated exactly
    // like a failed health check — both mean "the new box is not properly
    // live", and both are undone by the same rollback rather than left for
    // someone to reconcile by hand.
    cutoverStarted = true
    let ok = false
    try {
      ok = await cutover({ host, privateKey, hostKey, newId, wasProxied })
    } catch (err) {
      log(`::warning:: Cutover errored: ${err?.message ?? err}`)
      ok = false
    }
    if (!ok) {
      const restored = await rollback({ account, newId, oldId, oldIp, wasProxied })
      return fail(
        restored
          ? 'Migration rolled back — old box still serving. Check the new box logs above.'
          : 'Migration rolled back INCOMPLETELY — see the rollback errors above.'
      )
    }

    log(`Cutover complete — ${PUBLIC_URL} served by ${host}.`)
    // Best-effort by design: the migration has already succeeded, and a failed
    // destroy only means the old box coasts to the end of its prepaid window.
    // Nothing renews a box that X402_COMPUTE_INSTANCE_ID no longer names, so it
    // lapses on its own.
    log(`Retiring old box ${oldId}…`)
    if (!(await destroyInstance(account, oldId))) {
      log(`::warning:: Could not destroy the old box ${oldId} — it will lapse when its prepaid window ends.`)
    }
    log('Migration done.')
  } catch (err) {
    // Branch on cutoverStarted ALONE. Gating on `newId` too would misfile the
    // most common failure of all — provisioning itself throwing, before there
    // is an id to hold — as a post-cutover error, reporting a live new box that
    // was never created while the old one is untouched.
    if (!cutoverStarted) {
      if (newId) {
        log(`::warning:: Migration failed pre-cutover — destroying new box ${newId}.`)
        await destroyInstance(account, newId).catch(() => {})
      }
      fail(`Migration aborted (old box untouched): ${err?.message ?? err}`)
    } else {
      // Post-cutover: the site is live on the new box and the secrets already
      // name it. Tearing that down would be the destructive choice, so this
      // only reports.
      fail(`Migration errored after a successful cutover — the new box ${newId} is live and kept. ${err?.message ?? err}`)
    }
  }
}

async function main() {
  if (!validate()) return

  const account = makeAccount()
  const balance = await readBalance(account)
  if (!(balance > 0)) {
    return log(
      'Balance read as $0 — treating as unreadable rather than empty, and holding. ' +
        'A funded wallet reading zero means the balance source disagrees with the payment path; ' +
        'a truly empty one could not pay for a new box regardless. renew.yml keeps the current box alive.'
    )
  }

  const recorded = await getInstance(account, INSTANCE_ID)
  if (!recorded) return fail(`Cannot read current instance ${INSTANCE_ID} — leaving it to renew.yml.`)

  const fleet = await listInstances(account)

  // Reconcile BEFORE sizing: if the recorded instance is not the one serving
  // the domain, the sizing decision has to be made against the box that is.
  const { current, liveRecord, wasProxied, oldIp } = await reconcileLiveRecord(fleet, recorded)
  const oldId = orderId(current)

  const target = await decideMigration(balance, current)
  if (!target) return
  if (!withinDailyBudget(fleet)) return

  await migrate({ account, target, wasProxied, oldId, oldIp })
}

main().catch((e) => fail(String(e?.stack ?? e)))
