export interface RepoConfig {
  /** `owner/name` */
  name: string
  /** Short tag shown on each row when more than one repository is tracked. */
  label: string
}

const REPO_NAME = /^[^/\s=]+\/[^/\s=]+$/

/**
 * Parses repository specs of the form `owner/name` or `owner/name=label`. Each value may hold
 * several comma-separated specs. The label defaults to the repository name without its owner.
 */
export function parseRepos(values: string[]): RepoConfig[] {
  const repos: RepoConfig[] = []
  for (const spec of values.flatMap((v) => v.split(","))) {
    const trimmed = spec.trim()
    if (!trimmed) continue
    const [name = "", label, ...rest] = trimmed.split("=").map((part) => part.trim())
    if (!REPO_NAME.test(name) || rest.length > 0 || label === "") {
      throw new Error(`Invalid repository "${trimmed}". Use owner/name or owner/name=label.`)
    }
    if (repos.some((r) => r.name === name)) throw new Error(`Repository ${name} is listed twice.`)
    repos.push({ name, label: label ?? name.slice(name.indexOf("/") + 1) })
  }
  return repos
}
