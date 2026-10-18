import { statusOrder, type CIStatus, type PR, type PRStatus, type ReviewerPR } from "./model"

// ─── Stack data ───────────────────────────────────────────────────
export type MemberStatus = PRStatus | "closed"

export interface StackMember {
  number: number
  title: string
  url: string
  author: string
  position: number
  status: MemberStatus
}

export interface Stack {
  number: number
  baseRefName: string
  /** Bottom (position 1, closest to the base branch) to top. */
  members: StackMember[]
}

/** PR number → the stack it belongs to. */
export type StackIndex = Map<number, Stack>

interface GHStackEntryPR {
  number: number
  title: string
  url: string
  state: string
  isDraft: boolean
  reviewDecision: string | null
  author: { login: string } | null
}

interface GHStackEntry {
  position: number
  pullRequest: GHStackEntryPR | null
}

interface GHStack {
  number: number
  baseRefName: string
  entries: { nodes: Array<GHStackEntry | null> }
}

export interface GHStackedPR {
  number: number
  stack: GHStack | null
}

export interface GHStackResponse {
  data: { repository: Record<string, GHStackedPR | null> | null }
}

export function stackQuery(repo: string, numbers: number[]): string {
  const [owner, name] = repo.split("/")
  const fields = numbers
    .map(
      (n) => `pr${n}: pullRequest(number: ${n}) {
      number
      stack {
        number
        baseRefName
        entries(first: 100) {
          nodes {
            position
            pullRequest { number title url state isDraft reviewDecision author { login } }
          }
        }
      }
    }`,
    )
    .join("\n")
  return `query { repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) {\n${fields}\n} }`
}

function memberStatus(pr: GHStackEntryPR): MemberStatus {
  if (pr.state === "MERGED") return "merged"
  if (pr.state === "CLOSED") return "closed"
  if (pr.isDraft) return "draft"
  if (pr.reviewDecision === "APPROVED") return "approved"
  if (pr.reviewDecision === "CHANGES_REQUESTED") return "changes_requested"
  return "waiting_for_review"
}

export function parseStacks(responses: GHStackResponse[]): StackIndex {
  const index: StackIndex = new Map()
  for (const response of responses) {
    for (const pr of Object.values(response.data.repository ?? {})) {
      if (!pr?.stack) continue
      const members: StackMember[] = []
      for (const entry of pr.stack.entries.nodes) {
        const p = entry?.pullRequest
        if (!entry || !p) continue
        members.push({
          number: p.number,
          title: p.title,
          url: p.url,
          author: p.author?.login ?? "unknown",
          position: entry.position,
          status: memberStatus(p),
        })
      }
      members.sort((a, b) => a.position - b.position)
      const stack: Stack = { number: pr.stack.number, baseRefName: pr.stack.baseRefName, members }
      index.set(pr.number, stack)
      // Members outside the fetched lists (ghost rows) need their stack too.
      for (const m of members) if (!index.has(m.number)) index.set(m.number, stack)
    }
  }
  return index
}

// ─── Stack letters ────────────────────────────────────────────────
/**
 * Gives every stack a slot (letter + color). Stacks that are still present keep their slot across
 * refreshes; new stacks take the lowest free slot, in stack-number order.
 */
export function assignStackSlots(
  previous: ReadonlyMap<number, number>,
  stackNumbers: Iterable<number>,
): Map<number, number> {
  const current = [...new Set(stackNumbers)].sort((a, b) => a - b)
  const slots = new Map<number, number>()
  const used = new Set<number>()
  for (const n of current) {
    const slot = previous.get(n)
    if (slot === undefined) continue
    slots.set(n, slot)
    used.add(slot)
  }
  let next = 0
  for (const n of current) {
    if (slots.has(n)) continue
    while (used.has(next)) next++
    slots.set(n, next)
    used.add(next)
  }
  return slots
}

/** 0 → "A", 25 → "Z", 26 → "AA". */
export function slotLetter(slot: number): string {
  let s = ""
  let n = slot + 1
  while (n > 0) {
    const r = (n - 1) % 26
    s = String.fromCharCode(65 + r) + s
    n = Math.floor((n - 1) / 26)
  }
  return s
}

// ─── Rows ─────────────────────────────────────────────────────────
export type View = "status" | "stack"
export type SectionId = "needs_review" | "reviewed_by_me" | "mine"

export interface DashboardData {
  needsReview: ReviewerPR[]
  reviewedByMe: ReviewerPR[]
  mine: PR[]
}

export type RowItem =
  | { source: "mine"; pr: PR }
  | { source: "reviewer"; pr: ReviewerPR }
  | { source: "ghost"; member: StackMember }

export interface StackRef {
  stack: Stack
  position: number
}

export interface PRRow {
  kind: "pr"
  key: string
  section: SectionId
  number: number
  item: RowItem
  stack?: StackRef
  /** Lowest of several stack PRs that request your review. */
  startHere: boolean
}

export type StackSummary = "blocked_changes" | "blocked_ci" | "ready"

export type Row =
  | { kind: "section"; section: "needs_review" | "reviewed_by_me"; count: number }
  | { kind: "divider" }
  | { kind: "group"; status: PRStatus; count: number }
  | { kind: "stack"; section: SectionId; stack: Stack; summary?: StackSummary }
  | { kind: "unstacked"; count: number }
  | { kind: "blank" }
  | PRRow

export function rowKey(section: SectionId, number: number): string {
  return `${section}:${number}`
}

function stackRef(stacks: StackIndex, number: number): StackRef | undefined {
  const stack = stacks.get(number)
  const member = stack?.members.find((m) => m.number === number)
  return stack && member ? { stack, position: member.position } : undefined
}

function itemNumber(item: RowItem): number {
  return item.source === "ghost" ? item.member.number : item.pr.number
}

function prRow(section: SectionId, item: RowItem, stacks: StackIndex, startHere = false): PRRow {
  const number = itemNumber(item)
  return { kind: "pr", key: rowKey(section, number), section, number, item, stack: stackRef(stacks, number), startHere }
}

function sectionItems(data: DashboardData, section: SectionId): RowItem[] {
  switch (section) {
    case "needs_review":
      return data.needsReview.map((pr) => ({ source: "reviewer", pr }))
    case "reviewed_by_me":
      return data.reviewedByMe.map((pr) => ({ source: "reviewer", pr }))
    case "mine":
      return data.mine.map((pr) => ({ source: "mine", pr }))
  }
}

function statusRank(status: MemberStatus): number {
  const i = status === "closed" ? -1 : statusOrder.indexOf(status)
  return i === -1 ? statusOrder.length : i
}

function itemStatus(item: RowItem): MemberStatus | undefined {
  if (item.source === "mine") return item.pr.status
  if (item.source === "ghost") return item.member.status
  return undefined
}

function sortStable<T>(items: T[], rank: (item: T) => number): T[] {
  return items
    .map((item, i) => ({ item, i, r: rank(item) }))
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map((x) => x.item)
}

function summarize(stack: Stack, mine: ReadonlyMap<number, PR>): StackSummary | undefined {
  const layers = stack.members.map((m) => {
    const pr = mine.get(m.number)
    return { status: pr?.status ?? m.status, ci: pr?.ciStatus ?? "unknown" }
  })
  const open = layers.filter((l) => isOpen(l.status))
  if (open.some((l) => l.status === "changes_requested")) return "blocked_changes"
  if (open.some((l) => l.ci === "failing")) return "blocked_ci"
  const bottom = open.at(0)
  if (bottom?.status === "approved" && bottom.ci === "passing") return "ready"
  return undefined
}

const REVIEW_SECTIONS: Array<"needs_review" | "reviewed_by_me"> = ["needs_review", "reviewed_by_me"]

function statusViewRows(data: DashboardData, stacks: StackIndex): Row[] {
  const rows: Row[] = []
  for (const section of REVIEW_SECTIONS) {
    const items = sectionItems(data, section)
    if (items.length === 0) continue
    rows.push({ kind: "section", section, count: items.length })
    for (const item of items) rows.push(prRow(section, item, stacks))
    rows.push({ kind: "blank" })
  }
  if (data.mine.length > 0) rows.push({ kind: "divider" })
  for (const status of statusOrder) {
    const prs = data.mine.filter((pr) => pr.status === status)
    if (prs.length === 0) continue
    rows.push({ kind: "group", status, count: prs.length })
    for (const pr of prs) rows.push(prRow("mine", { source: "mine", pr }, stacks))
    rows.push({ kind: "blank" })
  }
  return rows
}

function stackSectionRows(data: DashboardData, section: SectionId, stacks: StackIndex): Row[] {
  const items = sectionItems(data, section)
  if (items.length === 0) return []
  const rows: Row[] = section === "mine" ? [{ kind: "divider" }] : [{ kind: "section", section, count: items.length }]

  const byStack = new Map<number, { stack: Stack; items: RowItem[] }>()
  const unstacked: RowItem[] = []
  for (const item of items) {
    const stack = stacks.get(itemNumber(item))
    if (!stack) {
      unstacked.push(item)
      continue
    }
    const entry = byStack.get(stack.number) ?? { stack, items: [] }
    entry.items.push(item)
    byStack.set(stack.number, entry)
  }

  let groups = [...byStack.values()]
  let rest = unstacked
  if (section === "mine") {
    const best = (g: { items: RowItem[] }) => Math.min(...g.items.map((i) => statusRank(itemStatus(i) ?? "closed")))
    groups = sortStable(groups, best)
    rest = sortStable(unstacked, (i) => statusRank(itemStatus(i) ?? "closed"))
  }

  const mine = new Map(data.mine.map((pr) => [pr.number, pr]))
  for (const { stack, items: real } of groups) {
    rows.push({ kind: "stack", section, stack, summary: section === "mine" ? summarize(stack, mine) : undefined })
    const realByNumber = new Map(real.map((i) => [itemNumber(i), i]))
    const lowestReal = stack.members.find((m) => realByNumber.has(m.number))?.number
    for (const member of stack.members) {
      const item = realByNumber.get(member.number)
      if (item) {
        const startHere = section === "needs_review" && real.length > 1 && member.number === lowestReal
        rows.push(prRow(section, item, stacks, startHere))
      } else {
        rows.push(prRow(section, { source: "ghost", member }, stacks))
      }
    }
  }
  if (groups.length > 0 && rest.length > 0) rows.push({ kind: "unstacked", count: rest.length })
  for (const item of rest) rows.push(prRow(section, item, stacks))
  rows.push({ kind: "blank" })
  return rows
}

export function buildRows(view: View, data: DashboardData, stacks: StackIndex): Row[] {
  if (view === "status") return statusViewRows(data, stacks)
  return [
    ...stackSectionRows(data, "needs_review", stacks),
    ...stackSectionRows(data, "reviewed_by_me", stacks),
    ...stackSectionRows(data, "mine", stacks),
  ]
}

export function prRows(rows: Row[]): PRRow[] {
  return rows.filter((r): r is PRRow => r.kind === "pr")
}

// ─── Selection ────────────────────────────────────────────────────
export interface Selection {
  section: SectionId
  number: number
}

/**
 * The row the cursor is on. The cursor follows a PR rather than a list position. When that PR has
 * no row in the current view (a stack-view ghost row, seen from the status view), it falls back to
 * the nearest PR of the same stack in the same section, then to the last position.
 */
export function effectiveSelection(
  rows: Row[],
  selection: Selection | undefined,
  lastIndex: number,
  stacks: StackIndex,
): PRRow | undefined {
  const selectable = prRows(rows)
  if (selectable.length === 0) return undefined
  if (selection) {
    const key = rowKey(selection.section, selection.number)
    const exact = selectable.find((r) => r.key === key)
    if (exact) return exact

    const ref = stackRef(stacks, selection.number)
    if (ref) {
      let nearest: { row: PRRow; distance: number } | undefined
      for (const r of selectable) {
        if (r.section !== selection.section || r.stack?.stack.number !== ref.stack.number) continue
        const distance = Math.abs(r.stack.position - ref.position)
        if (!nearest || distance < nearest.distance) nearest = { row: r, distance }
      }
      if (nearest) return nearest.row
    }
  }
  return selectable[Math.min(Math.max(lastIndex, 0), selectable.length - 1)]
}

// ─── Status line ──────────────────────────────────────────────────
export interface ChainLink {
  position: number
  number: number
  status: MemberStatus
  ci: CIStatus
  here: boolean
  /** In "Needs My Review": a layer that doesn't request your review. */
  notRequested: boolean
}

export function stackChain(row: PRRow, data: DashboardData): ChainLink[] {
  if (!row.stack) return []
  const mine = new Map(data.mine.map((pr) => [pr.number, pr]))
  const ci = new Map<number, CIStatus>()
  for (const pr of [...data.needsReview, ...data.reviewedByMe, ...data.mine]) ci.set(pr.number, pr.ciStatus)
  const requested = new Set(data.needsReview.map((pr) => pr.number))
  return row.stack.stack.members.map((m) => {
    const status = mine.get(m.number)?.status ?? m.status
    return {
      position: m.position,
      number: m.number,
      status,
      ci: ci.get(m.number) ?? "unknown",
      here: m.number === row.number,
      notRequested: row.section === "needs_review" && isOpen(status) && !requested.has(m.number),
    }
  })
}

export function isOpen(status: MemberStatus): boolean {
  return status !== "merged" && status !== "closed"
}
