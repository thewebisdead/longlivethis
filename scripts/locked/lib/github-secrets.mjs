/**
 * FROZEN — `gh secret set` wrappers
 */
import { execFileSync } from 'node:child_process'

const log = (m) => console.log(`${new Date().toISOString()} ${m}`)

export function setSecret(name, value, repo = process.env.GITHUB_REPOSITORY?.trim()) {
  if (!repo) throw new Error('GITHUB_REPOSITORY unset — cannot set secrets')
  if (!value) {
    console.error(`::warning::Refusing to set ${name} to an empty value — leaving the existing secret alone.`)
    return false
  }
  execFileSync('gh', ['secret', 'set', name, '--repo', repo], { input: value, stdio: ['pipe', 'ignore', 'inherit'] })
  return true
}

export function setSecretOrThrow(name, value, attempts = 3) {
  for (let i = 1; ; i++) {
    try {
      if (!setSecret(name, value)) throw new Error(`empty value for ${name}`)
      return
    } catch (e) {
      if (i >= attempts) throw new Error(`could not set ${name} after ${attempts} attempts: ${e?.message ?? e}`)
      log(`::warning::setSecret ${name} failed (attempt ${i}/${attempts}) — retrying.`)
      execFileSync('sleep', ['5'])
    }
  }
}
