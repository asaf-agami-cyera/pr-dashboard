import { describe, expect, test } from "bun:test"
import { iconSets, parseIconId, parseNotifierConfig, tileSvg } from "./icon-tile"

const options = { background: "#8250df", foreground: "#ffffff", glyphScale: 0.5 }

describe("tileSvg", () => {
  test("places a filled glyph in the middle of the tile and inherits the foreground fill", () => {
    const svg = tileSvg('<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><path d="M0 0h24v24H0z"/></svg>', options)
    expect(svg).toContain('<svg x="306" y="306" width="412" height="412" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M0 0h24v24H0z"/></svg>')
    expect(svg).toContain('<g fill="#ffffff" color="#ffffff">')
    expect(svg).toContain('fill="#8250df"')
  })

  test("keeps an outline glyph's own fill and stroke, and drops comments and its class", () => {
    const lucide = `<!-- @license lucide-static - ISC -->
<svg
  class="lucide lucide-circle-help"
  xmlns="http://www.w3.org/2000/svg"
  width="24"
  height="24"
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
>
  <circle cx="12" cy="12" r="10" />
</svg>`
    const svg = tileSvg(lucide, options)
    expect(svg).not.toContain("@license")
    expect(svg).not.toContain("lucide-circle-help")
    expect(svg).toContain('fill="none"')
    expect(svg).toContain('stroke="currentColor"')
  })

  test("derives a viewBox from the size, and rejects anything else", () => {
    expect(tileSvg('<svg width="16px" height="16px"><path d="M0 0"/></svg>', options)).toContain('viewBox="0 0 16 16"')
    expect(() => tileSvg("<svg><path/></svg>", options)).toThrow("viewBox")
    expect(() => tileSvg("<png/>", options)).toThrow("not an SVG")
  })
})

describe("icon IDs", () => {
  test("parse as set/name", () => {
    expect(parseIconId("octicons/git-merge")).toEqual({ set: "octicons", name: "git-merge" })
    expect(parseIconId("icons/a/b.svg")).toBeUndefined()
    expect(parseIconId("git-merge")).toBeUndefined()
  })

  test("map to each set's download URLs", () => {
    expect(iconSets.octicons?.urls("check")).toEqual([
      "https://unpkg.com/@primer/octicons@19/build/svg/check-24.svg",
      "https://unpkg.com/@primer/octicons@19/build/svg/check-16.svg",
    ])
    expect(iconSets.tabler?.urls("circle-check-filled")).toEqual(["https://unpkg.com/@tabler/icons@latest/icons/filled/circle-check.svg"])
    expect(iconSets.phosphor?.urls("question-fill")).toEqual(["https://unpkg.com/@phosphor-icons/core@latest/assets/fill/question-fill.svg"])
    expect(iconSets.phosphor?.urls("question")).toEqual(["https://unpkg.com/@phosphor-icons/core@latest/assets/regular/question.svg"])
  })
})

describe("parseNotifierConfig", () => {
  const icon = { name: "PR", icon: "octicons/check", background: "#000" }
  const notifiers = { approved: icon, merged: icon, review_requested: icon, attention: icon }

  test("accepts the repo's config", async () => {
    const config = parseNotifierConfig(await Bun.file(`${import.meta.dir}/notifier-icons.json`).json())
    expect(config.notifiers.merged.icon).toBe("octicons/git-merge")
  })

  test("names what is missing or unknown", () => {
    expect(() => parseNotifierConfig({ glyphScale: 0.5, foreground: "#fff", notifiers: { ...notifiers, merged: undefined } })).toThrow("notifiers.merged")
    expect(() => parseNotifierConfig({ glyphScale: 0.5, foreground: "#fff", notifiers: { ...notifiers, summary: icon } })).toThrow("unknown notifiers: summary")
  })
})
