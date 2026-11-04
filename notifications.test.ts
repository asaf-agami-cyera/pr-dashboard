import { describe, expect, test } from "bun:test"
import type { PR, ReviewerPR } from "./model"
import { trackChanges, type PRNotification, type Seen, type Snapshot } from "./notifications"

function mine(overrides: Partial<PR> = {}): PR {
  return {
    repo: "acme/api",
    number: 1,
    title: "Add retries",
    url: "https://github.com/acme/api/pull/1",
    headRefName: "retries",
    createdAt: "2026-11-01T00:00:00Z",
    updatedAt: "2026-11-01T00:00:00Z",
    status: "waiting_for_review",
    ciStatus: "passing",
    humanReviews: [],
    ...overrides,
  }
}

function other(overrides: Partial<ReviewerPR> = {}): ReviewerPR {
  return {
    repo: "acme/api",
    number: 7,
    title: "Fix login",
    url: "https://github.com/acme/api/pull/7",
    headRefName: "login",
    createdAt: "2026-11-01T00:00:00Z",
    updatedAt: "2026-11-01T00:00:00Z",
    author: "bob",
    isDraft: false,
    ciStatus: "passing",
    ...overrides,
  }
}

const label = (repo: string) => repo.split("/").at(1) ?? repo
const snapshot = (s: Partial<Snapshot>): Snapshot => ({ mine: [], needsReview: [], reviewedByMe: [], ...s })

/** Feeds refreshes in order and returns the notifications from each one. */
function run(...refreshes: Partial<Snapshot>[]): PRNotification[][] {
  let seen: Seen | undefined
  return refreshes.map((s) => {
    const result = trackChanges(seen, snapshot(s), label)
    seen = result.seen
    return result.notifications
  })
}

const review = (login: string, state: string, submittedAt: string) => ({ login, state, submittedAt })
const alice = review("alice", "APPROVED", "2026-11-02T00:00:00Z")

describe("trackChanges", () => {
  test("the first refresh records state without notifying", () => {
    expect(run({ mine: [mine({ status: "approved", humanReviews: [alice] })], needsReview: [other()] })).toEqual([[]])
  })

  test("an approval names the PR and the reviewer", () => {
    const [, second] = run({ mine: [mine()] }, { mine: [mine({ status: "approved", humanReviews: [alice] })] })
    expect(second).toEqual([
      {
        group: "mine:acme/api#1",
        title: "Approved",
        subtitle: "api#1 · alice approved",
        message: "Add retries",
        url: "https://github.com/acme/api/pull/1",
      },
    ])
  })

  test("a later review by the same person notifies even when the status stays the same", () => {
    const first = review("alice", "COMMENTED", "2026-11-02T00:00:00Z")
    const second = review("alice", "COMMENTED", "2026-11-03T00:00:00Z")
    const [, notifications] = run(
      { mine: [mine({ status: "reviewed", humanReviews: [first] })] },
      { mine: [mine({ status: "reviewed", humanReviews: [second] })] },
    )
    expect(notifications.map((n) => [n.title, n.subtitle])).toEqual([["New review", "api#1 · alice commented"]])
  })

  test("merging notifies without a review", () => {
    const [, notifications] = run({ mine: [mine({ status: "approved" })] }, { mine: [mine({ status: "merged" })] })
    expect(notifications.map((n) => n.title)).toEqual(["Merged"])
  })

  test("status changes without a new review stay quiet", () => {
    // Your own draft/ready toggles, and a push that dismisses an approval.
    expect(run(
      { mine: [mine({ status: "draft" }), mine({ number: 2, status: "approved", humanReviews: [alice] })] },
      { mine: [mine(), mine({ number: 2, status: "reviewed", humanReviews: [alice] })] },
    )).toEqual([[], []])
  })

  test("a PR that drops out of a refresh and comes back is not news", () => {
    const pr = mine({ status: "approved", humanReviews: [alice] })
    expect(run(
      { mine: [pr], needsReview: [other()] },
      {},
      { mine: [pr], needsReview: [other()] },
    )).toEqual([[], [], []])
  })

  test("older or unparseable review timestamps stay quiet", () => {
    const older = review("alice", "APPROVED", "2026-11-01T00:00:00Z")
    const broken = review("alice", "APPROVED", "not a date")
    expect(run(
      { mine: [mine({ humanReviews: [alice] })] },
      { mine: [mine({ humanReviews: [older] })] },
      { mine: [mine({ humanReviews: [broken] })] },
    )).toEqual([[], [], []])
  })

  test("a new review request notifies once", () => {
    const [, second, third] = run(
      { needsReview: [other({ number: 5 })] },
      { needsReview: [other({ number: 5 }), other()] },
      { needsReview: [other({ number: 5 }), other()] },
    )
    expect(second).toEqual([
      {
        group: "review:acme/api#7",
        title: "Review requested",
        subtitle: "api#7 · by bob",
        message: "Fix login",
        url: "https://github.com/acme/api/pull/7",
      },
    ])
    expect(third).toEqual([])
  })

  test("a re-request after you reviewed notifies again", () => {
    const notifications = run(
      { needsReview: [other()] },
      { reviewedByMe: [other()] },
      { needsReview: [other()], reviewedByMe: [other()] },
    )
    expect(notifications.map((ns) => ns.map((n) => n.title))).toEqual([[], [], ["Review requested"]])
  })

  test("a burst of changes collapses into one summary", () => {
    const requests = Array.from({ length: 6 }, (_, i) => other({ number: i + 10 }))
    const [, notifications] = run({}, { needsReview: requests })
    expect(notifications.map((n) => [n.title, n.subtitle])).toEqual([["6 PR updates", "Review requested"]])
  })
})
