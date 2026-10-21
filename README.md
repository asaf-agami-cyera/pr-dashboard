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

### Multiple repositories

Track several repositories by separating them with commas, or by repeating `--repo`. Their PRs are mixed into the same sections, and each row is tagged with its repository's label. The label defaults to the repository name; set a shorter one with `=label`:

```bash
PR_DASHBOARD_REPO="octo-org/api,acme/web-app=web" bun run start
bun run start -- --repo octo-org/api --repo acme/web-app=web --self-login github-login
```
