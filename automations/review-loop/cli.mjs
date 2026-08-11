#!/usr/bin/env node
import { execFile } from "node:child_process"
import { mkdtemp, realpath, rm } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { parseArgs, promisify } from "node:util"
import { AoeClient, createPair, discoverPair, validatePair } from "./lib/aoe.mjs"
import { ReviewLoopCoordinator } from "./lib/coordinator.mjs"
import { closeLane, issueOpeningPrompt, planOpeningPrompt, registerLane, startLane, worktreeForIssue } from "./lib/lane.mjs"
import { chooseLanePreflight, fallbackLanePreflight } from "./lib/namer.mjs"
import { StateStore } from "./lib/state.mjs"

const DEFAULT_INTERVAL_MS = 2_000
const DEFAULT_MAX_ROUNDS = 5
const execFileAsync = promisify(execFile)

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
      repo: { type: "string" },
      issue: { type: "string" },
      branch: { type: "string" },
      "worktree-name": { type: "string" },
      prompt: { type: "string" },
      planning: { type: "string" },
      "plan-model": { type: "string" },
      once: { type: "boolean", default: false },
      force: { type: "boolean", default: false },
    },
    allowPositionals: true,
  })
  const command = positionals[0] ?? "help"
  const state = new StateStore(values.state ?? defaultStatePath())
  await state.open()
  try {
    if (command === "start") await start({ values, state })
    else if (command === "watch") await watch({ values, state })
    else if (command === "lane" && positionals[1] === "register") await register({ values, state })
    else if (command === "lane" && positionals[1] === "start") await launch({ values, state })
    else if (command === "lane" && positionals[1] === "close") await close({ values, state })
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
  await watch({ values, state, aoe })
}

async function watch({ values, state, aoe = new AoeClient() }) {
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

async function register({ values, state }) {
  if (!values.worktree) throw new Error("lane register requires --worktree <path>")
  const worktreePath = await realpath(values.worktree)
  const maxRounds = positiveInteger(values["max-rounds"], DEFAULT_MAX_ROUNDS, "--max-rounds")
  const aoe = laneAoe(new AoeClient())
  const pair = await registerLane({ aoe, state, worktreePath, maxRounds, createSessions: values["create-sessions"] })
  console.log(`registered: ${worktreePath}\t${pair.opencodeSessionId}\t${pair.codexSessionId}`)
}

async function launch({ values, state }) {
  if (!values.repo || !values.issue) throw new Error("lane start requires --repo <path> and --issue <number>")
  const issueNumber = positiveInteger(values.issue, undefined, "--issue")
  const repoPath = await realpath(values.repo)
  const issue = await readIssue(repoPath, issueNumber)
  const fallback = fallbackLanePreflight(issue)
  const preflight = values.planning === "always" || values.planning === "never" ? fallback : await chooseLanePreflight(issue, runNamer)
  const planning = resolvePlanning(values.planning, preflight.planning)
  const names = values.branch
    ? { branch: values.branch, worktreeName: values["worktree-name"] ?? fallback.worktreeName }
    : preflight
  const maxRounds = positiveInteger(values["max-rounds"], DEFAULT_MAX_ROUNDS, "--max-rounds")
  const lane = await startLane({
    aoe: laneAoe(new AoeClient()),
    state,
    repoPath,
    issue,
    branch: names.branch,
    worktreeName: values["worktree-name"] ?? names.worktreeName,
    maxRounds,
    planning,
    planModel: values["plan-model"],
    openingPrompt: values.prompt ?? (planning === "required" ? planOpeningPrompt(issue) : issueOpeningPrompt(issue)),
  })
  console.log(`started: ${lane.worktreePath}\t${lane.opencodeSessionId}\t${lane.codexSessionId}\t${names.branch}`)
}

async function close({ values, state }) {
  if (values.worktree && values.issue) throw new Error("Specify either --worktree <path> or --issue <number>, not both.")
  if (!values.worktree && !values.issue) throw new Error("lane close requires --worktree <path> or --issue <number>")
  const worktreePath = values.worktree
    ? await realpath(values.worktree)
    : worktreeForIssue(state, positiveInteger(values.issue, undefined, "--issue"))
  await closeLane({ aoe: laneAoe(new AoeClient()), state, worktreePath, force: values.force })
  console.log(`closed: ${worktreePath}`)
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
  node automations/review-loop/cli.mjs start --worktree <path> [--opencode <session-id> --codex <session-id> | --create-sessions] [--once]
  node automations/review-loop/cli.mjs watch [--once]
  node automations/review-loop/cli.mjs lane register --worktree <path> [--create-sessions]
  node automations/review-loop/cli.mjs lane start --repo <path> --issue <number> [--planning auto|always|never] [--plan-model <provider/model>] [--branch <name>] [--worktree-name <name>] [--prompt <text>]
  node automations/review-loop/cli.mjs lane close (--worktree <path> | --issue <number>) [--force]
  node automations/review-loop/cli.mjs status`)
}

function laneAoe(client) {
  return {
    discoverPair: (worktreePath) => discoverPair(client, worktreePath),
    createPair: (worktreePath) => createPair(client, worktreePath),
    findOrCreateWorktreeSession: async (repoPath, branch, title, options) => {
      const existing = await findWorktreeSession(client, repoPath, branch)
      return existing ?? client.createWorktreeSession(repoPath, branch, title, options)
    },
    addSession: (worktreePath, tool, title) => client.addSession(worktreePath, tool, title),
    send: (sessionId, message) => client.send(sessionId, message),
    listSessions: () => client.listSessions(),
    runtimeSessions: (options) => client.runtimeSessions(options),
    removeSession: (sessionId, options) => client.removeSession(sessionId, options),
  }
}

function resolvePlanning(value, suggested) {
  if (value === undefined || value === "auto") return suggested
  if (value === "always") return "required"
  if (value === "never") return "not_required"
  throw new Error("--planning must be auto, always, or never")
}

async function findWorktreeSession(client, repoPath, branch) {
  const sessions = await client.listSessions()
  const normalizedRepoPath = `${repoPath.replace(/\/$/, "")}/`
  const matching = sessions.filter(
    (session) =>
      session.tool === "opencode" &&
      session.worktree?.branch === branch &&
      session.worktree?.main_repo_path === normalizedRepoPath,
  )
  if (matching.length > 1) throw new Error(`Found ${matching.length} existing OpenCode sessions for branch ${branch}.`)
  return matching[0]
}

async function readIssue(repoPath, issueNumber) {
  const { stdout } = await execFileAsync(
    "gh",
    ["issue", "view", String(issueNumber), "--json", "number,title,body,labels,url"],
    { cwd: repoPath },
  )
  const result = JSON.parse(stdout)
  return { ...result, labels: result.labels.map((label) => label.name) }
}

async function runNamer(prompt) {
  const temporaryDirectory = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "tars-lane-namer-"))
  try {
    const { stdout } = await execFileAsync("opencode", ["run", "--pure", "--dir", temporaryDirectory, prompt], {
      timeout: 60_000,
      maxBuffer: 1_000_000,
    })
    return stdout
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true })
  }
}

await main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
