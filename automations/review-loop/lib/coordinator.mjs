import { access, readdir } from "node:fs/promises"
import { join } from "node:path"
import { isWorkflowHandoff, isWorkflowHandoffCandidate, readHandoff, validateWorkflowHandoff } from "./handoff.mjs"

const HANDOFF_DIRECTORIES = ["inbox", "done"]
const ACTIVE_STATES = new Set(["idle", "waiting"])
const COMPACTION_SETTLE_MS = 2_000

/** Coordinates one persisted author/reviewer pair per worktree through durable handoff files. */
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
    const { handoffs, invalidHandoffs } = await handoffsFor(lane.worktreePath)
    const contextualInvalidHandoffs = handoffs
      .map((handoff) => ({ handoff, errors: validateWorkflowHandoff(handoff, { requiresReopen: activeLaneState(lane) === "approved" }) }))
      .filter((invalid) => invalid.errors.length)
    const invalid = invalidHandoffs[0] ?? contextualInvalidHandoffs[0]
    if (invalid) {
      if (lane.state !== "invalid_handoff") {
        this.state.saveLane({
          ...lane,
          state: "invalid_handoff",
          invalidResumeState: lane.state,
          invalidResumePhase: lane.phase,
        })
        return [{ event: { handoff: { metadata: { id: invalid.handoff.metadata.id ?? invalid.handoff.path } } }, action: `invalid-handoff: ${invalid.errors.join(", ")}` }]
      }
      return []
    }
    if (lane.state === "invalid_handoff") {
      lane = {
        ...lane,
        state: lane.invalidResumeState ?? "watching",
        phase: lane.invalidResumePhase ?? lane.phase,
        invalidResumeState: null,
        invalidResumePhase: null,
      }
      this.state.saveLane(lane)
    }
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
          const sessionId = lane.authorSessionId
          if (!ACTIVE_STATES.has(String(states.get(sessionId)).toLowerCase())) continue
          if (hasNextIteration(lane, event)) {
            const nextIteration = lane.currentIteration + 1
            await this.aoe.send(
              sessionId,
              iterationPrompt(lane, event.handoff.metadata.workflow_id, await planVerdictPathFor(lane), nextIteration, event.round + 1),
            )
            this.state.saveLane({ ...lane, state: "implementing", phase: "building", currentIteration: nextIteration })
            this.state.markDispatched(lane.worktreePath, event.key)
            results.push({ event, action: `sent:author:iteration-${nextIteration}` })
            break
          }
          await this.aoe.send(sessionId, buildPrompt(lane, promptFor(lane, event)))
        }
        this.state.markDispatched(lane.worktreePath, event.key)
        this.state.saveLane({ ...lane, state: event.outcome })
        results.push({ event, action: event.outcome })
        break
      }
      const sessionId = event.destination === "reviewer" ? lane.reviewerSessionId : lane.authorSessionId
      if (!ACTIVE_STATES.has(String(states.get(sessionId)).toLowerCase())) continue
      if (event.destination === "author" && event.reviewKind === "plan" && event.outcome === "approved") {
        if (lane.authorHarness !== "opencode") {
          await this.aoe.send(sessionId, iterationPrompt(lane, event.handoff.metadata.workflow_id, event.handoff.path, 1, event.round + 1))
          this.state.markDispatched(lane.worktreePath, event.key)
          this.state.saveLane({ ...lane, state: "implementing", phase: "building", planVerdictPath: event.handoff.path, planVerdictId: event.handoff.metadata.id, iterationCount: iterationCountFor(event.handoff.metadata), currentIteration: 1 })
          results.push({ event, action: "sent:author:build" })
          break
        }
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
        results.push({ event, action: "sent:author:compact" })
        break
      }
      await this.aoe.send(sessionId, authorPrompt(lane, event))
      this.state.markDispatched(lane.worktreePath, event.key)
      this.state.saveLane({
        ...lane,
        state: event.destination === "reviewer" ? "reviewing" : event.reviewKind === "plan" ? "planning" : "implementing",
        phase: event.reopensLane ? "post_pr_feedback" : lane.phase,
      })
      results.push({ event, action: `sent:${event.destination === "reviewer" ? lane.reviewerHarness : lane.authorHarness}` })
      break
    }
    return results
  }

  async advancePlanTransition(lane, states) {
    if (lane.phase !== "compacting") return null
    const requestedAt = Date.parse(lane.transitionRequestedAt ?? "")
    if (!Number.isFinite(requestedAt) || Date.now() - requestedAt < COMPACTION_SETTLE_MS) return null
    const state = String(states.get(lane.authorSessionId)).toLowerCase()
    if (!ACTIVE_STATES.has(state)) return null
    const eventKey = `plan-build:${lane.transitionWorkflowId}:${lane.transitionHandoffPath}`
    if (this.state.hasDispatched(lane.worktreePath, eventKey)) return null
    const planVerdictPath = await planVerdictPathFor(lane)
    const planVerdict = await readHandoff(planVerdictPath)
    await this.aoe.send(
      lane.authorSessionId,
      iterationPrompt(lane, lane.transitionWorkflowId, planVerdictPath, lane.currentIteration, planVerdict.metadata.round + 1),
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
    return { event: { handoff: { metadata: { id: lane.transitionWorkflowId } } }, action: "sent:author:build" }
  }
}

function activeLaneState(lane) {
  return lane.state === "invalid_handoff" ? lane.invalidResumeState ?? "watching" : lane.state
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
  const parsed = await Promise.all(files.map(readHandoff))
  const invalidHandoffs = parsed
    .filter(isWorkflowHandoffCandidate)
    .filter((handoff) => !isWorkflowHandoff(handoff))
    .map((handoff) => ({ handoff, errors: validateWorkflowHandoff(handoff) }))
  return { handoffs: parsed.filter((handoff) => handoff && isWorkflowHandoff(handoff)), invalidHandoffs }
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

export function classifyEvent(handoff) {
  const { metadata } = handoff
  if (metadata.type === "plan-review" && ["author", "opencode"].includes(metadata.created_by) && !metadata.outcome) {
    return {
      key: `plan:${metadata.id}`,
      handoff,
      round: metadata.round,
      destination: "reviewer",
      reviewKind: "plan",
    }
  }
  if (metadata.type === "plan-review-verdict" && ["reviewer", "codex"].includes(metadata.created_by) && typeof metadata.outcome === "string") {
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
        destination: "author",
        outcome: metadata.outcome,
        reviewKind: "plan",
      }
    }
  }
  if (metadata.type === "implementation-response" && (!metadata.created_by || ["author", "opencode"].includes(metadata.created_by)) && typeof metadata.head_commit === "string") {
    return {
      key: `implementation:${metadata.id}:${metadata.head_commit}`,
      handoff,
      round: metadata.round,
      destination: "reviewer",
      reviewKind: "code",
      iteration: iterationFor(metadata),
      reopensLane: metadata.reopen === true,
    }
  }
  if (metadata.type === "code-review" && (!metadata.created_by || ["reviewer", "codex"].includes(metadata.created_by)) && typeof metadata.outcome === "string") {
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
        destination: "author",
        reviewKind: "code",
        iteration: iterationFor(metadata),
      }
    }
  }
  return null
}

export function compareEvents(left, right) {
  return left.round - right.round || left.key.localeCompare(right.key)
}

function promptFor(lane, event) {
  const path = event.handoff.path
  if (event.destination === "reviewer" && event.reviewKind === "plan") {
    return `Review-loop: you are the reviewer. Use the handoff-review skill. Read ${path} and review the requested plan artifact. Write exactly one plan-review-verdict handoff in the lane inbox with created_by: reviewer, workflow_id ${event.handoff.metadata.workflow_id}, round ${event.round}, responds_to ${event.handoff.metadata.id}, and outcome approved, changes_requested, or blocked. For approval, include a positive iteration_count and a numbered Implementation Iterations schedule. Do not implement the plan or edit implementation files.`
  }
  if (event.destination === "reviewer") {
    return `Review-loop: you are the reviewer. Use the handoff-review skill. Read ${path}, review immutable commit ${event.handoff.metadata.head_commit}, then write one code-review handoff with created_by: reviewer, workflow_id ${event.handoff.metadata.workflow_id}, round ${event.round}, iteration ${event.iteration}, and outcome approved, changes_requested, or blocked. Do not edit implementation files.`
  }
  if (event.destination === "terminal" && event.outcome === "approved") {
    if (lane.phase === "post_pr_feedback") {
      return `Review-loop: the follow-up handoff review is approved. Read ${path}, record the approved review using the handoff-review protocol, then push the approved branch to its configured remote so the existing pull request is updated. Report the remote branch and existing PR URL when finished. Do not create another pull request or make implementation changes unless needed to resolve a push blocker.`
    }
    return `Review-loop: the handoff review is approved and complete. Read ${path}, record the approved review using the handoff-review protocol, then push the approved branch to its configured remote and create a pull request. Report the remote branch and PR URL when finished. Do not make implementation changes unless needed to resolve a push or PR blocker.`
  }
  if (event.destination === "author" && event.reviewKind === "plan") {
    if (event.outcome === "approved") {
      return ""
    }
    return `Review-loop: read ${path}, revise the plan to address the requested changes, validate the revised plan, then publish one plan-review handoff with workflow_id ${event.handoff.metadata.workflow_id} and round ${event.round + 1}. For an OpenCode TARS planning author, TARS explicitly permits writes to plans/ and .agent-handoff/ in this session: make those revisions now; do not ask the user to approve or exit planning. Do not begin implementation until the plan review is approved.`
  }
  return `Review-loop: read ${path}, apply the requested review changes for iteration ${event.iteration}, validate them, commit the result, then write one implementation-response handoff with workflow_id ${event.handoff.metadata.workflow_id}, round ${event.round + 1}, iteration ${event.iteration}, and head_commit. Do not request a manual handoff.`
}

function authorPrompt(lane, event) {
  const prompt = promptFor(lane, event)
  return event.destination === "author" && event.reviewKind !== "plan" ? buildPrompt(lane, prompt) : prompt
}

/** Routes planned-lane implementation and publishing work back through OpenCode's Build agent. */
function buildPrompt(lane, prompt, { force = false } = {}) {
  if (lane.authorHarness === "opencode" && lane.planning === "required" && (force || ["building", "post_pr_feedback"].includes(lane.phase))) return `/tars-build ${prompt}`
  return prompt
}

function iterationCountFor(metadata) {
  return Number.isInteger(metadata.iteration_count) && metadata.iteration_count > 0 ? metadata.iteration_count : 1
}

function iterationFor(metadata) {
  return Number.isInteger(metadata.iteration) && metadata.iteration > 0 ? metadata.iteration : 1
}

export function matchesCurrentIteration(lane, event) {
  if (event.reopensLane || lane.phase === "post_pr_feedback") return true
  if (lane.planning !== "required" || event.reviewKind !== "code") return true
  return event.iteration === lane.currentIteration
}

function hasNextIteration(lane, event) {
  if (lane.phase === "post_pr_feedback") return false
  return event.reviewKind === "code" && lane.currentIteration < lane.iterationCount
}

function iterationPrompt(lane, workflowId, planVerdictPath, iteration, round) {
  const prompt = `Continue the approved TARS plan. Read ${planVerdictPath} and implement iteration ${iteration} of ${lane.iterationCount} only. Keep the branch buildable and verified. When this iteration is committed and verified, publish an implementation-response with created_by: author, workflow_id ${workflowId}, round ${round}, iteration ${iteration}, and head_commit. Before publishing, run node automations/review-loop/cli.mjs handoff validate --path <handoff-path>; correct every reported error. Do not start a later iteration, push, or create a pull request yet.`
  return buildPrompt(lane, prompt, { force: true })
}
