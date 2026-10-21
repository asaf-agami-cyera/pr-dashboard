import { createCliRenderer, TextAttributes } from "@opentui/core"
import { render, useKeyboard, useRenderer } from "@opentui/solid"
import { createSignal, createMemo, For, Show, onCleanup, batch } from "solid-js"
import type { CIStatus, PR, PRStatus, ReviewInfo, ReviewerPR } from "./model"
import { prKey } from "./model"
import { mergedSearch, recentMerges } from "./recent-merges"
import { parseRepos, type RepoConfig } from "./repos"
import {
  assignStackSlots,
  buildRows,
  effectiveSelection,
  isOpen,
  parseStacks,
  prRows,
  slotLetter,
  stackChain,
  stackKey,
  stackQuery,
  type DashboardData,
  type GHStackResponse,
  type MemberStatus,
  type PRRow,
  type Row,
  type Selection,
  type Stack,
  type StackIndex,
  type StackSummary,
  type View,
} from "./stacks"

// ─── Theme ────────────────────────────────────────────────────────
const theme = {
  bg: "#0d1117",
  surface: "#161b22",
  border: "#30363d",
  accent: "#7c3aed",
  accentDim: "#5b21b6",
  text: "#e6edf3",
  dimmed: "#8b949e",
  faint: "#5c6470",
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
  stacks: ["#56d4dd", "#f778ba", "#d2a8ff", "#e6c07b", "#ffa198", "#7ee7c7"],
}

// ─── Types ────────────────────────────────────────────────────────
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
  mergedAt?: string | null
}

// ─── Data ─────────────────────────────────────────────────────────
const REFRESH_INTERVAL_MS = 5 * 60 * 1000
const STACK_QUERY_CHUNK = 40

interface Config {
  repos: RepoConfig[]
  selfLogin: string
}

function readArgValues(name: string): string[] {
  const prefix = `${name}=`
  const values: string[] = []
  for (let i = 2; i < Bun.argv.length; i++) {
    const arg = Bun.argv.at(i)
    if (!arg) continue
    if (arg === name) {
      const value = Bun.argv.at(i + 1)
      if (value !== undefined) values.push(value)
      i++
    } else if (arg.startsWith(prefix)) {
      values.push(arg.slice(prefix.length))
    }
  }
  return values
}

function readConfig(): Config {
  const repoArgs = readArgValues("--repo")
  const repoEnv = Bun.env.PR_DASHBOARD_REPO
  const repos = parseRepos(repoArgs.length > 0 ? repoArgs : repoEnv ? [repoEnv] : [])
  const selfLogin = readArgValues("--self-login").at(0) ?? Bun.env.PR_DASHBOARD_SELF_LOGIN

  if (repos.length === 0 || !selfLogin) {
    throw new Error(
      "Missing config. Set PR_DASHBOARD_REPO and PR_DASHBOARD_SELF_LOGIN, or pass --repo owner/name --self-login username.",
    )
  }

  return { repos, selfLogin }
}

const config = readConfig()
const REPOS = config.repos
const SELF_LOGIN = config.selfLogin
const REPO_LABELS = new Map(REPOS.map((r) => [r.name, r.label]))
/** Width of the per-row repository tag; 0 hides it when only one repository is tracked. */
const REPO_TAG_WIDTH = REPOS.length > 1 ? Math.max(...REPOS.map((r) => r.label.length)) : 0
const REPOS_TITLE = REPOS.length > 1 ? REPOS.map((r) => r.label).join(" · ") : (REPOS.at(0)?.name ?? "")

async function runGh(args: string[]): Promise<string> {
  const proc = Bun.spawn(["gh", ...args], { stdout: "pipe", stderr: "pipe" })

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])

  if (exitCode !== 0) {
    throw new Error(`gh failed (exit ${exitCode}): ${stderr}`)
  }
  return stdout
}

function classifyPR(pr: GHPullRequest): PRStatus {
  if (pr.mergedAt) return "merged"
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

function parsePRs(repo: string, raw: GHPullRequest[]): PR[] {
  return raw.map((pr) => ({
    repo,
    number: pr.number,
    title: pr.title,
    url: pr.url,
    headRefName: pr.headRefName,
    createdAt: pr.createdAt,
    updatedAt: pr.updatedAt,
    mergedAt: pr.mergedAt,
    status: classifyPR(pr),
    ciStatus: deriveCIStatus(pr.statusCheckRollup),
    humanReviews: getHumanReviews(pr),
  }))
}

async function fetchPRData(repo: string, state: "open" | "merged" = "open"): Promise<PR[]> {
  const now = Date.now()
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
    "mergedAt",
  ].join(",")

  const stdout = await runGh([
    "pr",
    "list",
    "--repo",
    repo,
    "--author",
    "@me",
    "--state",
    state,
    ...(state === "merged" ? ["--search", mergedSearch(now)] : []),
    "--json",
    fields,
    "--limit",
    state === "merged" ? "1000" : "50",
  ])

  const raw: GHPullRequest[] = JSON.parse(stdout)
  return parsePRs(repo, state === "merged" ? recentMerges(raw, now) : raw)
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
  repo: string,
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
      repo,
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

async function fetchReviewerPRs(repo: string, search: string, includeMyReviewState: boolean): Promise<ReviewerPR[]> {
  const stdout = await runGh([
    "pr", "list",
    "--repo", repo,
    "--search", search,
    "--state", "open",
    "--json", REVIEWER_FIELDS,
    "--limit", "50",
  ])

  const raw: GHPullRequest[] = JSON.parse(stdout)
  return parseReviewerPRs(repo, raw, { includeMyReviewState })
}

const fetchReviewRequestedPRs = (repo: string) => fetchReviewerPRs(repo, "review-requested:@me", false)
const fetchReviewedByMePRs = (repo: string) => fetchReviewerPRs(repo, "reviewed-by:@me", true)

// `gh pr list --json` has no stack fields, so stack membership comes from GraphQL.
async function fetchStacks(repo: string, numbers: number[]): Promise<StackIndex> {
  const chunks: number[][] = []
  for (let i = 0; i < numbers.length; i += STACK_QUERY_CHUNK) {
    chunks.push(numbers.slice(i, i + STACK_QUERY_CHUNK))
  }
  const responses = await Promise.all(
    chunks.map(async (chunk) => {
      const stdout = await runGh(["api", "graphql", "-f", `query=${stackQuery(repo, chunk)}`])
      const response: GHStackResponse = JSON.parse(stdout)
      return response
    }),
  )
  return parseStacks(repo, responses)
}

interface RepoData {
  open: PR[]
  merged: PR[]
  reviewRequested: ReviewerPR[]
  reviewedBy: ReviewerPR[]
}

async function fetchRepoData(repo: string): Promise<RepoData> {
  const [open, reviewRequested, reviewedBy, merged] = await Promise.all([
    fetchPRData(repo),
    fetchReviewRequestedPRs(repo),
    fetchReviewedByMePRs(repo),
    fetchPRData(repo, "merged"),
  ])
  return { open, merged, reviewRequested, reviewedBy }
}

function newestFirst<T>(time: (item: T) => string | null | undefined): (a: T, b: T) => number {
  return (a, b) => Date.parse(time(b) ?? "") - Date.parse(time(a) ?? "")
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
  merged: "Merged · last 3 days",
}

const statusColors: Record<PRStatus, string> = {
  draft: theme.draft,
  waiting_for_review: theme.waiting,
  reviewed: theme.reviewed,
  changes_requested: theme.changesRequested,
  approved: theme.approved,
  merged: theme.accent,
}

const memberLabels: Record<MemberStatus, string> = {
  draft: "draft",
  waiting_for_review: "waiting",
  reviewed: "reviewed",
  changes_requested: "changes",
  approved: "approved",
  merged: "merged",
  closed: "closed",
}

function memberColor(status: MemberStatus): string {
  return status === "closed" ? theme.dimmed : statusColors[status]
}

const summaryText: Record<StackSummary, { text: string; color: string }> = {
  blocked_changes: { text: "blocked: changes requested", color: theme.error },
  blocked_ci: { text: "blocked: CI failing", color: theme.error },
  ready: { text: "bottom ready to merge", color: theme.success },
}

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

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}

interface StackSlot {
  letter: string
  color: string
}

// ─── Components ───────────────────────────────────────────────────
function Header(props: {
  prCount: number
  mergedCount: number
  reviewCount: number
  reviewedByMeCount: number
  lastRefresh: string
  loading: boolean
  view: View
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
        <text fg={theme.dimmed}>{REPOS_TITLE}</text>
        <text fg="#fff" bg={theme.accent}>
          {` ${props.view} view `}
        </text>
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
        <Show when={props.mergedCount > 0}>
          <box flexDirection="row" gap={1}>
            <text fg={theme.accent} attributes={TextAttributes.BOLD}>
              {String(props.mergedCount)}
            </text>
            <text fg={theme.dimmed}>merged</text>
          </box>
        </Show>
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

interface RowContext {
  view: () => View
  selected: () => PRRow | undefined
  slot: (stack: Stack) => StackSlot
  /** Width of `#<number>` for the widest visible PR, so titles line up across repositories. */
  numberWidth: () => number
}

function StatusPill(props: { status: MemberStatus }) {
  return <text fg={memberColor(props.status)}>{memberLabels[props.status].padEnd(8)}</text>
}

function PRRowView(props: { row: PRRow; ctx: RowContext }) {
  const row = props.row
  const item = row.item
  const isSelected = () => props.ctx.selected()?.key === row.key
  const isSibling = () => {
    const sel = props.ctx.selected()
    return (
      props.ctx.view() === "status" &&
      !isSelected() &&
      row.stack !== undefined &&
      sel?.section === row.section &&
      sel.stack !== undefined &&
      stackKey(sel.stack.stack) === stackKey(row.stack.stack)
    )
  }
  const slot = () => (row.stack ? props.ctx.slot(row.stack.stack) : undefined)
  const ghost = item.source === "ghost"
  const merged =
    (item.source === "mine" && item.pr.status === "merged") ||
    (item.source === "ghost" && item.member.status === "merged")
  const title = item.source === "ghost" ? item.member.title : item.pr.title
  const reviews = item.source === "mine" && !merged ? item.pr.humanReviews : []
  const reviewPad = () => (props.ctx.view() === "stack" ? 8 : 5)

  return (
    <box flexDirection="column" backgroundColor={isSelected() ? theme.surface : theme.bg}>
      <box flexDirection="row" gap={1} paddingX={2}>
        <Show when={isSelected()}>
          <text fg={theme.accent} attributes={TextAttributes.BOLD}>
            {">"}
          </text>
        </Show>
        <Show when={!isSelected()}>
          <text fg={isSibling() ? (slot()?.color ?? theme.bg) : theme.bg} attributes={TextAttributes.BOLD}>
            {isSibling() ? "┃" : " "}
          </text>
        </Show>
        <Show when={props.ctx.view() === "stack"}>
          <text fg={ghost ? theme.faint : (slot()?.color ?? theme.bg)}>
            {row.stack ? String(row.stack.position).padStart(2) : "  "}
          </text>
          <text fg={theme.accent}>{merged ? "✓" : " "}</text>
        </Show>
        <Show when={REPO_TAG_WIDTH > 0}>
          <text fg={ghost ? theme.faint : theme.dimmed}>
            {(REPO_LABELS.get(row.repo) ?? row.repo).padEnd(REPO_TAG_WIDTH)}
          </text>
        </Show>
        <text fg={ghost ? theme.faint : theme.dimmed}>{`#${row.number}`.padEnd(props.ctx.numberWidth())}</text>
        <Show when={props.ctx.view() === "status" && row.stack}>
          {(stack) => (
            <text fg={slot()?.color ?? theme.dimmed}>
              {`▌${slot()?.letter ?? "?"} ${stack().position}/${stack().stack.members.length}`}
            </text>
          )}
        </Show>
        <text
          fg={ghost ? theme.faint : theme.text}
          attributes={isSelected() ? TextAttributes.BOLD : 0}
        >
          {title}
        </text>
        <Show when={row.startHere && props.ctx.view() === "stack"}>
          <text fg={theme.reviewNeeded}>← start here</text>
        </Show>
        <box flexGrow={1} />
        <PRRowRight row={row} ctx={props.ctx} />
      </box>
      <For each={reviews}>
        {(review) => (
          <box flexDirection="row" paddingLeft={reviewPad()} gap={1}>
            <text fg={theme.dimmed}>{"└"}</text>
            <text fg={theme.info}>{review.login}</text>
            <text fg={theme.dimmed}>
              {reviewStateLabel(review.state)} {relativeTime(review.submittedAt)}
            </text>
          </box>
        )}
      </For>
    </box>
  )
}

function PRRowRight(props: { row: PRRow; ctx: RowContext }) {
  const item = props.row.item
  switch (item.source) {
    case "ghost":
      return (
        <box flexDirection="row" gap={1}>
          <Show when={props.row.section === "needs_review" && isOpen(item.member.status)}>
            <text fg={theme.faint}>doesn't request you ·</text>
          </Show>
          <StatusPill status={item.member.status} />
          <Show when={props.row.section !== "mine" || item.member.author !== SELF_LOGIN}>
            <text fg={theme.faint}>{item.member.author}</text>
          </Show>
        </box>
      )
    case "mine": {
      const pr = item.pr
      return (
        <box flexDirection="row" gap={1}>
          <Show when={props.ctx.view() === "stack"}>
            <StatusPill status={pr.status} />
          </Show>
          <Show when={pr.status !== "merged"}>
            <CIBadge ci={pr.ciStatus} />
          </Show>
          <text fg={theme.dimmed}>
            {pr.mergedAt ? `merged ${relativeTime(pr.mergedAt)}` : relativeTime(pr.updatedAt)}
          </text>
        </box>
      )
    }
    case "reviewer": {
      const pr = item.pr
      return (
        <box flexDirection="row" gap={1}>
          <Show when={pr.isDraft}>
            <text fg={theme.draft}>draft</text>
          </Show>
          <Show when={pr.myReviewState}>
            <text fg={theme.dimmed}>{reviewStateLabel(pr.myReviewState ?? "")}</text>
          </Show>
          <CIBadge ci={pr.ciStatus} />
          <text fg={theme.info}>{pr.author}</text>
          <text fg={theme.dimmed}>{relativeTime(pr.updatedAt)}</text>
        </box>
      )
    }
  }
}

function SectionHeader(props: { label: string; color: string; count: number; padding?: number }) {
  return (
    <box flexDirection="row" paddingX={props.padding ?? 1} gap={1}>
      <text fg={props.color} attributes={TextAttributes.BOLD}>
        {props.label}
      </text>
      <text fg={theme.dimmed}>({String(props.count)})</text>
    </box>
  )
}

function StackHeader(props: { stack: Stack; section: string; summary?: StackSummary; ctx: RowContext }) {
  const slot = () => props.ctx.slot(props.stack)
  const bottom = props.stack.members.at(0)
  const details = [
    ...(props.section === "mine" ? [] : [bottom?.author ?? "unknown"]),
    `${props.stack.members.length} PRs → ${props.stack.baseRefName}`,
  ].join(" · ")
  const summary = props.summary ? summaryText[props.summary] : undefined
  return (
    <box flexDirection="row" paddingX={3} gap={1}>
      <text fg={slot().color} attributes={TextAttributes.BOLD}>
        {`▌${slot().letter}`}
      </text>
      <text fg={theme.text} attributes={TextAttributes.BOLD}>
        {bottom?.title ?? `Stack ${props.stack.number}`}
      </text>
      <text fg={theme.dimmed}>{`· ${details}`}</text>
      <box flexGrow={1} />
      <Show when={summary}>
        {(s) => <text fg={s().color}>{s().text}</text>}
      </Show>
    </box>
  )
}

function RowView(props: { row: Row; ctx: RowContext }) {
  const row = props.row
  switch (row.kind) {
    case "pr":
      return <PRRowView row={row} ctx={props.ctx} />
    case "section":
      return row.section === "needs_review" ? (
        <SectionHeader label="Needs My Review" color={theme.reviewNeeded} count={row.count} />
      ) : (
        <SectionHeader label="Reviewed by Me" color={theme.reviewedByMe} count={row.count} />
      )
    case "group":
      return <SectionHeader label={statusLabels[row.status]} color={statusColors[row.status]} count={row.count} />
    case "divider":
      return (
        <box flexDirection="row" paddingX={1}>
          <text fg={theme.dimmed}>{"─── My PRs ───"}</text>
        </box>
      )
    case "stack":
      return <StackHeader stack={row.stack} section={row.section} summary={row.summary} ctx={props.ctx} />
    case "unstacked":
      return (
        <box flexDirection="row" paddingX={3} gap={1}>
          <text fg={theme.dimmed}>Not in a stack</text>
          <text fg={theme.dimmed}>({String(row.count)})</text>
        </box>
      )
    case "blank":
      return <box height={1} />
  }
}

function StatusLine(props: { view: View; row: PRRow | undefined; data: DashboardData; ctx: RowContext }) {
  const chain = () => (props.row ? stackChain(props.row, props.data) : [])
  const stack = () => props.row?.stack?.stack
  return (
    <box flexDirection="row" paddingX={1} height={1} overflow="hidden">
      <Show when={props.view === "status" && stack()}>
        {(s) => (
          <box flexDirection="row" gap={1}>
            <text fg={props.ctx.slot(s()).color} attributes={TextAttributes.BOLD}>
              {`▌${props.ctx.slot(s()).letter}`}
            </text>
            <text fg={theme.text} attributes={TextAttributes.BOLD} wrapMode="none">
              {truncate(s().members.at(0)?.title ?? "", 40)}
            </text>
            <For each={chain()}>
              {(link, i) => (
                <box flexDirection="row" gap={1}>
                  <Show when={i() > 0}>
                    <text fg={theme.dimmed}>→</text>
                  </Show>
                  <text fg={link.here ? theme.text : theme.dimmed} attributes={link.here ? TextAttributes.BOLD : 0}>
                    {link.here ? `${link.position} (here)` : String(link.position)}
                  </text>
                  <text fg={memberColor(link.status)}>{memberLabels[link.status]}</text>
                  <Show when={link.status !== "merged" && link.status !== "closed"}>
                    <CIBadge ci={link.ci} />
                  </Show>
                  <Show when={link.notRequested}>
                    <text fg={theme.dimmed}>(doesn't request you)</text>
                  </Show>
                </box>
              )}
            </For>
          </box>
        )}
      </Show>
      <box flexGrow={1} />
      <Show when={props.view === "stack" || stack()}>
        <text fg={theme.dimmed}>{props.view === "stack" ? "tab: back to status view" : "tab: show stack"}</text>
      </Show>
    </box>
  )
}

function Footer(props: { view: View }) {
  const binds = () => [
    { key: " r ", desc: "Refresh" },
    { key: " o ", desc: "Open in browser" },
    { key: " j/k ", desc: "Navigate" },
    { key: " tab ", desc: props.view === "status" ? "Stack view" : "Status view" },
    { key: " q ", desc: "Quit" },
  ]

  return (
    <box paddingX={1} height={1} backgroundColor={theme.surface}>
      <box flexDirection="row" gap={2}>
        <For each={binds()}>
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

function ErrorBanner(props: { label: string; message: string }) {
  return (
    <box paddingX={2} paddingY={1}>
      <box flexDirection="row" gap={1}>
        <text fg={theme.error} attributes={TextAttributes.BOLD}>
          {props.label}
        </text>
        <text fg={theme.error}>{props.message}</text>
      </box>
    </box>
  )
}

function EmptyState() {
  return (
    <box justifyContent="center" alignItems="center" flexGrow={1}>
      <text fg={theme.dimmed}>No open or recently merged PRs found.</text>
    </box>
  )
}

// ─── App ──────────────────────────────────────────────────────────
function App() {
  const [prs, setPrs] = createSignal<PR[]>([])
  const [needsMyReview, setNeedsMyReview] = createSignal<ReviewerPR[]>([])
  const [reviewedByMe, setReviewedByMe] = createSignal<ReviewerPR[]>([])
  const [stacks, setStacks] = createSignal<StackIndex>(new Map())
  const [stackSlots, setStackSlots] = createSignal<Map<string, number>>(new Map())
  const [loading, setLoading] = createSignal(true)
  const [error, setError] = createSignal("")
  const [stackError, setStackError] = createSignal("")
  const [lastRefresh, setLastRefresh] = createSignal("")
  const [view, setView] = createSignal<View>("status")
  const [selection, setSelection] = createSignal<Selection | undefined>()
  const [lastIndex, setLastIndex] = createSignal(0)

  async function refresh() {
    setLoading(true)
    setError("")
    try {
      const perRepo = await Promise.all(REPOS.map((r) => fetchRepoData(r.name)))
      const myPRs = perRepo.flatMap((d) => d.open)
      const mergedPRs = perRepo.flatMap((d) => d.merged).sort(newestFirst((pr: PR) => pr.mergedAt))
      const reviewRequested = perRepo.flatMap((d) => d.reviewRequested).sort(newestFirst((pr: ReviewerPR) => pr.createdAt))
      const reviewedBy = perRepo.flatMap((d) => d.reviewedBy).sort(newestFirst((pr: ReviewerPR) => pr.createdAt))

      // A PR can merge between the concurrent queries; prefer its merged snapshot.
      const mergedKeys = new Set(mergedPRs.map(prKey))
      const authoredPRs = [
        ...myPRs.filter((pr) => !mergedKeys.has(prKey(pr))).sort(newestFirst((pr: PR) => pr.createdAt)),
        ...mergedPRs,
      ]

      // Deduplicate: remove from "reviewed by me" anything that's in
      // "needs my review" (re-requested) or authored by me
      const needsReviewKeys = new Set(reviewRequested.map(prKey))
      const myPRKeys = new Set(authoredPRs.map(prKey))
      const dedupedReviewedByMe = reviewedBy.filter(
        (pr) => !needsReviewKeys.has(prKey(pr)) && !myPRKeys.has(prKey(pr)),
      )

      // Stacks are an overlay: without them the dashboard still shows every PR, so a failure here
      // is reported next to the PRs instead of replacing them.
      const listed = [...reviewRequested, ...dedupedReviewedByMe, ...authoredPRs]
      const stackResults = await Promise.allSettled(
        REPOS.map((r) => fetchStacks(r.name, listed.filter((pr) => pr.repo === r.name).map((pr) => pr.number))),
      )
      const stackIndex: StackIndex = new Map()
      const stackFailures: string[] = []
      stackResults.forEach((result, i) => {
        if (result.status === "fulfilled") {
          for (const [key, stack] of result.value) stackIndex.set(key, stack)
          return
        }
        const message = result.reason instanceof Error ? result.reason.message : String(result.reason)
        stackFailures.push(REPOS.length > 1 ? `${REPOS.at(i)?.label ?? "?"}: ${message}` : message)
      })

      batch(() => {
        setPrs(authoredPRs)
        setNeedsMyReview(reviewRequested)
        setReviewedByMe(dedupedReviewedByMe)
        setStacks(stackIndex)
        setStackSlots((prev) => assignStackSlots(prev, stackIndex.values()))
        setStackError(stackFailures.join("; "))
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

  const data = createMemo<DashboardData>(() => ({
    needsReview: needsMyReview(),
    reviewedByMe: reviewedByMe(),
    mine: prs(),
  }))
  const rows = createMemo(() => buildRows(view(), data(), stacks()))
  const selectable = createMemo(() => prRows(rows()))
  const selected = createMemo(() => effectiveSelection(rows(), selection(), lastIndex(), stacks()))
  const numberWidth = createMemo(() => Math.max(0, ...selectable().map((r) => `#${r.number}`.length)))

  const ctx: RowContext = {
    view,
    selected,
    slot: (stack) => {
      const slot = stackSlots().get(stackKey(stack)) ?? 0
      return { letter: slotLetter(slot), color: theme.stacks[slot % theme.stacks.length] ?? theme.dimmed }
    },
    numberWidth,
  }

  const totalPRs = createMemo(() => prs().filter((pr) => pr.status !== "merged").length)
  const totalMerged = createMemo(() => prs().filter((pr) => pr.status === "merged").length)
  const totalItems = createMemo(
    () => needsMyReview().length + reviewedByMe().length + prs().length,
  )

  function moveSelection(delta: number) {
    const list = selectable()
    if (list.length === 0) return
    const current = selected()
    const index = current ? list.findIndex((r) => r.key === current.key) : 0
    const nextIndex = Math.min(Math.max(index + delta, 0), list.length - 1)
    const next = list[nextIndex]
    if (!next) return
    batch(() => {
      setSelection({ section: next.section, repo: next.repo, number: next.number })
      setLastIndex(nextIndex)
    })
  }

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
    if (key.name === "tab") setView((v) => (v === "status" ? "stack" : "status"))

    if (key.name === "o") {
      const row = selected()
      if (row) {
        Bun.spawn(["gh", "pr", "view", "--repo", row.repo, "--web", String(row.number)], {
          stdout: "ignore",
          stderr: "ignore",
        })
      }
    }

    if (key.name === "j" || key.name === "arrow-down") moveSelection(1)
    if (key.name === "k" || key.name === "arrow-up") moveSelection(-1)
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
        mergedCount={totalMerged()}
        reviewCount={needsMyReview().length}
        reviewedByMeCount={reviewedByMe().length}
        lastRefresh={lastRefresh()}
        loading={loading()}
        view={view()}
      />

      <Show when={error()}>
        <ErrorBanner label="Error:" message={error()} />
      </Show>

      <Show when={stackError()}>
        <ErrorBanner label="Stacks unavailable:" message={stackError()} />
      </Show>

      <Show when={!loading() && totalItems() === 0 && !error()}>
        <EmptyState />
      </Show>

      <box flexDirection="column" flexGrow={1} paddingY={1}>
        <For each={rows()}>
          {(row) => <RowView row={row} ctx={ctx} />}
        </For>
      </box>

      <StatusLine view={view()} row={selected()} data={data()} ctx={ctx} />
      <Footer view={view()} />
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
