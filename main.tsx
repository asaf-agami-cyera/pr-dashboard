import { createCliRenderer, TextAttributes } from "@opentui/core"
import { render, useKeyboard, useRenderer } from "@opentui/solid"
import { createSignal, createMemo, For, Show, onCleanup, batch } from "solid-js"

// ─── Theme ────────────────────────────────────────────────────────
const theme = {
  bg: "#0d1117",
  surface: "#161b22",
  border: "#30363d",
  accent: "#7c3aed",
  accentDim: "#5b21b6",
  text: "#e6edf3",
  dimmed: "#8b949e",
  success: "#3fb950",
  warning: "#d29922",
  error: "#f85149",
  info: "#58a6ff",
  draft: "#8b949e",
  reviewed: "#d29922",
  approved: "#3fb950",
  changesRequested: "#f85149",
  waiting: "#58a6ff",
  reviewNeeded: "#f0883e",
  reviewedByMe: "#39d353",
}

// ─── Types ────────────────────────────────────────────────────────
type PRStatus =
  | "draft"
  | "waiting_for_review"
  | "reviewed"
  | "changes_requested"
  | "approved"

type CIStatus = "passing" | "failing" | "pending" | "unknown"

interface ReviewInfo {
  login: string
  state: string
  submittedAt: string
}

interface PR {
  number: number
  title: string
  url: string
  headRefName: string
  createdAt: string
  updatedAt: string
  status: PRStatus
  ciStatus: CIStatus
  humanReviews: ReviewInfo[]
}

interface ReviewerPR {
  number: number
  title: string
  url: string
  headRefName: string
  createdAt: string
  updatedAt: string
  author: string
  isDraft: boolean
  ciStatus: CIStatus
  myReviewState?: string // "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" etc. — only for "reviewed by me"
}

interface GHReview {
  author: { login: string }
  authorAssociation: string
  state: string
  submittedAt: string
}

interface GHCheckRun {
  __typename: string
  status: string
  conclusion: string
  state?: string
}

interface GHReviewRequest {
  __typename: string
  login?: string
}

interface GHPullRequest {
  number: number
  title: string
  url: string
  headRefName: string
  isDraft: boolean
  reviewDecision: string
  reviewRequests: GHReviewRequest[]
  reviews: GHReview[]
  statusCheckRollup: GHCheckRun[]
  createdAt: string
  updatedAt: string
  author?: { login: string }
}

// ─── Data ─────────────────────────────────────────────────────────
const REFRESH_INTERVAL_MS = 5 * 60 * 1000

interface Config {
  repo: string
  selfLogin: string
}

function readArgValue(name: string): string | undefined {
  const prefix = `${name}=`
  for (let i = 2; i < Bun.argv.length; i++) {
    const arg = Bun.argv.at(i)
    if (!arg) continue
    if (arg === name) return Bun.argv.at(i + 1)
    if (arg.startsWith(prefix)) return arg.slice(prefix.length)
  }
  return undefined
}

function readConfig(): Config {
  const repo = readArgValue("--repo") ?? Bun.env.PR_DASHBOARD_REPO
  const selfLogin = readArgValue("--self-login") ?? Bun.env.PR_DASHBOARD_SELF_LOGIN

  if (!repo || !selfLogin) {
    throw new Error(
      "Missing config. Set PR_DASHBOARD_REPO and PR_DASHBOARD_SELF_LOGIN, or pass --repo owner/name --self-login username.",
    )
  }

  return { repo, selfLogin }
}

const config = readConfig()
const REPO = config.repo
const SELF_LOGIN = config.selfLogin

function classifyPR(pr: GHPullRequest): PRStatus {
  if (pr.isDraft) return "draft"
  if (pr.reviewDecision === "APPROVED") return "approved"
  if (pr.reviewDecision === "CHANGES_REQUESTED") return "changes_requested"
  if (pr.reviewRequests.length > 0) return "waiting_for_review"

  const humanReviews = pr.reviews.filter(
    (r) => r.authorAssociation !== "NONE" && r.author.login !== SELF_LOGIN,
  )
  if (humanReviews.length > 0) return "reviewed"

  return "waiting_for_review"
}

function deriveCIStatus(checks: GHCheckRun[]): CIStatus {
  if (checks.length === 0) return "unknown"

  const hasFailure = checks.some(
    (c) =>
      c.conclusion === "FAILURE" ||
      c.conclusion === "ERROR" ||
      c.conclusion === "TIMED_OUT" ||
      (c.__typename === "StatusContext" && c.state === "FAILURE"),
  )
  if (hasFailure) return "failing"

  const hasPending = checks.some(
    (c) =>
      c.status === "IN_PROGRESS" ||
      c.status === "QUEUED" ||
      c.status === "PENDING" ||
      (c.__typename === "StatusContext" && c.state === "PENDING"),
  )
  if (hasPending) return "pending"

  return "passing"
}

function getHumanReviews(pr: GHPullRequest): ReviewInfo[] {
  const seen = new Set<string>()
  const result: ReviewInfo[] = []

  // Walk reviews in reverse to get the latest per person
  for (let i = pr.reviews.length - 1; i >= 0; i--) {
    const r = pr.reviews[i]
    if (r.authorAssociation === "NONE") continue
    if (r.author.login === SELF_LOGIN) continue
    if (seen.has(r.author.login)) continue
    seen.add(r.author.login)
    result.push({
      login: r.author.login,
      state: r.state,
      submittedAt: r.submittedAt,
    })
  }
  return result
}

function parsePRs(raw: GHPullRequest[]): PR[] {
  return raw.map((pr) => ({
    number: pr.number,
    title: pr.title,
    url: pr.url,
    headRefName: pr.headRefName,
    createdAt: pr.createdAt,
    updatedAt: pr.updatedAt,
    status: classifyPR(pr),
    ciStatus: deriveCIStatus(pr.statusCheckRollup),
    humanReviews: getHumanReviews(pr),
  }))
}

async function fetchPRData(): Promise<PR[]> {
  const fields = [
    "number",
    "title",
    "url",
    "headRefName",
    "isDraft",
    "reviewDecision",
    "reviewRequests",
    "reviews",
    "statusCheckRollup",
    "createdAt",
    "updatedAt",
  ].join(",")

  const proc = Bun.spawn(
    [
      "gh",
      "pr",
      "list",
      "--repo",
      REPO,
      "--author",
      "@me",
      "--state",
      "open",
      "--json",
      fields,
      "--limit",
      "50",
    ],
    { stdout: "pipe", stderr: "pipe" },
  )

  const stdout = await new Response(proc.stdout).text()
  const stderr = await new Response(proc.stderr).text()
  const exitCode = await proc.exited

  if (exitCode !== 0) {
    throw new Error(`gh failed (exit ${exitCode}): ${stderr}`)
  }

  const raw: GHPullRequest[] = JSON.parse(stdout)
  return parsePRs(raw)
}

const REVIEWER_FIELDS = [
  "number",
  "title",
  "url",
  "headRefName",
  "isDraft",
  "reviews",
  "statusCheckRollup",
  "createdAt",
  "updatedAt",
  "author",
].join(",")

function parseReviewerPRs(
  raw: GHPullRequest[],
  opts: { includeMyReviewState: boolean },
): ReviewerPR[] {
  return raw.map((pr) => {
    let myReviewState: string | undefined
    if (opts.includeMyReviewState) {
      // Walk reviews in reverse to find my latest review
      for (let i = pr.reviews.length - 1; i >= 0; i--) {
        if (pr.reviews[i].author.login === SELF_LOGIN) {
          myReviewState = pr.reviews[i].state
          break
        }
      }
    }
    return {
      number: pr.number,
      title: pr.title,
      url: pr.url,
      headRefName: pr.headRefName,
      createdAt: pr.createdAt,
      updatedAt: pr.updatedAt,
      author: pr.author?.login ?? "unknown",
      isDraft: pr.isDraft,
      ciStatus: deriveCIStatus(pr.statusCheckRollup),
      myReviewState,
    }
  })
}

async function fetchReviewRequestedPRs(): Promise<ReviewerPR[]> {
  const proc = Bun.spawn(
    [
      "gh", "pr", "list",
      "--repo", REPO,
      "--search", "review-requested:@me",
      "--state", "open",
      "--json", REVIEWER_FIELDS,
      "--limit", "50",
    ],
    { stdout: "pipe", stderr: "pipe" },
  )

  const stdout = await new Response(proc.stdout).text()
  const stderr = await new Response(proc.stderr).text()
  const exitCode = await proc.exited

  if (exitCode !== 0) {
    throw new Error(`gh failed (exit ${exitCode}): ${stderr}`)
  }

  const raw: GHPullRequest[] = JSON.parse(stdout)
  return parseReviewerPRs(raw, { includeMyReviewState: false })
}

async function fetchReviewedByMePRs(): Promise<ReviewerPR[]> {
  const proc = Bun.spawn(
    [
      "gh", "pr", "list",
      "--repo", REPO,
      "--search", "reviewed-by:@me",
      "--state", "open",
      "--json", REVIEWER_FIELDS,
      "--limit", "50",
    ],
    { stdout: "pipe", stderr: "pipe" },
  )

  const stdout = await new Response(proc.stdout).text()
  const stderr = await new Response(proc.stderr).text()
  const exitCode = await proc.exited

  if (exitCode !== 0) {
    throw new Error(`gh failed (exit ${exitCode}): ${stderr}`)
  }

  const raw: GHPullRequest[] = JSON.parse(stdout)
  return parseReviewerPRs(raw, { includeMyReviewState: true })
}

// ─── Helpers ──────────────────────────────────────────────────────
function relativeTime(iso: string): string {
  const now = Date.now()
  const then = new Date(iso).getTime()
  const diffMs = now - then
  const mins = Math.floor(diffMs / 60_000)
  if (mins < 1) return "just now"
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

const statusLabels: Record<PRStatus, string> = {
  draft: "Draft",
  waiting_for_review: "Waiting for Review",
  reviewed: "Reviewed",
  changes_requested: "Changes Requested",
  approved: "Approved",
}

const statusColors: Record<PRStatus, string> = {
  draft: theme.draft,
  waiting_for_review: theme.waiting,
  reviewed: theme.reviewed,
  changes_requested: theme.changesRequested,
  approved: theme.approved,
}

const statusOrder: PRStatus[] = [
  "changes_requested",
  "reviewed",
  "waiting_for_review",
  "approved",
  "draft",
]

function ciIcon(ci: CIStatus): string {
  switch (ci) {
    case "passing":
      return "●"
    case "failing":
      return "✖"
    case "pending":
      return "◔"
    case "unknown":
      return "○"
  }
}

function ciColor(ci: CIStatus): string {
  switch (ci) {
    case "passing":
      return theme.success
    case "failing":
      return theme.error
    case "pending":
      return theme.warning
    case "unknown":
      return theme.dimmed
  }
}

function reviewStateLabel(state: string): string {
  switch (state) {
    case "APPROVED":
      return "approved"
    case "CHANGES_REQUESTED":
      return "changes requested"
    case "COMMENTED":
      return "commented"
    case "DISMISSED":
      return "dismissed"
    default:
      return state.toLowerCase()
  }
}

// ─── Components ───────────────────────────────────────────────────
function Header(props: {
  prCount: number
  reviewCount: number
  reviewedByMeCount: number
  lastRefresh: string
  loading: boolean
}) {
  return (
    <box
      flexDirection="row"
      justifyContent="space-between"
      paddingX={1}
      height={1}
      backgroundColor={theme.surface}
    >
      <box flexDirection="row" gap={1}>
        <text fg={theme.accent} attributes={TextAttributes.BOLD}>
          PR Dashboard
        </text>
        <text fg={theme.dimmed}>{REPO}</text>
      </box>
      <box flexDirection="row" gap={2}>
        <Show when={props.reviewCount > 0}>
          <box flexDirection="row" gap={1}>
            <text fg={theme.reviewNeeded} attributes={TextAttributes.BOLD}>
              {String(props.reviewCount)}
            </text>
            <text fg={theme.dimmed}>to review</text>
          </box>
        </Show>
        <Show when={props.reviewedByMeCount > 0}>
          <box flexDirection="row" gap={1}>
            <text fg={theme.reviewedByMe} attributes={TextAttributes.BOLD}>
              {String(props.reviewedByMeCount)}
            </text>
            <text fg={theme.dimmed}>reviewed</text>
          </box>
        </Show>
        <box flexDirection="row" gap={1}>
          <text fg={theme.text} attributes={TextAttributes.BOLD}>
            {String(props.prCount)}
          </text>
          <text fg={theme.dimmed}>open</text>
        </box>
        <Show when={props.loading}>
          <text fg={theme.warning}>refreshing...</text>
        </Show>
        <Show when={!props.loading}>
          <text fg={theme.dimmed}>{props.lastRefresh}</text>
        </Show>
      </box>
    </box>
  )
}

function CIBadge(props: { ci: CIStatus }) {
  return (
    <text fg={ciColor(props.ci)}>
      {ciIcon(props.ci)}
    </text>
  )
}

function PRRow(props: { pr: PR; selected: boolean }) {
  const bgColor = props.selected ? theme.surface : theme.bg

  return (
    <box flexDirection="column" backgroundColor={bgColor}>
      <box flexDirection="row" gap={1} paddingX={2}>
        <Show when={props.selected}>
          <text fg={theme.accent} attributes={TextAttributes.BOLD}>
            {">"}
          </text>
        </Show>
        <Show when={!props.selected}>
          <text fg={theme.bg}>{" "}</text>
        </Show>
        <text fg={theme.dimmed}>#{String(props.pr.number)}</text>
        <text
          fg={props.selected ? theme.text : theme.text}
          attributes={props.selected ? TextAttributes.BOLD : 0}
        >
          {props.pr.title}
        </text>
        <box flexGrow={1} />
        <CIBadge ci={props.pr.ciStatus} />
        <text fg={theme.dimmed}>{relativeTime(props.pr.updatedAt)}</text>
      </box>
      <Show when={props.pr.humanReviews.length > 0}>
        <For each={props.pr.humanReviews}>
          {(review) => (
            <box flexDirection="row" paddingX={5} gap={1}>
              <text fg={theme.dimmed}>{"└"}</text>
              <text fg={theme.info}>{review.login}</text>
              <text fg={theme.dimmed}>
                {reviewStateLabel(review.state)} {relativeTime(review.submittedAt)}
              </text>
            </box>
          )}
        </For>
      </Show>
    </box>
  )
}

function StatusGroup(props: {
  status: PRStatus
  prs: PR[]
  selectedIndex: number
  globalOffset: number
}) {
  return (
    <box flexDirection="column">
      <box flexDirection="row" paddingX={1} gap={1}>
        <text fg={statusColors[props.status]} attributes={TextAttributes.BOLD}>
          {statusLabels[props.status]}
        </text>
        <text fg={theme.dimmed}>({String(props.prs.length)})</text>
      </box>
      <For each={props.prs}>
        {(pr, i) => (
          <PRRow
            pr={pr}
            selected={props.globalOffset + i() === props.selectedIndex}
          />
        )}
      </For>
      <box height={1} />
    </box>
  )
}

function ReviewerPRRow(props: { pr: ReviewerPR; selected: boolean }) {
  const bgColor = props.selected ? theme.surface : theme.bg

  return (
    <box flexDirection="column" backgroundColor={bgColor}>
      <box flexDirection="row" gap={1} paddingX={2}>
        <Show when={props.selected}>
          <text fg={theme.accent} attributes={TextAttributes.BOLD}>
            {">"}
          </text>
        </Show>
        <Show when={!props.selected}>
          <text fg={theme.bg}>{" "}</text>
        </Show>
        <text fg={theme.dimmed}>#{String(props.pr.number)}</text>
        <text
          fg={props.selected ? theme.text : theme.text}
          attributes={props.selected ? TextAttributes.BOLD : 0}
        >
          {props.pr.title}
        </text>
        <box flexGrow={1} />
        <Show when={props.pr.isDraft}>
          <text fg={theme.draft}>draft</text>
        </Show>
        <Show when={props.pr.myReviewState}>
          <text fg={theme.dimmed}>{reviewStateLabel(props.pr.myReviewState ?? "")}</text>
        </Show>
        <CIBadge ci={props.pr.ciStatus} />
        <text fg={theme.info}>{props.pr.author}</text>
        <text fg={theme.dimmed}>{relativeTime(props.pr.updatedAt)}</text>
      </box>
    </box>
  )
}

function ReviewerSection(props: {
  label: string
  color: string
  prs: ReviewerPR[]
  selectedIndex: number
  globalOffset: number
}) {
  return (
    <box flexDirection="column">
      <box flexDirection="row" paddingX={1} gap={1}>
        <text fg={props.color} attributes={TextAttributes.BOLD}>
          {props.label}
        </text>
        <text fg={theme.dimmed}>({String(props.prs.length)})</text>
      </box>
      <For each={props.prs}>
        {(pr, i) => (
          <ReviewerPRRow
            pr={pr}
            selected={props.globalOffset + i() === props.selectedIndex}
          />
        )}
      </For>
      <box height={1} />
    </box>
  )
}

function Footer() {
  const binds = [
    { key: " r ", desc: "Refresh" },
    { key: " o ", desc: "Open in browser" },
    { key: " j/k ", desc: "Navigate" },
    { key: " q ", desc: "Quit" },
  ]

  return (
    <box paddingX={1} height={1} backgroundColor={theme.surface}>
      <box flexDirection="row" gap={2}>
        <For each={binds}>
          {(b) => (
            <box flexDirection="row">
              <text fg="#fff" bg={theme.accentDim}>
                {b.key}
              </text>
              <text fg={theme.dimmed}> {b.desc}</text>
            </box>
          )}
        </For>
      </box>
    </box>
  )
}

function ErrorBanner(props: { message: string }) {
  return (
    <box paddingX={2} paddingY={1}>
      <box flexDirection="row" gap={1}>
        <text fg={theme.error} attributes={TextAttributes.BOLD}>
          Error:
        </text>
        <text fg={theme.error}>{props.message}</text>
      </box>
    </box>
  )
}

function EmptyState() {
  return (
    <box justifyContent="center" alignItems="center" flexGrow={1}>
      <text fg={theme.dimmed}>No open PRs found.</text>
    </box>
  )
}

// ─── App ──────────────────────────────────────────────────────────
function App() {
  const [prs, setPrs] = createSignal<PR[]>([])
  const [needsMyReview, setNeedsMyReview] = createSignal<ReviewerPR[]>([])
  const [reviewedByMe, setReviewedByMe] = createSignal<ReviewerPR[]>([])
  const [loading, setLoading] = createSignal(true)
  const [error, setError] = createSignal("")
  const [lastRefresh, setLastRefresh] = createSignal("")
  const [selectedIndex, setSelectedIndex] = createSignal(0)

  async function refresh() {
    setLoading(true)
    setError("")
    try {
      const [myPRs, reviewRequested, reviewedBy] = await Promise.all([
        fetchPRData(),
        fetchReviewRequestedPRs(),
        fetchReviewedByMePRs(),
      ])

      // Deduplicate: remove from "reviewed by me" anything that's in
      // "needs my review" (re-requested) or authored by me
      const needsReviewNumbers = new Set(reviewRequested.map((pr) => pr.number))
      const myPRNumbers = new Set(myPRs.map((pr) => pr.number))
      const dedupedReviewedByMe = reviewedBy.filter(
        (pr) => !needsReviewNumbers.has(pr.number) && !myPRNumbers.has(pr.number),
      )

      batch(() => {
        setPrs(myPRs)
        setNeedsMyReview(reviewRequested)
        setReviewedByMe(dedupedReviewedByMe)
        setLastRefresh(new Date().toLocaleTimeString())
        setLoading(false)
      })
    } catch (e) {
      batch(() => {
        setError(e instanceof Error ? e.message : String(e))
        setLoading(false)
      })
    }
  }

  // Grouped and ordered PRs (my authored PRs)
  const grouped = createMemo(() => {
    const reviewerOffset = needsMyReview().length + reviewedByMe().length
    const groups: Array<{ status: PRStatus; prs: PR[]; offset: number }> = []
    let offset = reviewerOffset
    for (const status of statusOrder) {
      const matching = prs().filter((pr) => pr.status === status)
      if (matching.length > 0) {
        groups.push({ status, prs: matching, offset })
        offset += matching.length
      }
    }
    return groups
  })

  const totalPRs = createMemo(() => prs().length)
  const totalItems = createMemo(
    () => needsMyReview().length + reviewedByMe().length + prs().length,
  )

  // Offset where "reviewed by me" section starts in the flat list
  const reviewedByMeOffset = createMemo(() => needsMyReview().length)

  // Flat list of PR numbers for navigation + open-in-browser
  const flatItems = createMemo(() => {
    const result: Array<{ number: number }> = []
    for (const pr of needsMyReview()) result.push({ number: pr.number })
    for (const pr of reviewedByMe()) result.push({ number: pr.number })
    for (const g of grouped()) {
      for (const pr of g.prs) result.push({ number: pr.number })
    }
    return result
  })

  // Keyboard
  const renderer = useRenderer()

  // `q` used to call process.exit(0) on its own, which never gave OpenTUI the
  // chance to switch the terminal back out of its alternate screen, so fragments
  // of the dashboard were left behind in the scrollback. destroy() hands the
  // terminal back; the explicit exit then guarantees the shell returns straight
  // away rather than waiting on the refresh timer or an in-flight `gh` call.
  const quit = () => {
    renderer.destroy()
    process.exit(0)
  }

  useKeyboard((key) => {
    if (key.name === "q") return quit()
    if (key.name === "r") refresh()

    if (key.name === "o") {
      const item = flatItems()[selectedIndex()]
      if (item) {
        Bun.spawn(["gh", "pr", "view", "--repo", REPO, "--web", String(item.number)], {
          stdout: "ignore",
          stderr: "ignore",
        })
      }
    }

    const total = flatItems().length
    if (total === 0) return

    if (key.name === "j" || key.name === "arrow-down") {
      setSelectedIndex((i) => Math.min(i + 1, total - 1))
    }
    if (key.name === "k" || key.name === "arrow-up") {
      setSelectedIndex((i) => Math.max(i - 1, 0))
    }
  })

  // Initial fetch + auto-refresh
  refresh()
  const timer = setInterval(refresh, REFRESH_INTERVAL_MS)
  onCleanup(() => clearInterval(timer))

  return (
    <box
      flexDirection="column"
      width="100%"
      height="100%"
      backgroundColor={theme.bg}
    >
      <Header
        prCount={totalPRs()}
        reviewCount={needsMyReview().length}
        reviewedByMeCount={reviewedByMe().length}
        lastRefresh={lastRefresh()}
        loading={loading()}
      />

      <Show when={error()}>
        <ErrorBanner message={error()} />
      </Show>

      <Show when={!loading() && totalItems() === 0 && !error()}>
        <EmptyState />
      </Show>

      <box flexDirection="column" flexGrow={1} paddingY={1}>
        <Show when={needsMyReview().length > 0}>
          <ReviewerSection
            label="Needs My Review"
            color={theme.reviewNeeded}
            prs={needsMyReview()}
            selectedIndex={selectedIndex()}
            globalOffset={0}
          />
        </Show>

        <Show when={reviewedByMe().length > 0}>
          <ReviewerSection
            label="Reviewed by Me"
            color={theme.reviewedByMe}
            prs={reviewedByMe()}
            selectedIndex={selectedIndex()}
            globalOffset={reviewedByMeOffset()}
          />
        </Show>

        <Show when={prs().length > 0}>
          <box flexDirection="row" paddingX={1}>
            <text fg={theme.dimmed}>{"─── My PRs ───"}</text>
          </box>
        </Show>

        <For each={grouped()}>
          {(group) => (
            <StatusGroup
              status={group.status}
              prs={group.prs}
              selectedIndex={selectedIndex()}
              globalOffset={group.offset}
            />
          )}
        </For>
      </box>

      <Footer />
    </box>
  )
}

// ─── Entry Point ──────────────────────────────────────────────────
if (import.meta.main) {
  const renderer = await createCliRenderer({
    exitOnCtrlC: true,
    useMouse: true,
    targetFps: 30,
    backgroundColor: theme.bg,
  })
  render(() => <App />, renderer)
}

export { App, theme }
