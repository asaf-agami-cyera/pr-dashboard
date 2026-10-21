export type PRStatus =
  | "draft"
  | "waiting_for_review"
  | "reviewed"
  | "changes_requested"
  | "approved"
  | "merged"

export type CIStatus = "passing" | "failing" | "pending" | "unknown"

export interface ReviewInfo {
  login: string
  state: string
  submittedAt: string
}

/** A PR's identity: numbers are only unique within one repository. */
export interface PRRef {
  /** `owner/name` */
  repo: string
  number: number
}

export function prKey(ref: PRRef): string {
  return `${ref.repo}#${ref.number}`
}

export interface PR {
  repo: string
  number: number
  title: string
  url: string
  headRefName: string
  createdAt: string
  updatedAt: string
  status: PRStatus
  mergedAt?: string | null
  ciStatus: CIStatus
  humanReviews: ReviewInfo[]
}

export interface ReviewerPR {
  repo: string
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

export const statusOrder: PRStatus[] = [
  "changes_requested",
  "reviewed",
  "waiting_for_review",
  "approved",
  "draft",
  "merged",
]
