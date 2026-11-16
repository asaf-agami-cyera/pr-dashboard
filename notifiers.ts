import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

/**
 * macOS takes a notification's icon from the app that posts it, so each kind gets its own copy of
 * terminal-notifier.app with its own bundle ID and icon. `scripts/build-notifiers.ts` builds them.
 */
export type NotifierKind = "approved" | "merged" | "review_requested" | "attention"

export const notifierKinds: NotifierKind[] = ["approved", "merged", "review_requested", "attention"]

export const NOTIFIERS_DIR = join(homedir(), "Applications", "pr-dashboard-notifiers")

/** Bundle IDs and file names allow hyphens but not underscores. */
const slug = (kind: NotifierKind) => kind.replaceAll("_", "-")

export const notifierBundleId = (kind: NotifierKind) => `local.pr-dashboard.notifier.${slug(kind)}`

export const notifierApp = (kind: NotifierKind) => join(NOTIFIERS_DIR, `pr-dashboard-${slug(kind)}.app`)

export const notifierBinary = (kind: NotifierKind) => join(notifierApp(kind), "Contents", "MacOS", "terminal-notifier")

export function missingNotifiers(): NotifierKind[] {
  return notifierKinds.filter((kind) => !existsSync(notifierBinary(kind)))
}
