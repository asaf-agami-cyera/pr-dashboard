import { describe, expect, test } from "bun:test"
import { mergedSearch, recentMerges } from "./recent-merges"

const now = Date.parse("2026-09-07T12:00:00.000Z")

describe("recent merges", () => {
  test("includes the exact 72-hour boundary, but excludes older and future merges", () => {
    const prs = [
      { mergedAt: "2026-09-04T11:59:59.999Z" },
      { mergedAt: "2026-09-04T12:00:00.000Z" },
      { mergedAt: "2026-09-07T12:00:00.000Z" },
      { mergedAt: "2026-09-07T12:00:00.001Z" },
    ]
    expect(recentMerges(prs, now)).toEqual([prs[2], prs[1]])
  })

  test("ignores unmerged PRs and invalid timestamps", () => {
    expect(recentMerges([
      {}, { mergedAt: null }, { mergedAt: "invalid" },
    ], now)).toEqual([])
  })

  test("sorts by merge time rather than update time without mutating the input", () => {
    const older = { mergedAt: "2026-09-05T12:00:00Z", updatedAt: "2026-09-07T12:00:00Z" }
    const newer = { mergedAt: "2026-09-06T12:00:00Z", updatedAt: "2026-09-06T12:00:00Z" }
    const prs = [older, newer]
    expect(recentMerges(prs, now)).toEqual([newer, older])
    expect(prs).toEqual([older, newer])
  })

  test("searches from the UTC cutoff day, including across month boundaries", () => {
    expect(mergedSearch(now)).toBe("merged:>=2026-09-04")
    expect(mergedSearch(Date.parse("2026-09-02T01:00:00Z"))).toBe("merged:>=2026-08-30")
  })
})
