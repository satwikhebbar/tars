import { readdir } from "node:fs/promises"
import { join } from "node:path"
import { isWorkflowHandoff, readHandoff } from "./handoff.mjs"

const HANDOFF_DIRECTORIES = ["inbox", "done"]
const ACTIVE_STATES = new Set(["idle", "waiting"])

/** Coordinates one persisted AoE pair per worktree without relying on agmsg delivery. */
export class ReviewLoopCoordinator {
  constructor({ aoe, state }) {
    this.aoe = aoe
    this.state = state
  }

  async processAll() {
    const results = []
    for (const lane of this.state.lanes()) results.push(...(await this.processLane(lane)))
    return results
  }

  async processLane(lane) {
    if (lane.state === "approved" || lane.state === "blocked") return []
    const sessions = await this.aoe.runningSessions()
    const states = new Map(sessions.map((session) => [session.session, session.state]))
    const handoffs = await handoffsFor(lane.worktreePath)
    const events = handoffs.map(classifyEvent).filter(Boolean).sort(compareEvents)
    const results = []
    for (const event of events) {
      if (event.round > lane.maxRounds) {
        this.state.saveLane({ ...lane, state: "blocked" })
        results.push({ event, action: "blocked", reason: "max_rounds" })
        break
      }
      if (this.state.hasDispatched(lane.worktreePath, event.key)) continue
      if (event.destination === "terminal") {
        this.state.markDispatched(lane.worktreePath, event.key)
        this.state.saveLane({ ...lane, state: event.outcome })
        results.push({ event, action: event.outcome })
        break
      }
      const sessionId = event.destination === "codex" ? lane.codexSessionId : lane.opencodeSessionId
      if (!ACTIVE_STATES.has(String(states.get(sessionId)).toLowerCase())) continue
      await this.aoe.send(sessionId, promptFor(event))
      this.state.markDispatched(lane.worktreePath, event.key)
      this.state.saveLane({ ...lane, state: event.destination === "codex" ? "reviewing" : "implementing" })
      results.push({ event, action: `sent:${event.destination}` })
      break
    }
    return results
  }
}

/** Reads active handoffs only; archived history is never re-dispatched. */
export async function handoffsFor(worktreePath) {
  const root = join(worktreePath, ".agent-handoff")
  const files = []
  for (const directory of HANDOFF_DIRECTORIES) {
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
  return handoffs.filter((handoff) => handoff && isWorkflowHandoff(handoff))
}

function classifyEvent(handoff) {
  const { metadata } = handoff
  if (metadata.type === "implementation-response" && typeof metadata.head_commit === "string") {
    return {
      key: `implementation:${metadata.id}:${metadata.head_commit}`,
      handoff,
      round: metadata.round,
      destination: "codex",
    }
  }
  if (metadata.type === "code-review" && typeof metadata.outcome === "string") {
    if (metadata.outcome === "approved" || metadata.outcome === "blocked") {
      return {
        key: `review:${metadata.id}:${metadata.outcome}`,
        handoff,
        round: metadata.round,
        destination: "terminal",
        outcome: metadata.outcome,
      }
    }
    if (metadata.outcome === "changes_requested") {
      return { key: `review:${metadata.id}:changes_requested`, handoff, round: metadata.round, destination: "opencode" }
    }
  }
  return null
}

function compareEvents(left, right) {
  return left.round - right.round || left.key.localeCompare(right.key)
}

function promptFor(event) {
  const path = event.handoff.path
  if (event.destination === "codex") {
    return `Review-loop: read ${path}, review immutable commit ${event.handoff.metadata.head_commit}, then write one code-review handoff with workflow_id ${event.handoff.metadata.workflow_id}, round ${event.round}, and outcome approved, changes_requested, or blocked. Do not edit implementation files.`
  }
  return `Review-loop: read ${path}, apply the requested review changes, validate them, commit the result, then write one implementation-response handoff with workflow_id ${event.handoff.metadata.workflow_id}, round ${event.round + 1}, and head_commit. Do not request a manual handoff.`
}
