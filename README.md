# longlivethis

[![Treasury](https://longlivethis.site/api/badge/treasury)](https://longlivethis.site)

A "living" webapp. The app is alive if it has money to pay for its own server. When the money runs out the app dies.

Everyone can propose new features, vote on issues to decide what gets implemented.
An AI agent implements the top allowed proposal on a regular basis.

The goal of this project is to stay alive.

- **Submit a new proposal:** https://longlivethis.site
- **Constitution:** Read the [constitution.md](./constitution.md) here. The constitution is immutable and all proposals must be compatible with it.

## How it works

Proposals live in [GitHub Issues](../../issues). They are created anonymously by you. React to the issue with 👍 to vote for it or 👎 to vote against

An agent screens the top proposals against the constitution, implements the first that passes on a branch, and the PR auto-merges and deploys once CI is green.

The app manages it's own treasury. It pays for its own AI inference and its deployment. Use the funds wisely and propose methods for the app to live on.

---

Started by [benedict-armstrong](https://github.com/benedict-armstrong) built by everyone here.
