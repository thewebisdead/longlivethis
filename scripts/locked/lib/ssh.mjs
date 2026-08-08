/**
 * FROZEN — SSH helpers
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
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

export function ssh(host, keyPath, cmd, { timeoutMs = 900_000 } = {}) {
  const user = process.env.VPS_USER?.trim() || 'root'
  return execFileSync(
    'ssh',
    ['-i', keyPath, '-o', 'StrictHostKeyChecking=accept-new', '-o', 'ConnectTimeout=20', `${user}@${host}`, cmd],
    { timeout: timeoutMs, stdio: ['ignore', 'inherit', 'inherit'] }
  )
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
