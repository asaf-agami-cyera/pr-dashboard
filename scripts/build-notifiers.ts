#!/usr/bin/env bun
/**
 * Builds one copy of terminal-notifier.app per notification kind, each with its own bundle ID and
 * icon, from notifier-icons.json. Run it again after changing an icon: `bun run build-notifiers`.
 */
import { $ } from "bun"
import { existsSync, mkdirSync, rmSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { iconSets, parseIconId, parseNotifierConfig, tileSvg, type NotifierIcon } from "../icon-tile"
import { NOTIFIERS_DIR, notifierApp, notifierBundleId, notifierKinds } from "../notifiers"

const repo = resolve(import.meta.dir, "..")
const buildDir = join(repo, "build", "notifiers")
const lsregister = "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"

async function sourceApp(): Promise<string> {
  const app = process.env.TERMINAL_NOTIFIER_APP ?? join((await $`brew --prefix terminal-notifier`.text()).trim(), "terminal-notifier.app")
  if (!existsSync(join(app, "Contents", "Info.plist"))) {
    throw new Error(`no terminal-notifier.app at ${app}; brew install terminal-notifier, or set TERMINAL_NOTIFIER_APP`)
  }
  return app
}

async function download(url: string, path: string): Promise<boolean> {
  const response = await fetch(url)
  if (!response.ok) return false
  mkdirSync(dirname(path), { recursive: true })
  await Bun.write(path, await response.text())
  return true
}

/** Resolves an icon ID to its SVG under icons/, downloading it (and its set's licence) the first time. */
async function glyphPath(icon: string): Promise<string> {
  if (icon.endsWith(".svg")) return resolve(repo, icon)
  const id = parseIconId(icon)
  if (!id) throw new Error(`"${icon}" is neither an SVG path nor an icon ID like octicons/git-merge`)
  const path = join(repo, "icons", id.set, `${id.name}.svg`)
  if (existsSync(path)) return path

  const set = iconSets[id.set]
  if (!set) throw new Error(`${icon}: add icons/${id.set}/${id.name}.svg, or use one of these sets: ${Object.keys(iconSets).join(", ")}`)
  let found = false
  for (const url of set.urls(id.name)) {
    found = await download(url, path)
    if (found) break
  }
  if (!found) throw new Error(`${icon}: not found at ${set.urls(id.name).join(" or ")}`)
  const license = join(repo, "icons", id.set, "LICENSE")
  if (!existsSync(license) && !(await download(set.license, license))) throw new Error(`${icon}: no licence at ${set.license}`)
  console.log(`downloaded ${icon} to ${path}`)
  return path
}

async function buildIcns(svg: string, workDir: string): Promise<string> {
  const iconset = join(workDir, "icon.iconset")
  rmSync(iconset, { recursive: true, force: true })
  mkdirSync(iconset, { recursive: true })
  const tile = join(workDir, "tile.svg")
  await Bun.write(tile, svg)
  for (const size of [16, 32, 128, 256, 512]) {
    await $`rsvg-convert -w ${size} -h ${size} ${tile} -o ${join(iconset, `icon_${size}x${size}.png`)}`
    await $`rsvg-convert -w ${size * 2} -h ${size * 2} ${tile} -o ${join(iconset, `icon_${size}x${size}@2x.png`)}`
  }
  const icns = join(workDir, "icon.icns")
  await $`iconutil --convert icns ${iconset} --output ${icns}`
  return icns
}

async function buildApp(source: string, app: string, bundleId: string, icon: NotifierIcon, icns: string) {
  rmSync(app, { recursive: true, force: true })
  await $`ditto ${source} ${app}`
  const resources = join(app, "Contents", "Resources")
  rmSync(join(resources, "Terminal.icns"), { force: true })
  await $`cp ${icns} ${join(resources, "icon.icns")}`
  const plist = join(app, "Contents", "Info.plist")
  await $`/usr/libexec/PlistBuddy -c ${"Set :CFBundleIconFile icon"} -c ${`Set :CFBundleName ${icon.name}`} -c ${`Set :CFBundleIdentifier ${bundleId}`} ${plist}`
  await $`/usr/libexec/PlistBuddy -c ${"Delete :CFBundleDisplayName"} ${plist}`.nothrow().quiet()
  await $`/usr/libexec/PlistBuddy -c ${`Add :CFBundleDisplayName string ${icon.name}`} ${plist}`
  await $`codesign --force --sign - ${app}`.quiet()
  // Registering refreshes the icon LaunchServices and Notification Center have cached for this bundle ID.
  await $`${lsregister} -f ${app}`
}

const config = parseNotifierConfig(await Bun.file(join(repo, "notifier-icons.json")).json())
for (const tool of ["rsvg-convert", "iconutil", "codesign", "ditto"]) {
  if (!Bun.which(tool)) throw new Error(`${tool} not found${tool === "rsvg-convert" ? " (brew install librsvg)" : ""}`)
}
const source = await sourceApp()
mkdirSync(NOTIFIERS_DIR, { recursive: true })

for (const kind of notifierKinds) {
  const icon = config.notifiers[kind]
  const workDir = join(buildDir, kind)
  mkdirSync(workDir, { recursive: true })
  const svg = tileSvg(await Bun.file(await glyphPath(icon.icon)).text(), {
    background: icon.background,
    foreground: icon.foreground ?? config.foreground,
    glyphScale: config.glyphScale,
  })
  const icns = await buildIcns(svg, workDir)
  await $`cp ${join(workDir, "icon.iconset", "icon_256x256@2x.png")} ${join(buildDir, `${kind}.png`)}`
  const app = notifierApp(kind)
  await buildApp(source, app, notifierBundleId(kind), icon, icns)
  console.log(`${kind}: ${icon.icon} → ${app} (${notifierBundleId(kind)})`)
}
console.log(`previews in ${buildDir}`)
