export interface Proposal {
  /** GitHub issue number */
  id: number
  /** Issue title — the single-line summary the feed renders. */
  title: string
  /** Issue body: the full proposal. Used for duplicate detection and by the agent. */
  text: string
  /** Net 👍/👎 reactions on the issue: 👍 +1, 👎 −1, other emojis ignored */
  votes: number
  /** GitHub issue URL — where voting (reacting) happens */
  url: string
  created_at: string
}
