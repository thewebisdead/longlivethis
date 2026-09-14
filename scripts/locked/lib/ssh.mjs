/**
 * FROZEN — SSH helpers
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export function makeKeypair(dir) {
  const keyPath = join(dir, 'id_ed25519')
  execFileSync('ssh-keygen', ['-t', 'ed25519', '-N', '', '-f', keyPath, '-C', 'longlive@provision'], { stdio: 'ignore' })
  return { keyPath, publicKey: readFileSync(`${keyPath}.pub`, 'utf8'), privateKey: readFileSync(keyPath, 'utf8') }
}

export function shq(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`
}

export function scanHostKey(host) {
  const out = execFileSync('ssh-keyscan', ['-t', 'ed25519', '-T', '15', host]).toString()
  const line = out.split('\n').find((l) => l.trim() && !l.startsWith('#'))
  if (!line) throw new Error(`ssh-keyscan produced no host key for ${host}`)
  return line.trim()
}

/**
 * Run a command on the box. Output streams to this job's log by default, which
 * is what almost every caller wants; `capture` returns stdout as a string
 * instead (stderr still streams), for the handful of checks that need to read
 * an answer rather than show it.
 */
export function ssh(host, keyPath, cmd, { timeoutMs = 900_000, capture = false } = {}) {
  const user = process.env.VPS_USER?.trim() || 'root'
  const out = execFileSync(
    'ssh',
    ['-i', keyPath, '-o', 'StrictHostKeyChecking=accept-new', '-o', 'ConnectTimeout=20', `${user}@${host}`, cmd],
    { timeout: timeoutMs, stdio: capture ? ['ignore', 'pipe', 'inherit'] : ['ignore', 'inherit', 'inherit'] }
  )
  return capture ? out.toString().trim() : out
}

/** Write a private key to a 0600 file so ssh will accept it, and return the path. */
export function writeKeyFile(dir, key, name = 'id_ed25519_old') {
  const keyPath = join(dir, name)
  writeFileSync(keyPath, key.endsWith('\n') ? key : key + '\n', { mode: 0o600 })
  return keyPath
}

export function scp(host, keyPath, localPath, remotePath) {
  const user = process.env.VPS_USER?.trim() || 'root'
  execFileSync(
    'scp',
    ['-i', keyPath, '-o', 'StrictHostKeyChecking=accept-new', '-o', 'ConnectTimeout=20', localPath, `${user}@${host}:${remotePath}`],
    { stdio: 'ignore' }
  )
}

export function waitForSsh(host, keyPath, timeoutMs = 240_000) {
  const user = process.env.VPS_USER?.trim() || 'root'
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      execFileSync('ssh', ['-i', keyPath, '-o', 'StrictHostKeyChecking=accept-new', '-o', 'ConnectTimeout=15', `${user}@${host}`, 'echo ok'], {
        stdio: 'ignore',
      })
      return
    } catch {
      execFileSync('sleep', ['8'])
    }
  }
  throw new Error(`SSH never came up on ${host}`)
}
