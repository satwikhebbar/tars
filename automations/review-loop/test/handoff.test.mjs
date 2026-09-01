import assert from "node:assert/strict"
import test from "node:test"
import { isWorkflowHandoff, isWorkflowHandoffCandidate, validateWorkflowHandoff } from "../lib/handoff.mjs"

function handoff(metadata) {
  return { path: "/tmp/handoff.md", metadata }
}

const base = { id: "handoff-1", workflow_id: 64, round: 1 }

test("validates every supported workflow handoff type", () => {
  const valid = [
    { ...base, type: "plan-review", target: ["plans/example.md"] },
    { ...base, type: "implementation-response", head_commit: "abc123" },
    { ...base, type: "implementation-response", workflow_id: "64.0", head_commit: "abc123" },
    { ...base, type: "code-review", outcome: "changes_requested" },
    { ...base, type: "plan-review-verdict", outcome: "approved", iteration_count: 1, review_budget: 2 },
    { ...base, type: "plan-review-verdict", outcome: "approved", iteration_count: 3, review_budget_per_iteration: 2 },
    { ...base, type: "plan-review-verdict", outcome: "blocked" },
  ]

  for (const metadata of valid) {
    assert.deepEqual(validateWorkflowHandoff(handoff(metadata)), [])
    assert.equal(isWorkflowHandoff(handoff(metadata)), true)
  }
})

test("rejects missing or invalid common workflow metadata", () => {
  assert.deepEqual(validateWorkflowHandoff(null), ["missing YAML frontmatter"])
  assert.deepEqual(validateWorkflowHandoff(handoff({ ...base, type: "other" })), ["unsupported or missing type"])
  assert.deepEqual(validateWorkflowHandoff(handoff({ type: "implementation-response", workflow_id: 64, round: 1, head_commit: "abc" })), ["missing id"])
  assert.deepEqual(validateWorkflowHandoff(handoff({ ...base, type: "implementation-response", workflow_id: "", head_commit: "abc" })), ["missing workflow_id"])
  assert.deepEqual(validateWorkflowHandoff(handoff({ ...base, type: "implementation-response", round: 0, head_commit: "abc" })), ["missing positive integer round"])
})

test("enforces type-specific workflow metadata", () => {
  assert.deepEqual(validateWorkflowHandoff(handoff({ ...base, type: "plan-review" })), ["missing target"])
  assert.deepEqual(validateWorkflowHandoff(handoff({ ...base, type: "implementation-response" })), ["missing head_commit"])
  assert.deepEqual(validateWorkflowHandoff(handoff({ ...base, type: "code-review", outcome: "pending" })), ["missing valid outcome"])
  assert.deepEqual(validateWorkflowHandoff(handoff({ ...base, type: "plan-review-verdict" })), ["missing valid outcome"])
  assert.deepEqual(validateWorkflowHandoff(handoff({ ...base, type: "plan-review-verdict", outcome: "approved" })), ["approved plan verdict requires positive iteration_count and review_budget or review_budget_per_iteration"])
})

test("approved plan verdicts require a review budget in one of its two forms", () => {
  const approved = { ...base, type: "plan-review-verdict", outcome: "approved", iteration_count: 3 }
  assert.deepEqual(validateWorkflowHandoff(handoff(approved)), ["approved plan verdict requires positive iteration_count and review_budget or review_budget_per_iteration"])
  assert.deepEqual(validateWorkflowHandoff(handoff({ ...approved, review_budget: 0 })), ["approved plan verdict requires positive iteration_count and review_budget or review_budget_per_iteration"])
  assert.deepEqual(validateWorkflowHandoff(handoff({ ...approved, review_budget_per_iteration: -1 })), ["approved plan verdict requires positive iteration_count and review_budget or review_budget_per_iteration"])
  assert.deepEqual(validateWorkflowHandoff(handoff({ ...approved, review_budget: 6 })), [])
  assert.deepEqual(validateWorkflowHandoff(handoff({ ...approved, review_budget_per_iteration: 2 })), [])
  assert.deepEqual(validateWorkflowHandoff(handoff({ ...approved, review_budget: 6, review_budget_per_iteration: 2 })), [])
})

test("requires an explicit reopen flag when validating an approved lane response", () => {
  const response = handoff({ ...base, type: "implementation-response", head_commit: "abc123" })
  assert.deepEqual(validateWorkflowHandoff(response, { requiresReopen: true }), ["approved lane requires reopen: true"])
  assert.deepEqual(validateWorkflowHandoff(handoff({ ...response.metadata, reopen: true }), { requiresReopen: true }), [])
  assert.deepEqual(validateWorkflowHandoff(response), [])
})

test("recognizes incomplete protocol handoffs as validation candidates", () => {
  assert.equal(isWorkflowHandoffCandidate(handoff({ type: "implementation-response" })), true)
  assert.equal(isWorkflowHandoffCandidate(handoff({ type: "note" })), false)
})
