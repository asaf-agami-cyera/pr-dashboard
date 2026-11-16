import { notifierKinds, type NotifierKind } from "./notifiers"

/** One notifier's icon: a glyph drawn on a coloured macOS app-icon tile. */
export interface NotifierIcon {
  /** The app name, shown on the notification and in System Settings → Notifications. */
  name: string
  /** A gallery ID such as `octicons/git-merge`, or a path to an SVG relative to the repo. */
  icon: string
  background: string
  /** Defaults to the config's `foreground`. */
  foreground?: string
}

/** `notifier-icons.json` */
export interface NotifierConfig {
  /** The glyph's size as a fraction of the tile. */
  glyphScale: number
  foreground: string
  notifiers: Record<NotifierKind, NotifierIcon>
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null

function parseNotifierIcon(kind: string, value: unknown): NotifierIcon {
  if (!isRecord(value)) throw new Error(`notifiers.${kind} must be an object`)
  const { name, icon, background, foreground } = value
  if (typeof name !== "string" || typeof icon !== "string" || typeof background !== "string") {
    throw new Error(`notifiers.${kind} needs string "name", "icon" and "background" fields`)
  }
  if (foreground !== undefined && typeof foreground !== "string") throw new Error(`notifiers.${kind}.foreground must be a string`)
  return { name, icon, background, foreground }
}

export function parseNotifierConfig(value: unknown): NotifierConfig {
  if (!isRecord(value)) throw new Error("the config must be an object")
  const { glyphScale, foreground, notifiers } = value
  if (typeof glyphScale !== "number" || typeof foreground !== "string" || !isRecord(notifiers)) {
    throw new Error('the config needs "glyphScale", "foreground" and "notifiers" fields')
  }
  const unknown = Object.keys(notifiers).filter((kind) => !notifierKinds.some((k) => k === kind))
  if (unknown.length > 0) throw new Error(`unknown notifiers: ${unknown.join(", ")} (expected ${notifierKinds.join(", ")})`)
  const icon = (kind: NotifierKind) => parseNotifierIcon(kind, notifiers[kind])
  return {
    glyphScale,
    foreground,
    notifiers: {
      approved: icon("approved"),
      merged: icon("merged"),
      review_requested: icon("review_requested"),
      attention: icon("attention"),
    },
  }
}

export interface IconSet {
  /** Candidate URLs for one icon, tried in order. */
  urls: (name: string) => string[]
  license: string
}

const phosphorWeights = ["thin", "light", "bold", "fill", "duotone"]

/** Where the build script downloads an icon ID's SVG when `icons/<set>/<name>.svg` isn't in the repo yet. */
export const iconSets: Record<string, IconSet> = {
  // Octicons come in 16 and 24 px drawings; prefer the more detailed one.
  octicons: {
    urls: (name) => [24, 16].map((size) => `https://unpkg.com/@primer/octicons@19/build/svg/${name}-${size}.svg`),
    license: "https://unpkg.com/@primer/octicons@19/LICENSE",
  },
  lucide: {
    urls: (name) => [`https://unpkg.com/lucide-static@latest/icons/${name}.svg`],
    license: "https://unpkg.com/lucide-static@latest/LICENSE",
  },
  tabler: {
    urls: (name) =>
      name.endsWith("-filled")
        ? [`https://unpkg.com/@tabler/icons@latest/icons/filled/${name.slice(0, -"-filled".length)}.svg`]
        : [`https://unpkg.com/@tabler/icons@latest/icons/outline/${name}.svg`],
    license: "https://unpkg.com/@tabler/icons@latest/LICENSE",
  },
  // Phosphor names a non-regular weight with a suffix, e.g. `question-fill`.
  phosphor: {
    urls: (name) => {
      const weight = phosphorWeights.find((w) => name.endsWith(`-${w}`)) ?? "regular"
      return [`https://unpkg.com/@phosphor-icons/core@latest/assets/${weight}/${name}.svg`]
    },
    license: "https://unpkg.com/@phosphor-icons/core@latest/LICENSE",
  },
}

export function parseIconId(id: string): { set: string; name: string } | undefined {
  const match = /^([a-z0-9-]+)\/([a-z0-9-]+)$/.exec(id)
  const set = match?.[1]
  const name = match?.[2]
  return set && name ? { set, name } : undefined
}

const attr = (tag: string, name: string) => new RegExp(`\\s${name}\\s*=\\s*"([^"]*)"`).exec(tag)?.[1]

/**
 * Draws an icon set's SVG in `foreground` on a macOS-style tile. The glyph keeps its own fill and
 * stroke settings: filled sets inherit the fill, and outline sets use `currentColor`.
 */
export function tileSvg(glyph: string, options: { background: string; foreground: string; glyphScale: number }): string {
  const source = glyph.replace(/<\?xml[^>]*\?>/g, "").replace(/<!--[\s\S]*?-->/g, "").trim()
  const root = /<svg\b[^>]*>/.exec(source)?.[0]
  if (!root) throw new Error("not an SVG: no <svg> element")

  const width = attr(root, "width")
  const height = attr(root, "height")
  const viewBox = attr(root, "viewBox") ?? (width && height ? `0 0 ${parseFloat(width)} ${parseFloat(height)}` : undefined)
  if (!viewBox) throw new Error("the SVG has neither a viewBox nor a width and height")

  // A macOS app icon is an 824 px rounded square centred on a 1024 px canvas.
  const tile = { x: 100, size: 824, radius: 185 }
  const size = tile.size * options.glyphScale
  const offset = (1024 - size) / 2
  const placed = root
    .replace(/\s(width|height|x|y|class|viewBox)\s*=\s*"[^"]*"/g, "")
    .replace(/^<svg\b/, `<svg x="${offset}" y="${offset}" width="${size}" height="${size}" viewBox="${viewBox}"`)

  return `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <defs>
    <linearGradient id="sheen" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ffffff" stop-opacity="0.22"/>
      <stop offset="1" stop-color="#ffffff" stop-opacity="0"/>
    </linearGradient>
    <filter id="shadow" x="-10%" y="-10%" width="120%" height="125%">
      <feGaussianBlur in="SourceAlpha" stdDeviation="12"/>
      <feOffset dy="10"/>
      <feComponentTransfer><feFuncA type="linear" slope="0.3"/></feComponentTransfer>
      <feMerge><feMergeNode/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
  </defs>
  <g filter="url(#shadow)">
    <rect x="${tile.x}" y="${tile.x}" width="${tile.size}" height="${tile.size}" rx="${tile.radius}" fill="${options.background}"/>
  </g>
  <rect x="${tile.x}" y="${tile.x}" width="${tile.size}" height="${tile.size}" rx="${tile.radius}" fill="url(#sheen)"/>
  <g fill="${options.foreground}" color="${options.foreground}">
    ${source.replace(root, placed)}
  </g>
</svg>
`
}
