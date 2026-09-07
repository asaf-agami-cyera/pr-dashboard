export const MERGED_WINDOW_MS = 3 * 24 * 60 * 60 * 1000

export function mergedSearch(now: number): string {
  // Fetch the whole cutoff day; filter locally for an exact rolling 72-hour window.
  const cutoffDay = new Date(now - MERGED_WINDOW_MS).toISOString().slice(0, 10)
  return `merged:>=${cutoffDay}`
}

export function recentMerges<T extends { mergedAt?: string | null }>(
  prs: T[],
  now: number,
): T[] {
  return prs
    .filter((pr) => {
      const mergedAt = Date.parse(pr.mergedAt ?? "")
      return mergedAt >= now - MERGED_WINDOW_MS && mergedAt <= now
    })
    .sort((a, b) => Date.parse(b.mergedAt ?? "") - Date.parse(a.mergedAt ?? ""))
}
