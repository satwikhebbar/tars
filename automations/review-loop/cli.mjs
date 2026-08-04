#!/usr/bin/env node
import { realpath } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { parseArgs } from "node:util"
import { AoeClient, createPair, discoverPair, validatePair } from "./lib/aoe.mjs"
import { ReviewLoopCoordinator } from "./lib/coordinator.mjs"
import { StateStore } from "./lib/state.mjs"

const DEFAULT_INTERVAL_MS = 2_000
const DEFAULT_MAX_ROUNDS = 5

async function main() {
  const { positionals, values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      worktree: { type: "string" },
      opencode: { type: "string" },
      codex: { type: "string" },
      state: { type: "string" },
      interval: { type: "string" },
      "max-rounds": { type: "string" },
      "create-sessions": { type: "boolean", default: false },
      once: { type: "boolean", default: false },
    },
    allowPositionals: true,
  })
  const command = positionals[0] ?? "help"
  const state = new StateStore(values.state ?? defaultStatePath())
  await state.open()
  try {
    if (command === "start") await start({ values, state })
    else if (command === "status") printStatus(state)
    else printUsage()
  } finally {
    state.close()
  }
}

async function start({ values, state }) {
  if (!values.worktree) throw new Error("start requires --worktree <path>")
  const worktreePath = await realpath(values.worktree)
  const aoe = new AoeClient()
  const selectedPair = await selectPair(aoe, worktreePath, values)
  const pair = await validatePair(aoe, worktreePath, selectedPair)
  const maxRounds = positiveInteger(values["max-rounds"], DEFAULT_MAX_ROUNDS, "--max-rounds")
  state.saveLane({ worktreePath, ...pair, state: "watching", maxRounds })
  const coordinator = new ReviewLoopCoordinator({ aoe, state })
  const interval = positiveInteger(values.interval, DEFAULT_INTERVAL_MS, "--interval")
  const processOnce = async () => {
    const results = await coordinator.processAll()
    for (const result of results) console.log(`${result.action}: ${result.event.handoff.metadata.id}`)
  }
  await processOnce()
  if (values.once) return
  await waitForInterrupt(processOnce, interval)
}

async function selectPair(aoe, worktreePath, values) {
  if (values.opencode && values.codex) return { opencodeSessionId: values.opencode, codexSessionId: values.codex }
  if (values.opencode || values.codex) throw new Error("Specify both --opencode and --codex, or neither.")
  try {
    return await discoverPair(aoe, worktreePath)
  } catch (error) {
    if (!values["create-sessions"]) throw error
    return createPair(aoe, worktreePath)
  }
}

function printStatus(state) {
  for (const lane of state.lanes())
    console.log(`${lane.worktreePath}\t${lane.state}\t${lane.opencodeSessionId}\t${lane.codexSessionId}`)
}

function defaultStatePath() {
  const stateHome = process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state")
  return join(stateHome, "agent-review-loop", "state.sqlite")
}

function positiveInteger(value, fallback, name) {
  if (value === undefined) return fallback
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`)
  return parsed
}

async function waitForInterrupt(tick, interval) {
  await new Promise((resolve) => {
    const timer = setInterval(() => {
      void tick().catch((error) => console.error(error instanceof Error ? error.message : error))
    }, interval)
    process.once("SIGINT", () => {
      clearInterval(timer)
      resolve()
    })
  })
}

function printUsage() {
  console.log(`Usage:
  node tools/agent-review-loop/cli.mjs start --worktree <path> [--opencode <session-id> --codex <session-id> | --create-sessions] [--once]
  node tools/agent-review-loop/cli.mjs status`)
}

await main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
