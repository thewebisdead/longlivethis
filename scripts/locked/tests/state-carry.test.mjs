/**
 * FROZEN — the durable-state carry.
 *
 * One property is under test above all others: CARRYING STATE CAN NEVER STOP A
 * MIGRATION. Migrations are how the deployment sizes itself to its wallet, so a
 * migration that cannot finish is a deployment that cannot cut its costs. The
 * data being carried belongs to the agent and is expendable; the migration is
 * life support and is not.
 *
 * Runs against fake IO — no ssh, no VPS, no x402 SDK, no network — which is why
 * state-carry.mjs takes its world as an argument (see realIo there).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { carryState, parseSizeMb } from '../vps/state-carry.mjs'

const STATE = '/var/lib/longlive/state'

/** A fake world that records what was asked of it. `plan` scripts the failures. */
function makeIo(plan = {}) {
  const calls = { ssh: [], scp: [], pulls: 0, health: 0, temps: [], logs: [] }
  const io = {
    calls,
    log: (m) => calls.logs.push(String(m)),
    makeTempDir: () => {
      calls.temps.push('made')
      return '/tmp/fake-carry'
    },
    removeTempDir: () => calls.temps.push('removed'),
    writeKeyFile: (dir) => `${dir}/id_ed25519_old`,
    archiveSize: () => 1_000_000,
    ssh: (host, keyPath, cmd, opts = {}) => {
      calls.ssh.push({ host, cmd })
      if (opts.capture) {
        if (plan.sizeThrows) throw new Error('ssh: connection refused')
        return plan.size ?? '4'
      }
      if (plan.extractThrows && cmd.includes('tar -xzf')) throw new Error('tar: write error')
      if (plan.repairThrows && cmd.includes('rm -rf')) throw new Error('ssh: gone')
      return ''
    },
    scp: (host, keyPath, local, remote) => {
      calls.scp.push({ host, remote })
      if (plan.scpThrows) throw new Error('scp: no route to host')
    },
    pullArchive: () => {
      calls.pulls += 1
      if (plan.pullThrows) throw new Error('tar over ssh exited 2')
    },
    assertHealthy: () => {
      calls.health += 1
      if (plan.unhealthy) throw new Error('unhealthy: /')
    },
  }
  return io
}

const run = (io, over = {}) =>
  carryState(
    { oldIp: '1.2.3.4', newHost: '5.6.7.8', newKeyPath: '/tmp/new', oldKey: 'KEY', stateDir: STATE, capMb: 256, ...over },
    io
  )

test('parseSizeMb: absent, unreadable and empty all mean "nothing to carry"', () => {
  assert.equal(parseSizeMb('-1'), null, 'the probe answers -1 when the directory does not exist')
  assert.equal(parseSizeMb(''), null, "Number('') is 0 — an empty answer must not read as an empty directory")
  assert.equal(parseSizeMb('   '), null)
  assert.equal(parseSizeMb('nonsense'), null)
  assert.equal(parseSizeMb(undefined), null)
  assert.equal(parseSizeMb('4'), 4)
  assert.equal(parseSizeMb('  12  '), 12)
  assert.equal(parseSizeMb('login banner\n7'), 7, 'a banner on stdout must not poison the number')
  assert.equal(parseSizeMb('0'), 0, 'an empty directory is still a directory')
})

test('no key for the old box: skipped, nothing touched', () => {
  const io = makeIo()
  assert.equal(run(io, { oldKey: '' }), 'no-key')
  assert.equal(io.calls.ssh.length, 0)
  assert.equal(io.calls.pulls, 0)
})

test('no address for the old box: skipped, nothing touched', () => {
  const io = makeIo()
  assert.equal(run(io, { oldIp: '' }), 'no-old-box')
  assert.equal(io.calls.ssh.length, 0)
})

test('no state directory on the old box: skipped before any transfer', () => {
  const io = makeIo({ size: '-1' })
  assert.equal(run(io), 'nothing')
  assert.equal(io.calls.pulls, 0, 'nothing is pulled')
  assert.equal(io.calls.scp.length, 0, 'the new box is never touched')
})

test('over the cap: skipped loudly, before anything is transferred', () => {
  const io = makeIo({ size: '9000' })
  assert.equal(run(io), 'over-cap')
  assert.equal(io.calls.pulls, 0, 'the cap is enforced on the probe, not mid-copy')
  assert.equal(io.calls.scp.length, 0)
  assert.match(io.calls.logs.join('\n'), /::warning::.*over the 256MB carry cap/)
})

test('the cap is a repo variable, so raising it carries what it previously refused', () => {
  assert.equal(run(makeIo({ size: '500' })), 'over-cap')
  assert.equal(run(makeIo({ size: '500' }), { capMb: 1024 }), 'carried')
})

test('happy path: archive pulled, pushed, extracted, app restarted and checked', () => {
  const io = makeIo()
  assert.equal(run(io), 'carried')
  assert.equal(io.calls.pulls, 1)
  assert.equal(io.calls.scp.length, 1)
  assert.equal(io.calls.health, 1)
  const extract = io.calls.ssh.find((c) => c.cmd.includes('tar -xzf'))
  assert.ok(extract, 'the archive is extracted on the new box')
  assert.ok(extract.cmd.includes('docker compose restart'), 'the app is restarted so it reads the carried state')
})

test('state that makes the app unhealthy is parked, and the migration goes on', () => {
  const io = makeIo({ unhealthy: true })
  assert.equal(run(io), 'rejected')
  const park = io.calls.ssh.find((c) => c.cmd.includes('.rejected-'))
  assert.ok(park, 'the bad state is moved aside rather than deleted')
  assert.ok(park.cmd.includes('mkdir -p'), 'and the app is left with an empty directory')
  assert.ok(park.cmd.includes('docker compose restart'))
})

test('a failure BEFORE the new box is touched leaves it untouched', () => {
  for (const plan of [{ sizeThrows: true }, { pullThrows: true }]) {
    const io = makeIo(plan)
    assert.equal(run(io), 'failed')
    assert.equal(io.calls.scp.length, 0)
    assert.ok(
      !io.calls.ssh.some((c) => c.host === '5.6.7.8'),
      'no command is ever sent to the new box',
    )
  }
})

test('a failure AFTER the new box is touched clears the partial directory', () => {
  const io = makeIo({ extractThrows: true })
  assert.equal(run(io), 'failed-cleaned')
  // The extract command clears the directory too, so the repair is identified by
  // what it does NOT do: no tar.
  const repair = io.calls.ssh.filter(
    (c) => c.host === '5.6.7.8' && c.cmd.includes('rm -rf') && !c.cmd.includes('tar -xzf'),
  )
  assert.equal(repair.length, 1, 'the half-extracted directory is removed')
  assert.ok(repair[0].cmd.includes('docker compose restart'), 'and the app is put back the way the resync left it')
})

test('carryState NEVER throws — not for any failure, or all of them at once', () => {
  const plans = [
    {}, { size: '-1' }, { size: '' }, { size: '9000' },
    { sizeThrows: true }, { pullThrows: true }, { scpThrows: true },
    { extractThrows: true }, { unhealthy: true },
    { extractThrows: true, repairThrows: true },
    { sizeThrows: true, pullThrows: true, scpThrows: true, extractThrows: true, repairThrows: true, unhealthy: true },
  ]
  for (const plan of plans) {
    const io = makeIo(plan)
    assert.doesNotThrow(() => run(io), `plan ${JSON.stringify(plan)} must not throw`)
    assert.ok(io.calls.temps.includes('removed'), 'and the old box private key is always cleaned up')
  }
})

test('the old box key file is removed even when the copy succeeds', () => {
  const io = makeIo()
  run(io)
  assert.deepEqual(io.calls.temps, ['made', 'removed'])
})
