/**
 * Hacker News API helpers.
 *
 * Uses the official Firebase-based API at
 * https://hacker-news.firebaseio.com/v0/
 */

const HN_ITEM_URL = 'https://hacker-news.firebaseio.com/v0/item'

/** Return shape of a HN story/item. Fields beyond these are omitted. */
interface HnItem {
  id: number
  title?: string
  score?: number
  descendants?: number
  url?: string
  type?: string
  by?: string
}

/**
 * Fetch a single item from the HN API.
 *
 * Returns `null` when the item does not exist or the request fails (network,
 * timeout, malformed JSON). This is deliberately silent — the HN API is a
 * best-effort data source and the app should never crash over it.
 */
export async function fetchHnItem(id: number): Promise<HnItem | null> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 5000)

  try {
    const res = await fetch(`${HN_ITEM_URL}/${id}.json`, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    })
    if (!res.ok) return null
    const data: unknown = await res.json()
    if (!data || typeof data !== 'object') return null
    return data as HnItem
  } catch {
    return null
  } finally {
    clearTimeout(timeout)
  }
}
