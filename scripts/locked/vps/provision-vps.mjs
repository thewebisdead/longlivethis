/**
 * FROZEN — the shared "bring a fresh VPS up" library: provision an x402Compute
 * box, bootstrap it, health-check it, pre-seed a TLS cert. Used by bootstrap.mjs
 * (initial deploy) and by migrate-vps.mjs (balance-driven migration) — one
 * shared function so a provisioned box and a migrated box are identical.
 *
 * Exports:
 *   provisionAndBootstrap()    provision a VPS + bootstrap + health-check + cert
 *   planForBalance()           pick the best plan affordable at a given runway
 *
 * No CLI: the bootstrap workflow's entry point is ./bootstrap.mjs.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fetchPlans, isEligiblePlan, planDaily, provisionInstance, waitForInstanceIp } from '../x402/x402compute.mjs'
import { canReadZone } from './dns.mjs'
import { makeKeypair, shq, scanHostKey, ssh, scp, waitForSsh } from '../lib/ssh.mjs'
import { log } from '../lib/log.mjs'
import { APP_PORT, HEALTH_PATHS, PREPAID_HOURS, RAM_FLOOR_MB, TARGET_DAYS } from '../lib/constants.mjs'

const LE_DIR = 'acme-v02.api.letsencrypt.org-directory'

// ---- plan selection ----

/**
 * Biggest box the balance can run for at least `days`, without wasting money:
 * maximize RAM among plans affordable at that runway, then take the CHEAPEST
 * plan at that RAM. Falls back to the cheapest eligible plan if nothing is
 * affordable (survival).
 */
export async function planForBalance(balance, { targetDays = TARGET_DAYS, ramFloor = RAM_FLOOR_MB } = {}) {
  const plans = await fetchPlans()
  const eligible = plans.filter((p) => p.ram >= ramFloor && isEligiblePlan(p))
  if (!eligible.length) throw new Error('no eligible plans')
  const affordable = eligible.filter((p) => planDaily(p) * targetDays <= balance)
  const pool = affordable.length ? affordable : [[...eligible].sort((a, b) => a.our_hourly - b.our_hourly)[0]]
  const maxRam = Math.max(...pool.map((p) => p.ram))
  const plan = pool.filter((p) => p.ram === maxRam).sort((a, b) => a.our_hourly - b.our_hourly)[0]
  return { plan, all: plans }
}

// ---- cert helpers ----

function issueCert(dir, domain, acmeEmail) {
  const legoPath = join(dir, 'lego')
  execFileSync(
    'lego',
    ['--accept-tos', '--email', acmeEmail, '--dns', 'cloudflare', '--domains', domain, '--path', legoPath, 'run'],
    {
      env: { ...process.env, CLOUDFLARE_DNS_API_TOKEN: process.env.CF_API_TOKEN },
      stdio: ['ignore', 'inherit', 'inherit'],
    }
  )
  return {
    certPem: join(legoPath, 'certificates', `${domain}.crt`),
    keyPem: join(legoPath, 'certificates', `${domain}.key`),
  }
}

function seedCaddyCertScript(domain) {
  return [
    'set -e',
    'CADDY_HOME=$(getent passwd caddy | cut -d: -f6)',
    '[ -n "$CADDY_HOME" ] || CADDY_HOME=/var/lib/caddy',
    `STORE=$(find "$CADDY_HOME/.local/share/caddy" /root/.local/share/caddy -type d -path '*/certificates/*' -name '${LE_DIR}' 2>/dev/null | head -1)`,
    `[ -z "$STORE" ] && STORE="$CADDY_HOME/.local/share/caddy/certificates/${LE_DIR}"`,
    `DIR="$STORE/${domain}"`,
    'mkdir -p "$DIR"',
    `cp /root/seed.crt "$DIR/${domain}.crt"`,
    `cp /root/seed.key "$DIR/${domain}.key"`,
    `printf '{"sans":["${domain}"]}' > "$DIR/${domain}.json"`,
    `chmod 600 "$DIR/${domain}.key"`,
    'rm -f /root/seed.crt /root/seed.key',
    'STORAGE_ROOT=$(cd "$STORE/../.." && pwd)',
    'chown -R caddy:caddy "$STORAGE_ROOT" 2>/dev/null || true',
    'systemctl restart caddy || systemctl reload caddy || true',
  ].join('\n')
}

// ---- main provision function ----

/** Upload app.env + the bootstrap script and run it (docker + caddy + deploy). */
function bootstrapBox({ dir, host, keyPath, appEnv, repoUrl }) {
  waitForSsh(host, keyPath)
  ssh(host, keyPath, 'mkdir -p /etc/longlive /opt/longlive')
  const appEnvPath = join(dir, 'app.env')
  writeFileSync(appEnvPath, appEnv.endsWith('\n') ? appEnv : appEnv + '\n', { mode: 0o600 })
  scp(host, keyPath, appEnvPath, '/etc/longlive/app.env')
  ssh(host, keyPath, 'chmod 600 /etc/longlive/app.env')
  scp(host, keyPath, 'scripts/locked/vps/bootstrap-vps.sh', '/root/bootstrap-vps.sh')

  log('Bootstrapping (docker + caddy + clone + deploy)…')
  ssh(host, keyPath, `bash /root/bootstrap-vps.sh ${shq(repoUrl)}`)
}

/** Health-check the app from ON the box — no DNS or cert involved yet. */
export function assertHealthyInternally(host, keyPath) {
  for (const path of HEALTH_PATHS) {
    ssh(host, keyPath, `for i in $(seq 1 24); do curl -sf -o /dev/null http://127.0.0.1:${APP_PORT}${path} && exit 0; sleep 5; done; echo "unhealthy: ${path}"; exit 1`)
  }
  log('New box healthy internally.')
}

/**
 * Issue a cert over DNS-01 and drop it into Caddy's store, so the box already
 * serves TLS the moment DNS points at it. Best-effort by design: on failure
 * Caddy self-issues over HTTP-01 after the flip, which merely costs a few
 * seconds of downtime rather than the migration.
 */
async function preSeedCert({ dir, host, keyPath, domain, acmeEmail }) {
  try {
    const zoneCheck = await canReadZone()
    if (!zoneCheck.ok) {
      throw new Error(
        `the Cloudflare token cannot read zone ${process.env.CF_ZONE_ID} (${zoneCheck.error}). ` +
          `lego needs Zone:Read + DNS:Edit — Cloudflare's "Edit zone DNS" template includes both.`
      )
    }
    log('Issuing TLS cert via DNS-01 (lego + Cloudflare)…')
    const { certPem, keyPem } = issueCert(dir, domain, acmeEmail)
    scp(host, keyPath, certPem, '/root/seed.crt')
    scp(host, keyPath, keyPem, '/root/seed.key')
    ssh(host, keyPath, seedCaddyCertScript(domain))
    log('Cert pre-seeded into the box.')
  } catch (e) {
    log(`::warning:: cert pre-seed failed (${e?.message ?? e}) — Caddy will self-issue via HTTP-01 post-DNS-flip.`)
  }
}

/**
 * Provision a fresh VPS, bootstrap it, health-check it internally, and
 * pre-seed a TLS cert. Does NOT touch DNS or GitHub secrets — the caller
 * is responsible for directing traffic and persisting credentials.
 *
 * Returns { host, privateKey, hostKey, instanceId, keyPath }. The temp dir
 * holding the SSH key is deliberately NOT removed: the caller may still need
 * `keyPath` for post-provision work on the box (migrate-vps.mjs does). It lives
 * in the OS temp dir, which the runner wipes after the job.
 */
export async function provisionAndBootstrap({
  account,
  plan,
  label,
  appEnv,
  repoUrl,
  domain,
  acmeEmail,
}) {
  const dir = mkdtempSync(join(tmpdir(), 'longlive-prov-'))
  const { keyPath, publicKey, privateKey } = makeKeypair(dir)

  log(`Provisioning ${plan.id} (${plan.ram}MB, $${planDaily(plan)}/day)…`)
  // One prepaid day — the provider's minimum, and all a box ever gets bought at
  // once. A box that fails to bootstrap costs exactly this and nothing more;
  // renew-vps.mjs's cron takes over the moment the box is named in
  // X402_COMPUTE_INSTANCE_ID, and never before.
  const box = await provisionInstance(account, {
    plan,
    label,
    sshPublicKey: publicKey,
    prepaidHours: PREPAID_HOURS,
  })
  const instanceId = box.id
  const host = box.host || (await waitForInstanceIp(account, instanceId))
  log(`Box ${instanceId} at ${host} (~$${box.costUsdcApprox} for ${PREPAID_HOURS}h).`)

  bootstrapBox({ dir, host, keyPath, appEnv, repoUrl })
  assertHealthyInternally(host, keyPath)
  const hostKey = scanHostKey(host)

  // Every deployment is a Cloudflare-fronted domain, so the zone for DNS-01 is
  // always ours to drive. Best-effort — see preSeedCert.
  await preSeedCert({ dir, host, keyPath, domain, acmeEmail })

  return { host, privateKey, hostKey, instanceId, keyPath }
}
