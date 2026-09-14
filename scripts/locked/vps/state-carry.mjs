/**
 * FROZEN — carrying the deployment's durable state across a migration.
 *
 * Lives in its own file, like retry.mjs, because it is load-bearing and needs to
 * be TESTABLE: migrate-vps.mjs cannot be imported without a wallet and an
 * instance id, and the property this code has to hold — THAT IT CAN NEVER STOP A
 * MIGRATION — is exactly the kind that rots silently. Every path through it is
 * covered by scripts/locked/tests/state-carry.test.mjs against fake IO.
 *
 * Why any of this exists: a migration rebuilds the box from the repo plus
 * app.env, so nothing written on it survives — a docker volume is gone at the
 * next balance-driven resize. STATE_DIR is the one exception, which is what
 * makes a database, uploaded files, or a key the app generated possible at all.
 *
 * Why it must yield: migrations are how the deployment sizes itself to its
 * wallet. One that cannot finish is a deployment that cannot cut its costs,
 * which is a life-support failure. Agent-written data is expendable; life
 * support is not. So every outcome here — no key for the old box, no state dir,
 * an unreadable size, too much data, a failed copy, a half-extracted directory,
 * state that makes the app unhealthy — is a warning and a migration that
 * proceeds. carryState never throws.
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, openSync, closeSync, statSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ssh, scp, shq, writeKeyFile } from '../lib/ssh.mjs'
import { log } from '../lib/log.mjs'

/**
 * The real world. Tests replace this wholesale; nothing here is mocked in place.
 *
 * `assertHealthy` is passed IN rather than imported: it lives in provision-vps.mjs,
 * whose import chain reaches the x402 SDK, and the frozen substrate tests run in
 * CI before those packages are installed. Taking it as an argument is what keeps
 * this module importable with nothing but Node.
 */
export function realIo({ assertHealthy }) {
  return {
    ssh,
    scp,
    log,
    assertHealthy,
    makeTempDir: () => mkdtempSync(join(tmpdir(), 'longlive-state-')),
    removeTempDir: (dir) => rmSync(dir, { recursive: true, force: true }),
    writeKeyFile,
    archiveSize: (path) => statSync(path).size,
    /**
     * Stream `tar -czf -` from the old box straight into a file. Not ssh()
     * with capture: execFileSync buffers stdout in memory with a 1MB default,
     * which the first real database would blow past.
     */
    pullArchive: ({ user, host, keyPath, parent, base, archivePath, timeoutMs }) => {
      const fd = openSync(archivePath, 'w')
      try {
        const r = spawnSync(
          'ssh',
          [
            '-i', keyPath,
            '-o', 'StrictHostKeyChecking=accept-new',
            '-o', 'ConnectTimeout=20',
            `${user}@${host}`,
            `tar -czf - -C ${shq(parent)} ${shq(base)}`,
          ],
          { stdio: ['ignore', fd, 'inherit'], timeout: timeoutMs }
        )
        if (r.status !== 0) throw new Error(`tar over ssh exited ${r.status ?? r.signal}`)
      } finally {
        closeSync(fd)
      }
    },
  }
}

/**
 * Read the size of STATE_DIR on the old box, in MB.
 *
 * Returns null for "nothing to carry", which covers both an absent directory (a
 * box bootstrapped before STATE_DIR existed — the probe answers -1) and a probe
 * that answered something unreadable. The last token is taken rather than the
 * whole string, so a login banner on stdout cannot poison the number, and an
 * EMPTY answer is explicitly not zero: Number('') is 0, which would read a
 * silent probe failure as "an empty state dir" and send the copy on to fail at
 * tar instead of skipping it here.
 */
export function parseSizeMb(out) {
  const text = String(out ?? '').trim()
  if (text === '') return null
  const mb = Number(text.split(/\s+/).pop())
  if (!Number.isFinite(mb) || mb < 0) return null
  return mb
}

/**
 * Copy stateDir from the old box to the new one. Best-effort, never throws.
 * Returns a short verdict string, which is for the log and the tests — the
 * caller has no decision to make either way.
 */
export function carryState(
  { oldIp, newHost, newKeyPath, oldKey, stateDir, capMb, user = 'root' },
  io = realIo()
) {
  // Both of these mean the old box cannot be reached at all. Checked here rather
  // than left to fail at the first ssh, so the log says why instead of showing a
  // connection to "root@undefined".
  if (!oldKey) {
    io.log('::warning:: No VPS_SSH_PRIVATE_KEY — cannot read the old box; the new box starts with empty durable state.')
    return 'no-key'
  }
  if (!oldIp) {
    io.log('::warning:: No address for the old box — the new box starts with empty durable state.')
    return 'no-old-box'
  }

  const parent = stateDir.replace(/\/[^/]+$/, '')
  const base = stateDir.slice(parent.length + 1)
  let dir
  // Set the moment the NEW box's state directory is first touched. Until then a
  // failure leaves that box exactly as the resync left it (built, deployed,
  // health-checked); after it, a failure can leave a half-extracted directory.
  let touchedNewBox = false
  try {
    dir = io.makeTempDir()
    const oldKeyPath = io.writeKeyFile(dir, oldKey)

    const sizeOut = io.ssh(
      oldIp,
      oldKeyPath,
      `if [ -d ${shq(stateDir)} ]; then du -sm ${shq(stateDir)} | cut -f1; else echo -1; fi`,
      { timeoutMs: 120_000, capture: true }
    )
    const usedMb = parseSizeMb(sizeOut)
    if (usedMb === null) {
      io.log(`No durable state to carry (${stateDir} absent, or its size could not be read).`)
      return 'nothing'
    }
    if (usedMb > capMb) {
      io.log(
        `::warning:: Durable state is ${usedMb}MB, over the ${capMb}MB carry cap — MIGRATING WITHOUT IT. ` +
          `The data stays on the old box until it is destroyed. Raise the STATE_CARRY_MAX_MB repo variable ` +
          `before the next migration to carry it, or have the app keep less.`
      )
      return 'over-cap'
    }

    io.log(`Carrying ${usedMb}MB of durable state (${stateDir}, cap ${capMb}MB)…`)
    const archivePath = join(dir, 'state.tgz')
    io.pullArchive({ user, host: oldIp, keyPath: oldKeyPath, parent, base, archivePath, timeoutMs: 600_000 })
    io.log(`Archive is ${(io.archiveSize(archivePath) / 1e6).toFixed(1)}MB compressed.`)

    io.scp(newHost, newKeyPath, archivePath, '/root/longlive-state.tgz')
    touchedNewBox = true
    io.ssh(
      newHost,
      newKeyPath,
      `set -euo pipefail
mkdir -p ${shq(parent)}
rm -rf ${shq(stateDir)}
tar -xzf /root/longlive-state.tgz -C ${shq(parent)}
rm -f /root/longlive-state.tgz
cd /opt/longlive && docker compose restart || docker compose up -d`,
      { timeoutMs: 600_000 }
    )

    // The app has just been handed a state directory it did not create. If that
    // makes it unhealthy, the carried data — not the migration — is what gives:
    // park it and restart empty. Otherwise the post-cutover public health check
    // would roll the whole migration back, and a deployment could be locked out
    // of resizing by its own corrupt database.
    try {
      io.assertHealthy(newHost, newKeyPath)
      io.log('Durable state carried over.')
      return 'carried'
    } catch {
      io.log('::warning:: The new box is unhealthy WITH the carried state — parking it and continuing without.')
      io.ssh(
        newHost,
        newKeyPath,
        `set -euo pipefail
mv ${shq(stateDir)} ${shq(stateDir)}.rejected-$(date +%s) 2>/dev/null || true
mkdir -p ${shq(stateDir)}
cd /opt/longlive && docker compose restart || docker compose up -d`,
        { timeoutMs: 300_000 }
      )
      return 'rejected'
    }
  } catch (err) {
    io.log(`::warning:: Could not carry durable state (${err?.message ?? err}) — migrating without it.`)
    // A copy that died mid-extract can leave a partial directory behind. Left
    // alone it would sail past this function — the box's last health check was
    // BEFORE the carry — and surface only as a failed public check after
    // cutover, i.e. a rollback caused by expendable data. Clear it and restart
    // so the box goes live in the state the resync already proved healthy.
    if (touchedNewBox) {
      try {
        io.ssh(
          newHost,
          newKeyPath,
          `set -euo pipefail
rm -rf ${shq(stateDir)} /root/longlive-state.tgz
mkdir -p ${shq(stateDir)}
cd /opt/longlive && docker compose restart || docker compose up -d`,
          { timeoutMs: 300_000 }
        )
      } catch (cleanupErr) {
        io.log(`::warning:: Could not clear the partial state directory either (${cleanupErr?.message ?? cleanupErr}).`)
      }
      return 'failed-cleaned'
    }
    return 'failed'
  } finally {
    // The old box's private key is in here.
    if (dir) io.removeTempDir(dir)
  }
}
