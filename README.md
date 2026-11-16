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

### Desktop notifications

While the dashboard runs, it posts a macOS notification when one of your PRs gets a new review or is merged, or when someone requests your review. Clicking one opens the PR.

Install `brew install terminal-notifier`. Nothing is posted for the first load or for failed refreshes.

#### Icons

Each kind of notification has its own icon: a green check for approvals, a purple merge symbol for merges, a blue question mark for review requests, and an orange warning sign for other reviews and for the summary. macOS always takes a notification's icon from the app that posts it, so `bun run build-notifiers` installs one copy of terminal-notifier.app per kind in `~/Applications/pr-dashboard-notifiers/`, each with its own bundle ID and icon. Until you run it, the dashboard posts through plain terminal-notifier and shows a banner saying so. It needs `brew install librsvg`.

Each copy is a separate app to macOS:

- The first notification from each one asks for permission. Click **Allow**. `bun scripts/test-notifications.ts` posts one test notification per kind, which also triggers those prompts.
- To keep notifications on screen until you dismiss them, set the Alert Style of **PR Approved**, **PR Merged**, **PR Review Requested** and **PR Activity** to **Persistent** in System Settings → Notifications.

`notifier-icons.json` picks each kind's app name, tile colour and icon. An icon is either an ID such as `octicons/git-merge`, `lucide/circle-help`, `tabler/question-mark` or `phosphor/question-fill`, or a path to an SVG in the repo. The build script downloads an ID's SVG (and its set's licence) to `icons/<set>/<name>.svg` the first time, and uses the file already there after that, so you can also drop an SVG there. To swap an icon, edit its entry and run `bun run build-notifiers` again; previews end up in `build/notifiers/`. Rebuilding keeps the bundle IDs, so the permission and Alert Style stay. The bundled icons are [GitHub Octicons](https://github.com/primer/octicons) (MIT).
