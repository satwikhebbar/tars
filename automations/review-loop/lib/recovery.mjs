import { readdir } from "node:fs/promises"
import { join } from "node:path"
import {
  classifyEvent,
  compareEvents,
  handoffsFor,
  matchesCurrentIteration,
  ReviewLoopCoordinator,
} from "./coordinator.mjs"
import { readHandoff } from "./handoff.mjs"

const ACTIVE_STATES = new Set(["idle", "waiting"])
const STALE_AFTER_MS = 10 * 60 * 1000
const QUEUE_DIRECTORIES = ["inbox", "in-progress", "done", "archive"]
const PROGRESSING_STATES = new Set(["reviewing", "implementing", "planning"])

/**
 * Evidence-based lane diagnosis. Reads durable handoff files, the persisted
 * lane row, the dispatch journal, and AoE session liveness, then reports the
 * single next action -- or why none can be taken. Never sends or mutates.
 */
export async function analyzeLane({ aoe, state, worktreePath }) {
  const lane = state.lane(worktreePath)
  if (!lane) throw new Error(`No registered lane for ${worktreePath}.`)
  const handoffs = await handoffsFor(worktreePath)
  const allHandoffs = await readAllHandoffs(worktreePath)
  const events = handoffs.map(classifyEvent).filter(Boolean).sort(compareEvents)
  const dispatched = state.dispatchedEvents(worktreePath)
  const sessions = await aoe.listSessions()
  const runtime = await aoe.runtimeSessions({ includeDead: true })
  const opencode = sessionInfo(sessions, runtime, lane.opencodeSessionId)
  const codex = sessionInfo(sessions, runtime, lane.codexSessionId)

  const analysis = {
    worktreePath,
    lane,
    sessions: { opencode, codex },
    verdict: null,
    reasons: [],
    nextEvent: null,
    nextTarget: null,
    pending: [],
    unconfirmed: [],
  }
  const finish = (verdict, reason) => {
    analysis.verdict = verdict
    analysis.reasons.push(reason)
    return analysis
  }

  if (lane.state === "blocked") return finish("blocked", "lane state is blocked")
  if (lane.state === "approved" && !events.some((event) => event.reopensLane)) {
    return finish("no_action", "delivery complete: approved lane has no pending reopen")
  }

  const missing = []
  if (!opencode.exists) missing.push("opencode")
  if (!codex.exists) missing.push("codex")
  if (missing.length)
    return finish("sessions_missing", `registered ${missing.join(" and ")} session no longer exists in AoE`)

  const inactive = [
    ["opencode", opencode],
    ["codex", codex],
  ].filter(([, info]) => info.exists && (info.activity === "dead" || info.activity === "unknown"))
  if (inactive.length) {
    const detail = inactive.map(([role, info]) => `${role} session is ${info.activity}`).join(" and ")
    return finish("inactive_sessions", detail)
  }

  const overLimit = events.filter(
    (event) => !dispatched.has(event.key) && event.round > lane.maxRounds && matchesCurrentIteration(lane, event),
  )
  if (overLimit.length) return finish("blocked", `undispatched event exceeds max_rounds ${lane.maxRounds}`)

  const pending = events.filter(
    (event) =>
      !dispatched.has(event.key) &&
      !(lane.state === "approved" && !event.reopensLane) &&
      matchesCurrentIteration(lane, event) &&
      event.round <= lane.maxRounds,
  )
  analysis.pending = pending

  if (pending.length > 1) {
    return finish(
      "ambiguous",
      `${pending.length} actionable pending events: ${pending.map((event) => event.key).join(", ")}`,
    )
  }
  if (pending.length === 1) {
    return pendingVerdict(
      analysis,
      lane,
      pending[0],
      targetSession(lane, pending[0]) === lane.codexSessionId ? codex : opencode,
      dispatched,
    )
  }

  if (lane.phase === "compacting") {
    return finish("in_flight", "plan-to-build compact transition is in progress")
  }

  const unconfirmed = events.filter((event) => dispatched.has(event.key) && !hasAdvancement(allHandoffs, event))
  analysis.unconfirmed = unconfirmed

  if (unconfirmed.length > 1) {
    return finish(
      "ambiguous",
      `${unconfirmed.length} recorded deliveries lack confirmation: ${unconfirmed.map((event) => event.key).join(", ")}`,
    )
  }
  if (unconfirmed.length === 1) {
    return pendingVerdict(
      analysis,
      lane,
      unconfirmed[0],
      targetSession(lane, unconfirmed[0]) === lane.codexSessionId ? codex : opencode,
      dispatched,
    )
  }

  const anyBusy = [opencode, codex].some(
    (info) => info.exists && info.activity !== "dead" && !ACTIVE_STATES.has(info.activity),
  )
  if (PROGRESSING_STATES.has(lane.state) && anyBusy) {
    return finish("in_flight", `${lane.state} with an active session; waiting for the agent`)
  }
  if (PROGRESSING_STATES.has(lane.state)) {
    return finish("ambiguous", `lane state ${lane.state} but no handoff or session activity evidence`)
  }
  return finish("no_action", "no pending action; awaiting the agent's next handoff")
}

function pendingVerdict(analysis, lane, event, session, dispatched) {
  analysis.nextEvent = event
  analysis.nextTarget = targetSession(lane, event)
  const role = session.id === lane.codexSessionId ? "codex" : "opencode"
  if (!ACTIVE_STATES.has(session.activity)) {
    return { ...analysis, verdict: "in_flight", reasons: [`${role} session is busy (${session.activity})`] }
  }
  if (dispatched.has(event.key)) {
    const recordedAt = Date.parse(dispatched.get(event.key) ?? "")
    const age = Number.isFinite(recordedAt) ? Date.now() - recordedAt : NaN
    if (!Number.isFinite(age) || age >= STALE_AFTER_MS) {
      return {
        ...analysis,
        verdict: "stale_delivery",
        reasons: [`recorded delivery ${event.key} has no advancement and the ${role} session is idle`],
      }
    }
    return {
      ...analysis,
      verdict: "in_flight",
      reasons: [`recorded delivery ${event.key} is recent; waiting on ${role}`],
    }
  }
  return {
    ...analysis,
    verdict: "needs_dispatch",
    reasons: [`one actionable ${event.handoff.metadata.type} event for ${role}`],
  }
}

/**
 * Resumes a lane only on explicit operator intent. Read-only unless `dispatch`
 * or `createSessions` is set, and each flag enables exactly one recovery action
 * only when the evidence supports it.
 */
export async function resumeLane({ aoe, state, worktreePath, dispatch = false, createSessions = false }) {
  let analysis = await analyzeLane({ aoe, state, worktreePath })

  if (createSessions) {
    if (analysis.verdict !== "sessions_missing") {
      throw new Error(
        `Refusing --create-sessions: verdict is ${analysis.verdict}, not sessions_missing. ${analysis.reasons.join("; ")}`,
      )
    }
    await recreateMissingSessions({ aoe, state, lane: analysis.lane })
    analysis = await analyzeLane({ aoe, state, worktreePath })
  }

  if (!dispatch) return { analysis, action: null }

  if (!["needs_dispatch", "stale_delivery"].includes(analysis.verdict)) {
    throw new Error(`Refusing --dispatch: verdict is ${analysis.verdict}. ${analysis.reasons.join("; ")}`)
  }

  if (analysis.verdict === "stale_delivery") {
    state.clearDispatched(worktreePath, analysis.nextEvent.key)
  }

  const coordinator = new ReviewLoopCoordinator({ aoe, state })
  const results = await coordinator.processLane(state.lane(worktreePath))
  if (!results.length) {
    throw new Error(
      `Resume dispatched nothing for ${worktreePath}; re-run without --dispatch to see the current verdict.`,
    )
  }
  return { analysis, action: results[0] }
}

async function recreateMissingSessions({ aoe, state, lane }) {
  const sessions = await aoe.listSessions()
  const suffix = lane.worktreePath.split("/").filter(Boolean).at(-1) ?? "worktree"
  const updated = { ...lane }
  if (!sessions.some((session) => session.id === lane.opencodeSessionId)) {
    const opencode = await aoe.addSession(lane.worktreePath, "opencode", `Review loop OpenCode resume (${suffix})`)
    updated.opencodeSessionId = opencode.id
  }
  if (!sessions.some((session) => session.id === lane.codexSessionId)) {
    const codex = await aoe.addSession(lane.worktreePath, "codex", `Review loop Codex resume (${suffix})`)
    updated.codexSessionId = codex.id
  }
  state.saveLane(updated)
}

function sessionInfo(sessions, runtime, sessionId) {
  const exists = sessions.some((session) => session.id === sessionId)
  const entry = runtime.find((entry) => entry.session === sessionId)
  const activity = !exists ? "missing" : entry ? String(entry.state).toLowerCase() : "unknown"
  return { id: sessionId, exists, activity, substrate: entry?.substrate }
}

function targetSession(lane, event) {
  if (event.destination === "terminal") return lane.opencodeSessionId
  return event.destination === "codex" ? lane.codexSessionId : lane.opencodeSessionId
}

function hasAdvancement(handoffs, event) {
  const { workflow_id, id } = event.handoff.metadata
  return handoffs.some((handoff) => {
    const metadata = handoff.metadata
    if (metadata.id === id) return false
    if (metadata.responds_to === id) return true
    return metadata.workflow_id === workflow_id && Number.isInteger(metadata.round) && metadata.round > event.round
  })
}

async function readAllHandoffs(worktreePath) {
  const root = join(worktreePath, ".agent-handoff")
  const files = []
  for (const directory of QUEUE_DIRECTORIES) {
    try {
      const entries = await readdir(join(root, directory), { withFileTypes: true })
      files.push(
        ...entries
          .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
          .map((entry) => join(root, directory, entry.name)),
      )
    } catch (error) {
      if (error?.code !== "ENOENT") throw error
    }
  }
  const handoffs = await Promise.all(files.map(readHandoff))
  return handoffs.filter(Boolean)
}

/** Renders a one-glance, greppable diagnosis for the CLI. */
export function formatAnalysis(analysis) {
  const { lane, sessions } = analysis
  const iteration = lane.iterationCount > 1 ? `, iteration ${lane.currentIteration}/${lane.iterationCount}` : ""
  const lines = [
    `Worktree: ${analysis.worktreePath}`,
    `State:    ${lane.state} (phase ${lane.phase}${iteration})`,
    `Sessions: opencode ${sessions.opencode.id} [${sessions.opencode.activity}]`,
    `          codex ${sessions.codex.id} [${sessions.codex.activity}]`,
    `Verdict:  ${analysis.verdict}`,
  ]
  for (const reason of analysis.reasons) lines.push(`  reason: ${reason}`)
  if (analysis.nextEvent) {
    lines.push(`Next:     ${analysis.nextEvent.key} -> ${analysis.nextTarget} [${analysis.nextEvent.destination}]`)
  }
  return lines.join("\n")
}
