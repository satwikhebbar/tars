import { access, readdir } from "node:fs/promises"
import { join } from "node:path"
import { isWorkflowHandoff, readHandoff } from "./handoff.mjs"

const HANDOFF_DIRECTORIES = ["inbox", "done"]
const ACTIVE_STATES = new Set(["idle", "waiting"])
const COMPACTION_SETTLE_MS = 2_000

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
    if (lane.state === "blocked") return []
    const handoffs = await handoffsFor(lane.worktreePath)
    const events = handoffs.map(classifyEvent).filter(Boolean).sort(compareEvents)
    // A completed lane is normally immutable. The one explicit exception is
    // a fresh implementation response that declares it is addressing feedback
    // on the lane's already-open pull request.
    if (lane.state === "approved" && !events.some((event) => event.reopensLane)) return []
    const sessions = await this.aoe.runningSessions()
    const states = new Map(sessions.map((session) => [session.session, session.state]))
    const transition = await this.advancePlanTransition(lane, states)
    if (transition) return [transition]
    const results = []
    for (const event of events) {
      if (this.state.hasDispatched(lane.worktreePath, event.key)) continue
      if (lane.state === "approved" && !event.reopensLane) continue
      if (!matchesCurrentIteration(lane, event)) continue
      if (event.round > lane.maxRounds) {
        this.state.saveLane({ ...lane, state: "blocked" })
        results.push({ event, action: "blocked", reason: "max_rounds" })
        break
      }
      if (event.destination === "terminal") {
        if (event.outcome === "approved") {
          const sessionId = lane.opencodeSessionId
          if (!ACTIVE_STATES.has(String(states.get(sessionId)).toLowerCase())) continue
          if (hasNextIteration(lane, event)) {
            const nextIteration = lane.currentIteration + 1
            await this.aoe.send(
              sessionId,
              iterationPrompt(lane, event.handoff.metadata.workflow_id, await planVerdictPathFor(lane), nextIteration),
            )
            this.state.saveLane({ ...lane, state: "implementing", phase: "building", currentIteration: nextIteration })
            this.state.markDispatched(lane.worktreePath, event.key)
            results.push({ event, action: `sent:opencode:iteration-${nextIteration}` })
            break
          }
          await this.aoe.send(sessionId, promptFor(lane, event))
        }
        this.state.markDispatched(lane.worktreePath, event.key)
        this.state.saveLane({ ...lane, state: event.outcome })
        results.push({ event, action: event.outcome })
        break
      }
      const sessionId = event.destination === "codex" ? lane.codexSessionId : lane.opencodeSessionId
      if (!ACTIVE_STATES.has(String(states.get(sessionId)).toLowerCase())) continue
      if (event.destination === "opencode" && event.reviewKind === "plan" && event.outcome === "approved") {
        this.state.saveLane({
          ...lane,
          state: "compacting",
          phase: "compacting",
          transitionHandoffPath: event.handoff.path,
          transitionWorkflowId: event.handoff.metadata.workflow_id,
          transitionRequestedAt: new Date().toISOString(),
          planVerdictPath: event.handoff.path,
          planVerdictId: event.handoff.metadata.id,
          iterationCount: iterationCountFor(event.handoff.metadata),
          currentIteration: 1,
        })
        await this.aoe.send(sessionId, "/compact")
        this.state.markDispatched(lane.worktreePath, event.key)
        results.push({ event, action: "sent:opencode:compact" })
        break
      }
      await this.aoe.send(sessionId, opencodePrompt(lane, event))
      this.state.markDispatched(lane.worktreePath, event.key)
      this.state.saveLane({
        ...lane,
        state: event.destination === "codex" ? "reviewing" : event.reviewKind === "plan" ? "planning" : "implementing",
        phase: event.reopensLane ? "post_pr_feedback" : lane.phase,
      })
      results.push({ event, action: `sent:${event.destination}` })
      break
    }
    return results
  }

  async advancePlanTransition(lane, states) {
    if (lane.phase !== "compacting") return null
    const requestedAt = Date.parse(lane.transitionRequestedAt ?? "")
    if (!Number.isFinite(requestedAt) || Date.now() - requestedAt < COMPACTION_SETTLE_MS) return null
    const state = String(states.get(lane.opencodeSessionId)).toLowerCase()
    if (!ACTIVE_STATES.has(state)) return null
    const eventKey = `plan-build:${lane.transitionWorkflowId}:${lane.transitionHandoffPath}`
    if (this.state.hasDispatched(lane.worktreePath, eventKey)) return null
    await this.aoe.send(
      lane.opencodeSessionId,
      iterationPrompt(lane, lane.transitionWorkflowId, await planVerdictPathFor(lane), lane.currentIteration),
    )
    this.state.markDispatched(lane.worktreePath, eventKey)
    this.state.saveLane({
      ...lane,
      state: "implementing",
      phase: "building",
      transitionHandoffPath: null,
      transitionWorkflowId: null,
      transitionRequestedAt: null,
    })
    return { event: { handoff: { metadata: { id: lane.transitionWorkflowId } } }, action: "sent:opencode:build" }
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

async function planVerdictPathFor(lane) {
  if (lane.planVerdictPath) {
    try {
      await access(lane.planVerdictPath)
      return lane.planVerdictPath
    } catch {}
  }
  const root = join(lane.worktreePath, ".agent-handoff")
  for (const directory of ["inbox", "in-progress", "done", "archive"]) {
    let entries
    try {
      entries = await readdir(join(root, directory), { withFileTypes: true })
    } catch (error) {
      if (error?.code === "ENOENT") continue
      throw error
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue
      const path = join(root, directory, entry.name)
      const handoff = await readHandoff(path)
      if (handoff?.metadata.id === lane.planVerdictId) return path
    }
  }
  throw new Error(`Cannot find approved plan verdict ${lane.planVerdictId} for ${lane.worktreePath}.`)
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
      iteration: iterationFor(metadata),
      reopensLane: metadata.reopen === true,
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
        reviewKind: "code",
        iteration: iterationFor(metadata),
      }
    }
    if (metadata.outcome === "changes_requested") {
      return {
        key: `review:${metadata.id}:changes_requested`,
        handoff,
        round: metadata.round,
        destination: "opencode",
        reviewKind: "code",
        iteration: iterationFor(metadata),
      }
    }
  }
  return null
}

function compareEvents(left, right) {
  return left.round - right.round || left.key.localeCompare(right.key)
}

function promptFor(lane, event) {
  const path = event.handoff.path
  if (event.destination === "codex" && event.reviewKind === "plan") {
    return `Review-loop: use the handoff-review skill. Read ${path} and review the requested plan artifact. Write exactly one plan-review-verdict handoff in the lane inbox with workflow_id ${event.handoff.metadata.workflow_id}, round ${event.round}, responds_to ${event.handoff.metadata.id}, and outcome approved, changes_requested, or blocked. For approval, include a positive iteration_count and a numbered Implementation Iterations schedule. Do not implement the plan or edit implementation files.`
  }
  if (event.destination === "codex") {
    return `Review-loop: use the handoff-review skill. Read ${path}, review immutable commit ${event.handoff.metadata.head_commit}, then write one code-review handoff with workflow_id ${event.handoff.metadata.workflow_id}, round ${event.round}, iteration ${event.iteration}, and outcome approved, changes_requested, or blocked. Do not edit implementation files.`
  }
  if (event.destination === "terminal" && event.outcome === "approved") {
    if (lane.phase === "post_pr_feedback") {
      return `Review-loop: the follow-up handoff review is approved. Read ${path}, record the approved review using the handoff-review protocol, then push the approved branch to its configured remote so the existing pull request is updated. Report the remote branch and existing PR URL when finished. Do not create another pull request or make implementation changes unless needed to resolve a push blocker.`
    }
    return `Review-loop: the handoff review is approved and complete. Read ${path}, record the approved review using the handoff-review protocol, then push the approved branch to its configured remote and create a pull request. Report the remote branch and PR URL when finished. Do not make implementation changes unless needed to resolve a push or PR blocker.`
  }
  if (event.destination === "opencode" && event.reviewKind === "plan") {
    if (event.outcome === "approved") {
      return ""
    }
    return `Review-loop: read ${path}, revise the plan to address the requested changes, validate the revised plan, then publish one plan-review handoff with workflow_id ${event.handoff.metadata.workflow_id} and round ${event.round + 1}. Do not begin implementation until the plan review is approved.`
  }
  return `Review-loop: read ${path}, apply the requested review changes for iteration ${event.iteration}, validate them, commit the result, then write one implementation-response handoff with workflow_id ${event.handoff.metadata.workflow_id}, round ${event.round + 1}, iteration ${event.iteration}, and head_commit. Do not request a manual handoff.`
}

function opencodePrompt(lane, event) {
  const prompt = promptFor(lane, event)
  if (event.destination === "opencode" && lane.planning === "required" && lane.phase === "building") {
    return `/tars-build ${prompt}`
  }
  return prompt
}

function iterationCountFor(metadata) {
  return Number.isInteger(metadata.iteration_count) && metadata.iteration_count > 0 ? metadata.iteration_count : 1
}

function iterationFor(metadata) {
  return Number.isInteger(metadata.iteration) && metadata.iteration > 0 ? metadata.iteration : 1
}

function matchesCurrentIteration(lane, event) {
  if (event.reopensLane || lane.phase === "post_pr_feedback") return true
  if (lane.planning !== "required" || event.reviewKind !== "code") return true
  return event.iteration === lane.currentIteration
}

function hasNextIteration(lane, event) {
  if (lane.phase === "post_pr_feedback") return false
  return event.reviewKind === "code" && lane.currentIteration < lane.iterationCount
}

function iterationPrompt(lane, workflowId, planVerdictPath, iteration) {
  return `/tars-build Continue the approved TARS plan. Read ${planVerdictPath} and implement iteration ${iteration} of ${lane.iterationCount} only. Keep the branch buildable and verified. When this iteration is committed and verified, publish an implementation-response with workflow_id ${workflowId}, iteration ${iteration}, and head_commit. Do not start a later iteration, push, or create a pull request yet.`
}
