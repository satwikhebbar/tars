#!/usr/bin/env node
import { cp, lstat, mkdir, rm } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { parseArgs } from "node:util"

const COMMANDS_ROOT = dirname(fileURLToPath(import.meta.url))

async function main() {
  const { positionals, values } = parseArgs({
    args: process.argv.slice(2),
    options: { "opencode-home": { type: "string" }, force: { type: "boolean", default: false } },
    allowPositionals: true,
  })
  const [agent, command] = positionals
  if (agent !== "opencode" || !command) return usage()
  const source = join(COMMANDS_ROOT, agent, `${command}.md`)
  const destination = join(values["opencode-home"] ?? join(homedir(), ".config", "opencode"), "commands", `${command}.md`)
  await assertFile(source, `Unknown OpenCode command: ${command}`)
  try {
    await lstat(destination)
    if (!values.force) throw new Error(`${destination} already exists; re-run with --force to replace it.`)
    await rm(destination, { force: true })
  } catch (error) {
    if (error?.code !== "ENOENT") throw error
  }
  await mkdir(dirname(destination), { recursive: true })
  await cp(source, destination)
  console.log(`Installed opencode/${command} → ${destination}`)
}

async function assertFile(path, message) {
  try {
    if (!(await lstat(path)).isFile()) throw new Error(message)
  } catch (error) {
    if (error?.code === "ENOENT") throw new Error(message)
    throw error
  }
}

function usage() {
  console.log("Usage: node commands/install.mjs opencode <command> [--opencode-home <path>] [--force]")
}

await main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
