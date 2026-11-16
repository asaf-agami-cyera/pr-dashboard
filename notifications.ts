import { existsSync } from "node:fs"
import type { PR, PRStatus, ReviewerPR } from "./model"
import { prKey } from "./model"
import { notifierBinary, type NotifierKind } from "./notifiers"

/** What one successful refresh saw. */
export interface Snapshot {
  mine: PR[]
  needsReview: ReviewerPR[]
  reviewedByMe: ReviewerPR[]
}

/**
 * Everything seen so far this session. PRs that drop out of a refresh are kept, because GitHub's
 * search results can briefly omit a PR, and its return must not look like a change.
 */
export interface Seen {
  mine: Map<string, PR>
  requested: Set<string>
}

export interface PRNotification {
  /** Notifications with the same group replace each other, so each PR shows at most one. */
  group: string
  title: string
  subtitle: string
  message: string
  url: string
  /** Picks the notifier app, and so the icon. */
  kind: NotifierKind
}

const statusTitles: Partial<Record<PRStatus, string>> = {
  reviewed: "Reviewed",
  changes_requested: "Changes requested",
  approved: "Approved",
}

const reviewVerbs: Record<string, string> = {
  APPROVED: "approved",
  CHANGES_REQUESTED: "requested changes",
  COMMENTED: "commented",
  DISMISSED: "dismissed",
}

function seenFrom(next: Snapshot, prev?: Seen): Seen {
  const mine = new Map(prev?.mine)
  for (const pr of next.mine) mine.set(prKey(pr), pr)

  const requested = new Set(prev?.requested)
  for (const pr of next.needsReview) requested.add(prKey(pr))
  // Once you've reviewed it, a new request for the same PR is a re-request and should notify.
  const stillRequested = new Set(next.needsReview.map(prKey))
  for (const pr of next.reviewedByMe) {
    if (!stillRequested.has(prKey(pr))) requested.delete(prKey(pr))
  }
  return { mine, requested }
}

/** Compares a refresh against everything seen before it. The first refresh only records state. */
export function trackChanges(
  prev: Seen | undefined,
  next: Snapshot,
  repoLabel: (repo: string) => string,
): { seen: Seen; notifications: PRNotification[] } {
  const seen = seenFrom(next, prev)
  if (!prev) return { seen, notifications: [] }

  const notifications: PRNotification[] = []
  const ref = (pr: { repo: string; number: number }) => `${repoLabel(pr.repo)}#${pr.number}`

  for (const pr of next.mine) {
    const before = prev.mine.get(prKey(pr))
    if (!before) continue

    const lastSeen = new Map(before.humanReviews.map((r) => [r.login, Date.parse(r.submittedAt)]))
    const newReviews = pr.humanReviews.filter((r) => {
      const previous = lastSeen.get(r.login)
      return previous === undefined || Date.parse(r.submittedAt) > previous
    })
    const merged = pr.status === "merged" && before.status !== "merged"
    // Review statuses also change without anyone reviewing, e.g. when a push dismisses an approval.
    if (!merged && newReviews.length === 0) continue

    const statusTitle = merged ? "Merged" : pr.status !== before.status ? statusTitles[pr.status] : undefined
    const reviewers = newReviews.map((r) => `${r.login} ${reviewVerbs[r.state] ?? r.state.toLowerCase()}`)
    const approving = newReviews.length > 0 && newReviews.every((r) => r.state === "APPROVED")
    const kind: NotifierKind = merged ? "merged" : (statusTitle && pr.status === "approved") || approving ? "approved" : "attention"
    notifications.push({
      group: `mine:${prKey(pr)}`,
      title: statusTitle ?? "New review",
      subtitle: [ref(pr), ...reviewers].join(" · "),
      message: pr.title,
      url: pr.url,
      kind,
    })
  }

  for (const pr of next.needsReview) {
    if (prev.requested.has(prKey(pr))) continue
    notifications.push({
      group: `review:${prKey(pr)}`,
      title: "Review requested",
      subtitle: `${ref(pr)} · by ${pr.author}`,
      message: pr.title,
      url: pr.url,
      kind: "review_requested",
    })
  }

  return { seen, notifications: notifications.length > MAX_NOTIFICATIONS ? [summary(notifications)] : notifications }
}

const MAX_NOTIFICATIONS = 5

/** One alert instead of a wall of them, in case something unexpected makes many PRs look changed. */
function summary(notifications: PRNotification[]): PRNotification {
  return {
    group: "summary",
    title: `${notifications.length} PR updates`,
    subtitle: [...new Set(notifications.map((n) => n.title))].join(", "),
    message: "See the PR dashboard",
    url: "https://github.com/pulls",
    kind: "attention",
  }
}

/**
 * Posts through this kind's terminal-notifier copy so the notification gets the kind's icon, or
 * through plain terminal-notifier if `bun run build-notifiers` hasn't installed the copies. Each
 * copy stays on screen only if its macOS Alert Style is "Persistent".
 */
export async function postNotification(n: PRNotification): Promise<void> {
  const notifier = existsSync(notifierBinary(n.kind)) ? notifierBinary(n.kind) : "terminal-notifier"
  const proc = Bun.spawn(
    [
      notifier,
      "-title", n.title,
      "-subtitle", n.subtitle,
      // terminal-notifier misreads a message that starts with "[" unless it is escaped.
      "-message", n.message.startsWith("[") ? `\\${n.message}` : n.message,
      "-open", n.url,
      "-group", `pr-dashboard:${n.group}`,
    ],
    { stdout: "ignore", stderr: "pipe" },
  )
  const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited])
  if (exitCode !== 0) throw new Error(`${notifier} failed (exit ${exitCode}): ${stderr.trim()}`)
}
