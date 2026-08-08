/**
 * FROZEN — timestamped logging + the Actions-annotated fatal exit used by every
 * script under scripts/locked/vps/. `fail` never returns: callers may write
 * `return fail(...)` to make the abort obvious at the call site.
 */
export const log = (m) => console.log(`${new Date().toISOString()} ${m}`)

export const fail = (m) => {
  console.error(`::error::${m}`)
  process.exit(1)
}
