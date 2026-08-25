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
    { ...base, type: "plan-review-verdict", outcome: "approved", iteration_count: 1 },
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
  assert.deepEqual(validateWorkflowHandoff(handoff({ ...base, type: "plan-review-verdict", outcome: "approved" })), ["approved plan verdict requires positive iteration_count"])
})

test("recognizes incomplete protocol handoffs as validation candidates", () => {
  assert.equal(isWorkflowHandoffCandidate(handoff({ type: "implementation-response" })), true)
  assert.equal(isWorkflowHandoffCandidate(handoff({ type: "note" })), false)
})
