#!/usr/bin/env node
import { lstat } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { parseArgs } from "node:util"
import { BUILTIN_HARNESSES, provisionHarnessSkills } from "../automations/review-loop/lib/harnesses.mjs"

const SKILLS_ROOT = dirname(fileURLToPath(import.meta.url))

async function main() {
  const { positionals, values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      worktree: { type: "string" },
      force: { type: "boolean", default: false },
    },
    allowPositionals: true,
  })
  const [agent, skill] = positionals
  if (!agent || !skill || !BUILTIN_HARNESSES[agent]) return usage()

  const source = join(SKILLS_ROOT, "shared", skill)
  await assertDirectory(source, `Unknown shared TARS skill: ${skill}`)
  await provisionHarnessSkills({ root: dirname(SKILLS_ROOT), harness: BUILTIN_HARNESSES[agent], worktreePath: values.worktree, force: values.force })
  console.log(`Installed shared TARS skills for ${agent}`)
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
  node skills/install.mjs <opencode|codex|claude|cursor> <skill> [--worktree <path>] [--force]`)
}

await main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
