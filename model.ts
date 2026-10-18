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

export interface PR {
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
