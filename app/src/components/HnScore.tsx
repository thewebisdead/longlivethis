import { fetchHnItem } from '@/lib/hn'

/**
 * Displays the score (upvotes) of the project's Show HN post on Hacker News.
 *
 * Renders server-side, fetching the data from the HN Firebase API. Silently
 * shows nothing when the score cannot be read (network error, item gone, etc.)
 */
export default async function HnScore() {
  const item = await fetchHnItem(49_707_802)
  const score = item?.score ?? null

  if (score === null) return null

  return (
    <a
      href="https://news.ycombinator.com/item?id=49707802"
      target="_blank"
      rel="noopener"
      className="inline-flex items-center gap-1.5 text-muted underline underline-offset-2 hover:text-fg text-sm"
    >
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="w-4 h-4"
        aria-hidden="true"
      >
        <polyline points="6 9 12 15 18 9" />
      </svg>
      <span>
        HN · <strong>{score}</strong>
      </span>
    </a>
  )
}
