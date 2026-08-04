#!/usr/bin/env node
import { cp, lstat, mkdir, rm } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { parseArgs } from "node:util"

const SKILLS_ROOT = dirname(fileURLToPath(import.meta.url))

async function main() {
  const { positionals, values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      worktree: { type: "string" },
      "codex-home": { type: "string" },
      force: { type: "boolean", default: false },
    },
    allowPositionals: true,
  })
  const [agent, skill] = positionals
  if (!agent || !skill || !["codex", "opencode"].includes(agent)) return usage()

  const source = join(SKILLS_ROOT, agent, skill)
  await assertDirectory(source, `Unknown ${agent} skill: ${skill}`)
  const destination = destinationFor(agent, skill, values)
  await install(source, destination, values.force)
  console.log(`Installed ${agent}/${skill} → ${destination}`)
}

function destinationFor(agent, skill, values) {
  if (agent === "codex") return join(values["codex-home"] ?? join(homedir(), ".codex"), "skills", skill)
  if (!values.worktree) throw new Error("OpenCode installation requires --worktree <path>")
  return join(resolve(values.worktree), ".opencode", "skills", skill)
}

async function install(source, destination, force) {
  try {
    await lstat(destination)
    if (!force) throw new Error(`${destination} already exists; re-run with --force to replace it.`)
    await rm(destination, { recursive: true, force: true })
  } catch (error) {
    if (error?.code !== "ENOENT") throw error
  }
  await mkdir(dirname(destination), { recursive: true })
  await cp(source, destination, { recursive: true })
}

async function assertDirectory(path, message) {
  try {
    if (!(await lstat(path)).isDirectory()) throw new Error(message)
  } catch (error) {
    if (error?.code === "ENOENT") throw new Error(message)
    throw error
  }
}

function usage() {
  console.log(`Usage:
  node skills/install.mjs codex <skill> [--codex-home <path>] [--force]
  node skills/install.mjs opencode <skill> --worktree <path> [--force]`)
}

await main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
