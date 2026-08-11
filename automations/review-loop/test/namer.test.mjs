import assert from "node:assert/strict"
import test from "node:test"
import { chooseLanePreflight, fallbackLanePreflight, parsePreflightDirective } from "../lib/namer.mjs"

const ISSUE = { number: 44, title: "Add Calendar Export" }

test("accepts one valid preflight directive amid unrelated output", () => {
  const value = parsePreflightDirective(
    'thinking aloud\nTARS_LANE_PREFLIGHT={"branch":"enhance/calendar-export","worktree_name":"calendar-export","planning":"not_required"}\nall done',
  )
  assert.deepEqual(value, { branch: "enhance/calendar-export", worktreeName: "calendar-export", planning: "not_required" })
})

test("rejects ambiguous, unsafe, or incomplete preflight directives", () => {
  assert.throws(
    () => parsePreflightDirective('TARS_LANE_PREFLIGHT={"branch":"bad name","worktree_name":"bad-name","planning":"required"}'),
    /invalid/,
  )
  assert.throws(
    () => parsePreflightDirective('TARS_LANE_PREFLIGHT={"branch":"issue/44-one","worktree_name":"issue-44-one"}'),
    /invalid/,
  )
  assert.throws(
    () => parsePreflightDirective('TARS_LANE_PREFLIGHT={"branch":"issue/44-one","worktree_name":"issue-44-one","planning":"required"}\nTARS_LANE_PREFLIGHT={"branch":"issue/44-two","worktree_name":"issue-44-two","planning":"required"}'),
    /exactly one/,
  )
})

test("falls back to a safe planning lane when the preflight output cannot be used", async () => {
  const result = await chooseLanePreflight(ISSUE, async () => "a wall of text")
  assert.deepEqual(result, { branch: "issue/44-add-calendar-export", worktreeName: "issue-44-add-calendar-export", planning: "required" })
  assert.deepEqual(fallbackLanePreflight(ISSUE), result)
})

test("uses a valid preflight result", async () => {
  const result = await chooseLanePreflight(
    ISSUE,
    async () => 'TARS_LANE_PREFLIGHT={"branch":"enhance/calendar-export","worktree_name":"calendar-export","planning":"required"}',
  )
  assert.deepEqual(result, { branch: "enhance/calendar-export", worktreeName: "calendar-export", planning: "required" })
})
