# PR Dashboard

A terminal dashboard for GitHub pull requests, built with Bun, Solid, and OpenTUI.

## Usage

Authenticate `gh` first, then run with either CLI flags:

```bash
bun run start -- --repo owner/name --self-login github-login
```

Or environment variables:

```bash
PR_DASHBOARD_REPO=owner/name PR_DASHBOARD_SELF_LOGIN=github-login bun run start
```

`PR_DASHBOARD_REPO` is the GitHub repository to query. `PR_DASHBOARD_SELF_LOGIN` is your GitHub username, used to exclude your own reviews from review status calculations.
