/**
 * FROZEN — single source for the git URL of the running repo
 */
export function repoUrl() {
  return (
    process.env.REPO_URL?.trim() ||
    (process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY
      ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}.git`
      : '')
  )
}
