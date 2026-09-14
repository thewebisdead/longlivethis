// Shared read-through cache for the app's two external reads (GitHub Issues,
// the USDC balance on Base).
//
// Both live behind rate limits that a per-request fetch would walk straight
// into, and both are read by the server-rendered homepage, so a slow or failing
// upstream shows up as a slow or blank page. The behaviour they need is the
// same three things every time:
//
//   TTL          — serve from memory until the entry is `ttlMs` old.
//   coalescing   — concurrent misses share ONE upstream call, not one each.
//   stale-on-error (opt-in) — when a refresh fails but a previous value exists,
//                  serve that value rather than propagating the error. Only
//                  fail when there is nothing at all to serve.
//
// State lives on `globalThis` because Next bundles a module separately for the
// page and for each API route: module-level state is NOT shared between them,
// so a proposal POSTed through the route handler would otherwise be invisible
// to the page render. There is one Node process, so one global entry per name
// is genuinely shared.

interface Entry<T> {
  value: T
  ts: number
}

interface Store<T> {
  entries: Map<string, Entry<T>>
  inflight: Map<string, Promise<T>>
}

export interface CacheOptions {
  /**
   * Serve the last good value when a refresh throws. Off by default: a caller
   * that would rather surface the error than a stale number must opt in.
   */
  serveStaleOnError?: boolean
}

export interface Cache<T> {
  /** Read through the cache, loading on miss. `key` also scopes the entry. */
  get(key?: string): Promise<T>
  /** Overwrite an entry and reset its TTL, without an upstream call. */
  set(value: T, key?: string): void
  /** Current cached value, or undefined — never loads. */
  peek(key?: string): T | undefined
}

/**
 * Define a named cache over `loader`. The name must be unique per deployment;
 * it is the `globalThis` key the entries hang off, so two caches sharing a name
 * would read each other's values.
 */
export function defineCache<T>(
  name: string,
  ttlMs: number,
  loader: (key: string) => Promise<T>,
  { serveStaleOnError = false }: CacheOptions = {}
): Cache<T> {
  const g = globalThis as Record<string, unknown>
  const store = (g[`__longliveCache_${name}`] ??= {
    entries: new Map<string, Entry<T>>(),
    inflight: new Map<string, Promise<T>>(),
  }) as Store<T>

  const fresh = (e: Entry<T> | undefined): e is Entry<T> => !!e && Date.now() - e.ts < ttlMs

  return {
    peek: (key = '') => store.entries.get(key)?.value,

    set(value, key = '') {
      store.entries.set(key, { value, ts: Date.now() })
    },

    get(key = '') {
      const hit = store.entries.get(key)
      if (fresh(hit)) return Promise.resolve(hit.value)

      // Second and later callers during a miss get the SAME promise, so a burst
      // of traffic costs one upstream call.
      const running = store.inflight.get(key)
      if (running) return running

      const load = loader(key)
        .then((value) => {
          store.entries.set(key, { value, ts: Date.now() })
          return value
        })
        .catch((err) => {
          const stale = store.entries.get(key)
          if (serveStaleOnError && stale) {
            // Push the timestamp forward so the next request serves this value
            // immediately instead of hammering a upstream that is already down;
            // the retry happens after another full TTL.
            console.error(`cache "${name}" refresh failed — serving stale:`, err)
            stale.ts = Date.now()
            return stale.value
          }
          throw err
        })
        .finally(() => {
          store.inflight.delete(key)
        })

      store.inflight.set(key, load)
      return load
    },
  }
}
