import { execFile } from "node:child_process"
import { mkdir, readFile, writeFile, access, chmod, cp, lstat, unlink } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)
export const BUILTIN_HARNESSES = Object.freeze({
  opencode: { key: "opencode", tool: "opencode", displayName: "OpenCode" },
  codex: { key: "codex", tool: "codex", displayName: "Codex", launchArgs: ["--approve-for-me"] },
  claude: { key: "claude", tool: "claude", displayName: "Claude Code" },
  cursor: { key: "cursor", tool: "cursor", displayName: "Cursor" },
})

export function defaultConfigPath() {
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "tars", "config.json")
}

export async function loadHarnessConfig(path = defaultConfigPath()) {
  return normalizeConfig(await readConfig(path))
}

/** Loads device defaults plus a repository's lane-specific configuration. */
export async function loadLaneConfig({ repoPath, configPath }) {
  if (configPath) return loadHarnessConfig(configPath)
  const global = await loadHarnessConfig()
  const project = await readConfig(join(repoPath, ".tars", "config.json"))
  return normalizeConfig({
    ...global,
    ...project,
    defaults: { ...global.defaults, ...project.defaults },
    harnesses: { ...global.harnesses, ...project.harnesses },
    worktreeFiles: project.worktreeFiles ?? global.worktreeFiles,
  })
}

async function readConfig(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"))
  } catch (error) {
    if (error?.code === "ENOENT") return {}
    throw new Error(`Cannot read TARS config ${path}: ${error.message}`)
  }
}

export async function saveHarnessConfig(config, path = defaultConfigPath()) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(normalizeConfig(config), null, 2)}\n`, "utf8")
}

export function normalizeConfig(config = {}) {
  return {
    defaults: { author: config.defaults?.author ?? "opencode", reviewer: config.defaults?.reviewer ?? "codex" },
    harnesses: config.harnesses ?? {},
    worktreeFiles: Array.isArray(config.worktreeFiles) ? config.worktreeFiles : [],
  }
}

export function resolveHarness(config, key) {
  const harness = BUILTIN_HARNESSES[key] ?? config.harnesses?.[key]
  if (!harness?.tool || typeof harness.tool !== "string") throw new Error(`Unknown TARS harness: ${key}`)
  return { key, tool: harness.tool, displayName: harness.displayName ?? key, launchArgs: harness.launchArgs ?? [] }
}

/** Parses the human-readable AoE inventory without assuming a JSON flag. */
export async function installedAoeTools(command = "aoe") {
  const { stdout } = await execFileAsync(command, ["agents"])
  return parseInstalledAoeTools(stdout)
}

export function parseInstalledAoeTools(stdout) {
  const installed = new Set()
  for (const line of stdout.split("\n")) {
    const plain = line.replace(/\x1b\[[0-9;]*m/g, "")
    const match = plain.match(/^\s*✓\s+([a-z0-9_-]+)\s+installed\b/i)
    if (match) installed.add(match[1])
  }
  return installed
}

export async function assertHarnessAvailable(harness, inventory = installedAoeTools()) {
  const installed = await inventory
  if (!installed.has(harness.tool)) throw new Error(`${harness.displayName} (${harness.tool}) is not installed in AoE. Run \`aoe agents\` and configure an installed harness.`)
}

export async function provisionHarnessSkills({ root, harness, worktreePath, force = false }) {
  const sourceRoot = join(root, "skills", "shared")
  const names = ["handoff-review", "issue-kickoff", "address-pr-feedback", "close-issue", "add-to-backlog"]
  if (harness.key === "cursor") {
    if (!worktreePath) return
    const destination = join(worktreePath, ".cursor", "rules", "tars.mdc")
    await installOwnedFile(join(sourceRoot, "cursor.mdc"), destination, force)
    const exclude = join(worktreePath, ".git", "info", "exclude")
    let contents = ""
    try { contents = await readFile(exclude, "utf8") } catch (error) { if (error?.code !== "ENOENT") throw error }
    if (!contents.split("\n").includes(".cursor/rules/tars.mdc")) {
      await mkdir(dirname(exclude), { recursive: true })
      await writeFile(exclude, `${contents}${contents.endsWith("\n") || !contents ? "" : "\n"}.cursor/rules/tars.mdc\n`)
    }
    return
  }
  const base = harness.key === "codex" ? join(homedir(), ".codex", "skills")
    : harness.key === "opencode" ? join(homedir(), ".config", "opencode", "skills")
      : harness.key === "claude" ? join(homedir(), ".claude", "skills") : null
  if (!base) return
  for (const name of names) await installOwnedDirectory(join(sourceRoot, name), join(base, name), force)
}

/** Provision files that must live inside an individual lane worktree. */
export async function provisionWorktreeHarnessRequirements({ root, harness, worktreePath, force = false }) {
  if (harness.key !== "cursor") return
  await provisionHarnessSkills({ root, harness, worktreePath, force })
}

/** Copies configured repository-local files into a newly created lane worktree. */
export async function provisionConfiguredWorktreeFiles({ config, repoPath, worktreePath }) {
  for (const entry of config.worktreeFiles) {
    const { source, destination = source } = typeof entry === "string" ? { source: entry } : entry ?? {}
    if (typeof source !== "string" || typeof destination !== "string" || !source || !destination) {
      throw new Error("Each TARS worktreeFiles entry must be a path or an object with source and destination paths.")
    }
    const sourcePath = safeRelativePath(repoPath, source, "source")
    const destinationPath = safeRelativePath(worktreePath, destination, "destination")
    await mkdir(dirname(destinationPath), { recursive: true })
    await cp(sourcePath, destinationPath, { recursive: true, force: true })
  }
}

/** Installs the TARS controller command independently of a lane worktree. */
export async function provisionTarsCli(root, force = false) {
  const runtime = join(homedir(), ".local", "share", "tars", "review-loop")
  const command = join(homedir(), ".local", "bin", "tars")
  await installOwnedDirectory(join(root, "automations", "review-loop"), runtime, force)
  await installOwnedText(
    `#!/bin/sh\n# tars-owned: true\nexec node ${shellQuote(join(runtime, "cli.mjs"))} "$@"\n`,
    command,
    force,
  )
  await chmod(command, 0o755)
}

/** Installs TARS's writable-but-plan-scoped OpenCode primary agent. */
export async function provisionOpenCodePlanAgent(root, force = false) {
  const source = join(root, "agents", "opencode", "tars-plan.md")
  const destination = join(homedir(), ".config", "opencode", "agents", "tars-plan.md")
  await installOwnedFile(source, destination, force)
}

/** Provisions every TARS requirement for supported harnesses discovered by AoE. */
export async function provisionInstalledHarnesses({ root, installed, force = false }) {
  await provisionTarsCli(root, force)
  const harnesses = Object.values(BUILTIN_HARNESSES).filter((harness) => installed.has(harness.tool))
  await Promise.all(harnesses.map((harness) => provisionHarnessSkills({ root, harness, force })))
  if (harnesses.some((harness) => harness.key === "opencode")) {
    await provisionOpenCodePlanAgent(root, force)
    await removeLegacyOpenCodeCommand()
  }
  return harnesses.map((harness) => harness.key)
}

async function installOwnedDirectory(source, destination, force) {
  let exists = false
  try {
    await lstat(destination)
    exists = true
  } catch (error) {
    if (error?.code !== "ENOENT") throw error
  }
  if (exists) {
    try {
      await access(join(destination, ".tars-owned"))
    } catch (error) {
      if (!force) throw new Error(`${destination} exists but is not TARS-owned; choose another location or use an explicit force option.`)
    }
  }
  await mkdir(destination, { recursive: true })
  await cp(source, destination, { recursive: true, force: true })
  await writeFile(join(destination, ".tars-owned"), "TARS\n")
}

async function installOwnedFile(source, destination, force) {
  try {
    const contents = await readFile(destination, "utf8")
    if (!contents.includes("tars-owned: true") && !force) throw new Error(`${destination} exists but is not TARS-owned.`)
  } catch (error) { if (error?.code !== "ENOENT") throw error }
  await mkdir(dirname(destination), { recursive: true })
  await cp(source, destination, { force: true })
}

async function installOwnedText(contents, destination, force) {
  try {
    const existing = await readFile(destination, "utf8")
    if (!existing.includes("tars-owned: true") && !force) throw new Error(`${destination} exists but is not TARS-owned.`)
  } catch (error) { if (error?.code !== "ENOENT") throw error }
  await mkdir(dirname(destination), { recursive: true })
  await writeFile(destination, contents, "utf8")
}

async function removeLegacyOpenCodeCommand() {
  const destination = join(homedir(), ".config", "opencode", "commands", "tars-build.md")
  try {
    const contents = await readFile(destination, "utf8")
    if (contents.includes("tars-owned: true")) await unlink(destination)
  } catch (error) {
    if (error?.code !== "ENOENT") throw error
  }
}

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\\"'\\\"'")}'`
}

function safeRelativePath(root, path, label) {
  if (isAbsolute(path)) throw new Error(`TARS worktreeFiles ${label} path must be relative: ${path}`)
  const resolved = resolve(root, path)
  const escape = relative(root, resolved).startsWith("..")
  if (escape) throw new Error(`TARS worktreeFiles ${label} path escapes its root: ${path}`)
  return resolved
}
