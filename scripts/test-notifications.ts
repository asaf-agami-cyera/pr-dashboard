#!/usr/bin/env bun
/** Posts one clearly labelled test notification per kind, through the same code path as the dashboard. */
import { postNotification, type PRNotification } from "../notifications"
import { missingNotifiers } from "../notifiers"

const url = "https://github.com/pulls"
const tests: PRNotification[] = [
  { kind: "approved", title: "Approved", subtitle: "api#1 · alice approved", message: "Add retries", url, group: "test:approved" },
  { kind: "merged", title: "Merged", subtitle: "api#2", message: "Fix login", url, group: "test:merged" },
  { kind: "review_requested", title: "Review requested", subtitle: "web#3 · by bob", message: "New header", url, group: "test:requested" },
  { kind: "attention", title: "Changes requested", subtitle: "api#4 · carol requested changes", message: "Drop retries", url, group: "test:changes" },
  { kind: "attention", title: "6 PR updates", subtitle: "Review requested, Approved", message: "See the PR dashboard", url, group: "test:summary" },
]

const missing = missingNotifiers()
if (missing.length > 0) console.log(`not installed, using plain terminal-notifier: ${missing.join(", ")}`)
const only = process.argv.slice(2)
for (const n of tests.filter((t) => only.length === 0 || only.includes(t.group.replace("test:", "")))) {
  await postNotification({ ...n, title: `TEST pr-dashboard · ${n.title}` })
  console.log(`posted ${n.kind}: ${n.title}`)
}
