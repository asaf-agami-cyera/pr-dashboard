import { expect, test } from "bun:test"
import { parseRepos } from "./repos"

test("parseRepos splits comma-separated specs and defaults labels to the repository name", () => {
  expect(parseRepos(["octo-org/api, acme/web-app=web", "a/b"])).toEqual([
    { name: "octo-org/api", label: "api" },
    { name: "acme/web-app", label: "web" },
    { name: "a/b", label: "b" },
  ])
  expect(parseRepos([])).toEqual([])
})

test("parseRepos rejects malformed and duplicate specs", () => {
  expect(() => parseRepos(["api"])).toThrow("Invalid repository")
  expect(() => parseRepos(["a/b="])).toThrow("Invalid repository")
  expect(() => parseRepos(["a/b=x=y"])).toThrow("Invalid repository")
  expect(() => parseRepos(["a/b", "a/b=other"])).toThrow("listed twice")
})
