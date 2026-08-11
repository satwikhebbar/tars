import { readdir } from "node:fs/promises"
import { join } from "node:path"
import { isWorkflowHandoff, readHandoff } from "./handoff.mjs"

const HANDOFF_DIRECTORIES = ["inbox", "done"]
const ACTIVE_STATES = new Set(["idle", "waiting"])

/** Coordinates one persisted AoE pair per worktree through durable handoff files. */
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
        if (event.outcome === "approved") {
          const sessionId = lane.opencodeSessionId
          if (!ACTIVE_STATES.has(String(states.get(sessionId)).toLowerCase())) continue
          await this.aoe.send(sessionId, promptFor(event))
        }
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
  if (metadata.type === "plan-review" && metadata.created_by === "opencode" && !metadata.outcome) {
    return {
      key: `plan:${metadata.id}`,
      handoff,
      round: metadata.round,
      destination: "codex",
      reviewKind: "plan",
    }
  }
  if (metadata.type === "plan-review-verdict" && typeof metadata.outcome === "string") {
    if (metadata.outcome === "blocked") {
      return {
        key: `plan-verdict:${metadata.id}:blocked`,
        handoff,
        round: metadata.round,
        destination: "terminal",
        outcome: "blocked",
      }
    }
    if (metadata.outcome === "approved" || metadata.outcome === "changes_requested") {
      return {
        key: `plan-verdict:${metadata.id}:${metadata.outcome}`,
        handoff,
        round: metadata.round,
        destination: "opencode",
        outcome: metadata.outcome,
        reviewKind: "plan",
      }
    }
  }
  if (metadata.type === "implementation-response" && typeof metadata.head_commit === "string") {
    return {
      key: `implementation:${metadata.id}:${metadata.head_commit}`,
      handoff,
      round: metadata.round,
      destination: "codex",
      reviewKind: "code",
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
  if (event.destination === "codex" && event.reviewKind === "plan") {
    return `Review-loop: use the handoff-review skill. Read ${path} and review the requested plan artifact. Write exactly one plan-review-verdict handoff in the lane inbox with workflow_id ${event.handoff.metadata.workflow_id}, round ${event.round}, responds_to ${event.handoff.metadata.id}, and outcome approved, changes_requested, or blocked. Do not implement the plan or edit implementation files.`
  }
  if (event.destination === "codex") {
    return `Review-loop: use the handoff-review skill. Read ${path}, review immutable commit ${event.handoff.metadata.head_commit}, then write one code-review handoff with workflow_id ${event.handoff.metadata.workflow_id}, round ${event.round}, and outcome approved, changes_requested, or blocked. Do not edit implementation files.`
  }
  if (event.destination === "terminal" && event.outcome === "approved") {
    return `Review-loop: the handoff review is approved and complete. Read ${path}, record the approved review using the handoff-review protocol, then push the approved branch to its configured remote and create a pull request. Report the remote branch and PR URL when finished. Do not make implementation changes unless needed to resolve a push or PR blocker.`
  }
  if (event.destination === "opencode" && event.reviewKind === "plan") {
    if (event.outcome === "approved") {
      return `Review-loop: the plan review is approved. Read ${path}, record the approved plan-review verdict using the handoff protocol, then begin implementation from the approved plan. When implementation is committed and verified, publish an implementation-response with workflow_id ${event.handoff.metadata.workflow_id}. Do not push or create a pull request yet.`
    }
    return `Review-loop: read ${path}, revise the plan to address the requested changes, validate the revised plan, then publish one plan-review handoff with workflow_id ${event.handoff.metadata.workflow_id} and round ${event.round + 1}. Do not begin implementation until the plan review is approved.`
  }
  return `Review-loop: read ${path}, apply the requested review changes, validate them, commit the result, then write one implementation-response handoff with workflow_id ${event.handoff.metadata.workflow_id}, round ${event.round + 1}, and head_commit. Do not request a manual handoff.`
}
