import { describe, expect, test } from "bun:test"
import type { PR, PRStatus, ReviewerPR } from "./model"
import {
  assignStackSlots,
  buildRows,
  effectiveSelection,
  parseStacks,
  prRows,
  slotLetter,
  stackChain,
  stackQuery,
  type DashboardData,
  type GHStackResponse,
  type Row,
  type Selection,
} from "./stacks"

const REPO = "octo-org/api"
const OTHER = "acme/web-app"

function mine(number: number, status: PRStatus, ciStatus: PR["ciStatus"] = "passing", repo = REPO): PR {
  return {
    repo,
    number,
    title: `PR ${number}`,
    url: `https://example.test/${number}`,
    headRefName: `b${number}`,
    createdAt: "2026-10-01T00:00:00Z",
    updatedAt: "2026-10-01T00:00:00Z",
    status,
    ciStatus,
    humanReviews: [],
  }
}

function reviewer(number: number, repo = REPO): ReviewerPR {
  return {
    repo,
    number,
    title: `PR ${number}`,
    url: `https://example.test/${number}`,
    headRefName: `b${number}`,
    createdAt: "2026-10-01T00:00:00Z",
    updatedAt: "2026-10-01T00:00:00Z",
    author: "dana",
    isDraft: false,
    ciStatus: "passing",
  }
}

function entry(position: number, number: number, state = "OPEN", reviewDecision: string | null = null) {
  return {
    position,
    pullRequest: {
      number,
      title: `PR ${number}`,
      url: `https://example.test/${number}`,
      state,
      isDraft: false,
      reviewDecision,
      author: { login: "asaf" },
    },
  }
}

// Stack 900: 101 (approved) ← 102 (waiting) ← 103 (draft)
// Stack 800: 201 (merged long ago, not in the lists) ← 202 (changes requested)
// Stack 700: 301 (not requesting me) ← 302 (requests me)
const response: GHStackResponse = {
  data: {
    repository: {
      pr102: {
        number: 102,
        stack: { number: 900, baseRefName: "main", entries: { nodes: [entry(3, 103), entry(1, 101, "OPEN", "APPROVED"), entry(2, 102)] } },
      },
      pr101: {
        number: 101,
        stack: { number: 900, baseRefName: "main", entries: { nodes: [entry(1, 101, "OPEN", "APPROVED"), entry(2, 102), entry(3, 103)] } },
      },
      pr103: {
        number: 103,
        stack: { number: 900, baseRefName: "main", entries: { nodes: [entry(1, 101, "OPEN", "APPROVED"), entry(2, 102), entry(3, 103)] } },
      },
      pr202: {
        number: 202,
        stack: { number: 800, baseRefName: "main", entries: { nodes: [entry(1, 201, "MERGED"), null, entry(2, 202, "OPEN", "CHANGES_REQUESTED")] } },
      },
      pr302: {
        number: 302,
        stack: { number: 700, baseRefName: "main", entries: { nodes: [entry(1, 301), entry(2, 302)] } },
      },
      pr400: { number: 400, stack: null },
      pr401: null,
    },
  },
}

const stacks = parseStacks(REPO, [response])

const data: DashboardData = {
  needsReview: [reviewer(302)],
  reviewedByMe: [],
  mine: [
    mine(101, "approved"),
    mine(102, "waiting_for_review", "pending"),
    mine(103, "draft", "unknown"),
    mine(202, "changes_requested", "failing"),
    mine(400, "reviewed"),
    mine(401, "merged"),
  ],
}

function describeRows(rows: Row[]): string[] {
  return rows.map((r) => {
    switch (r.kind) {
      case "pr":
        return `${r.item.source}:${r.repo === REPO ? "" : "other/"}${r.number}${r.stack ? `@${r.stack.position}` : ""}${r.startHere ? "*" : ""}`
      case "stack":
        return `stack:${r.stack.number}${r.summary ? `:${r.summary}` : ""}`
      case "section":
        return `section:${r.section}`
      case "group":
        return `group:${r.status}`
      case "unstacked":
        return `unstacked:${r.count}`
      case "divider":
      case "blank":
        return r.kind
    }
  })
}

describe("parseStacks", () => {
  test("indexes every stack member, with members bottom to top", () => {
    const key = (n: number) => `${REPO}#${n}`
    expect([...stacks.keys()].sort()).toEqual([101, 102, 103, 201, 202, 301, 302].map(key))
    expect(stacks.get(key(102))?.members.map((m) => m.number)).toEqual([101, 102, 103])
    expect(stacks.get(key(202))?.members.map((m) => [m.number, m.status])).toEqual([
      [201, "merged"],
      [202, "changes_requested"],
    ])
  })
})

describe("stack slots", () => {
  test("keeps existing slots and gives new stacks the lowest free one", () => {
    const ids = (...numbers: number[]) => numbers.map((number) => ({ repo: REPO, number }))
    const first = assignStackSlots(new Map(), ids(900, 800, 700))
    expect([...first]).toEqual([[`${REPO}#700`, 0], [`${REPO}#800`, 1], [`${REPO}#900`, 2]])
    const second = assignStackSlots(first, ids(900, 950, 700))
    expect(second.get(`${REPO}#700`)).toBe(0)
    expect(second.get(`${REPO}#900`)).toBe(2)
    expect(second.get(`${REPO}#950`)).toBe(1)
  })

  test("stacks with the same number in different repositories get separate slots", () => {
    const slots = assignStackSlots(new Map(), [{ repo: REPO, number: 5 }, { repo: OTHER, number: 5 }])
    expect([...slots]).toEqual([[`${OTHER}#5`, 0], [`${REPO}#5`, 1]])
  })

  test("letters run A–Z, then AA", () => {
    expect([0, 1, 25, 26, 27].map(slotLetter)).toEqual(["A", "B", "Z", "AA", "AB"])
  })
})

describe("buildRows", () => {
  test("status view keeps today's grouping", () => {
    expect(describeRows(buildRows("status", data, stacks))).toEqual([
      "section:needs_review", "reviewer:302@2", "blank",
      "divider",
      "group:changes_requested", "mine:202@2", "blank",
      "group:reviewed", "mine:400", "blank",
      "group:waiting_for_review", "mine:102@2", "blank",
      "group:approved", "mine:101@1", "blank",
      "group:draft", "mine:103@3", "blank",
      "group:merged", "mine:401", "blank",
    ])
  })

  test("stack view lists stacks by most urgent PR, fills missing members with ghosts, then the rest", () => {
    expect(describeRows(buildRows("stack", data, stacks))).toEqual([
      "section:needs_review", "stack:700", "ghost:301@1", "reviewer:302@2", "blank",
      "divider",
      "stack:800:blocked_changes", "ghost:201@1", "mine:202@2",
      "stack:900:ready", "mine:101@1", "mine:102@2", "mine:103@3",
      "unstacked:2", "mine:400", "mine:401", "blank",
    ])
  })

  test("marks the lowest of several requested stack PRs as the place to start", () => {
    const both: DashboardData = { needsReview: [reviewer(302), reviewer(301)], reviewedByMe: [], mine: [] }
    const both301 = parseStacks(REPO, [{
      data: { repository: { pr301: { number: 301, stack: { number: 700, baseRefName: "main", entries: { nodes: [entry(1, 301), entry(2, 302)] } } }, pr302: response.data.repository?.pr302 ?? null } },
    }])
    expect(describeRows(buildRows("stack", both, both301))).toEqual([
      "section:needs_review", "stack:700", "reviewer:301@1*", "reviewer:302@2", "blank",
    ])
  })

  test("a PR in another repository with a stacked PR's number stays out of that stack", () => {
    const mixed: DashboardData = { ...data, mine: [...data.mine, mine(102, "approved", "passing", OTHER)] }
    const rows = describeRows(buildRows("stack", mixed, stacks))
    expect(rows.slice(rows.indexOf("stack:900:ready"))).toEqual([
      "stack:900:ready", "mine:101@1", "mine:102@2", "mine:103@3",
      "unstacked:3", "mine:400", "mine:other/102", "mine:401", "blank",
    ])
  })
})

const key = (section: string, number: number, repo = REPO) => `${section}:${repo}#${number}`

describe("effectiveSelection", () => {
  test("follows the PR across views", () => {
    const status = buildRows("status", data, stacks)
    const stack = buildRows("stack", data, stacks)
    const sel: Selection = { section: "mine", repo: REPO, number: 102 }
    expect(effectiveSelection(status, sel, 0, stacks)?.key).toBe(key("mine", 102))
    expect(effectiveSelection(stack, sel, 0, stacks)?.key).toBe(key("mine", 102))
  })

  test("a ghost row falls back to the nearest PR of its stack in the same section", () => {
    const status = buildRows("status", data, stacks)
    expect(effectiveSelection(status, { section: "needs_review", repo: REPO, number: 301 }, 0, stacks)?.key).toBe(key("needs_review", 302))
    expect(effectiveSelection(status, { section: "mine", repo: REPO, number: 201 }, 0, stacks)?.key).toBe(key("mine", 202))
  })

  test("a PR that disappeared falls back to the last position", () => {
    const status = buildRows("status", data, stacks)
    const list = prRows(status)
    expect(effectiveSelection(status, { section: "mine", repo: REPO, number: 999 }, 2, stacks)?.key).toBe(list[2]?.key)
    expect(effectiveSelection(status, { section: "mine", repo: OTHER, number: 102 }, 2, stacks)?.key).toBe(list[2]?.key)
    expect(effectiveSelection(status, undefined, 99, stacks)?.key).toBe(list.at(-1)?.key)
  })
})

describe("stackChain", () => {
  test("uses my PR's own status and CI, and flags layers that don't request my review", () => {
    const rows = prRows(buildRows("status", data, stacks))
    const mineRow = rows.find((r) => r.key === key("mine", 102))
    const reviewRow = rows.find((r) => r.key === key("needs_review", 302))
    expect(mineRow && stackChain(mineRow, data).map((l) => [l.number, l.status, l.ci, l.here])).toEqual([
      [101, "approved", "passing", false],
      [102, "waiting_for_review", "pending", true],
      [103, "draft", "unknown", false],
    ])
    expect(reviewRow && stackChain(reviewRow, data).map((l) => [l.number, l.notRequested])).toEqual([
      [301, true],
      [302, false],
    ])
  })
})

test("stackQuery aliases each PR in one repository query", () => {
  const q = stackQuery("octo-org/api", [1, 2])
  expect(q).toContain('repository(owner: "octo-org", name: "api")')
  expect(q).toContain("pr1: pullRequest(number: 1)")
  expect(q).toContain("pr2: pullRequest(number: 2)")
})
