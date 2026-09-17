/**
 * Run dsh's own Typert manifest validator against a built `./typert` artifact.
 *
 * `dsh-typert-loader` refuses to register a strict codec without a `create()`
 * factory, and one refused contributor aborts the entire plugin tree, so that
 * regression turns into `dsh web` failing to boot. This check runs the real
 * validator locally instead of trusting a hand-written shape assertion.
 *
 * The validator ships inside the installed `dsh` CLI, so this check is a
 * developer convenience: when no dsh installation is reachable it reports that
 * it skipped and exits 0, keeping `pnpm test` usable on a clean checkout.
 *
 * Usage: node scripts/check-typert-manifest.mjs [path-to-typert.host.js]
 */

import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { existsSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'

const DEFAULT_ARTIFACT = 'lib/typert.host.js'
const artifact = resolve(process.argv[2] ?? DEFAULT_ARTIFACT)

if (!existsSync(artifact)) {
  console.error(`check-typert-manifest: ${artifact} does not exist — run \`pnpm build\` first`)
  process.exit(2)
}

/** Every package.json whose resolution could reach the dsh CLI's loader. */
function resolutionRoots() {
  const roots = [import.meta.url]
  const dshHome = process.env.DSH_HOME ?? resolve(homedir(), '.dsh')
  const profiles = resolve(dshHome, 'profiles')
  if (existsSync(profiles)) {
    for (const profile of readdirSync(profiles)) {
      roots.push(pathToFileURL(resolve(profiles, profile, 'package.json')).href)
    }
  }
  return roots
}

let loader
for (const from of resolutionRoots()) {
  try {
    loader = createRequire(from).resolve('@deepseek-ai/dsh-typert-loader')
    break
  } catch {
    // Try the next candidate root.
  }
}

if (loader === undefined) {
  console.log('check-typert-manifest: skipped — no dsh installation found to borrow the validator from')
  process.exit(0)
}

const { validateTypertManifest } = await import(pathToFileURL(loader).href)
const manifest = (await import(pathToFileURL(artifact).href)).default

try {
  const validated = validateTypertManifest(manifest.package, manifest)
  const subjects = validated.invocations.flatMap((invocation) => [
    ...invocation.parameters.map((parameter) => `${invocation.id} parameter ${parameter.name}`),
    `${invocation.id} result codec`,
  ])
  console.log(`check-typert-manifest: PASS ${artifact}`)
  for (const subject of subjects) console.log(`  - ${subject}`)
} catch (error) {
  console.error(`check-typert-manifest: FAIL ${artifact}`)
  console.error(`  ${error.message}`)
  process.exit(1)
}
