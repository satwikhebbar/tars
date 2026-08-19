#!/usr/bin/env node
import { cp, lstat, mkdir, rm } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { parseArgs } from "node:util"

const ROOT = dirname(fileURLToPath(import.meta.url))
const DEFAULT_SKILLS = [
  ["codex", "handoff-review"],
  ["codex", "add-to-backlog"],
  ["opencode", "handoff-review"],
  ["opencode", "issue-kickoff"],
  ["opencode", "address-pr-feedback"],
]
const DEFAULT_COMMANDS = [["opencode", "tars-build"]]

async function main() {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      "codex-home": { type: "string" },
      "opencode-home": { type: "string" },
      "dry-run": { type: "boolean", default: false },
    },
  })

  for (const [agent, skill] of DEFAULT_SKILLS) {
    const source = join(ROOT, "skills", agent, skill)
    const destination = skillDestination(agent, skill, values)
    await assertDirectory(source, `Missing bundled ${agent} skill: ${skill}`)
    await install(source, destination, values)
  }
  for (const [agent, command] of DEFAULT_COMMANDS) {
    const source = join(ROOT, "commands", agent, `${command}.md`)
    const destination = join(values["opencode-home"] ?? join(homedir(), ".config", "opencode"), "commands", `${command}.md`)
    await assertFile(source, `Missing bundled ${agent} command: ${command}`)
    await install(source, destination, values)
  }
}

function skillDestination(agent, skill, values) {
  const base = agent === "codex"
    ? values["codex-home"] ?? join(homedir(), ".codex")
    : values["opencode-home"] ?? join(homedir(), ".config", "opencode")
  return join(base, "skills", skill)
}

async function install(source, destination, values) {
  if (values["dry-run"]) return console.log(`Would install ${source} → ${destination}`)
  try {
    await lstat(destination)
    await rm(destination, { recursive: true, force: true })
  } catch (error) {
    if (error?.code !== "ENOENT") throw error
  }
  await mkdir(dirname(destination), { recursive: true })
  await cp(source, destination, { recursive: true })
  console.log(`Installed ${source} → ${destination}`)
}

async function assertDirectory(path, message) {
  try {
    if (!(await lstat(path)).isDirectory()) throw new Error(message)
  } catch (error) {
    if (error?.code === "ENOENT") throw new Error(message)
    throw error
  }
}

async function assertFile(path, message) {
  try {
    if (!(await lstat(path)).isFile()) throw new Error(message)
  } catch (error) {
    if (error?.code === "ENOENT") throw new Error(message)
    throw error
  }
}

await main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
