import assert from "node:assert/strict"
import test from "node:test"
import { chooseLaneName, fallbackLaneName, parseNameDirective } from "../lib/namer.mjs"

const ISSUE = { number: 44, title: "Add Calendar Export" }

test("accepts one valid naming directive amid unrelated output", () => {
  const value = parseNameDirective(
    'thinking aloud\nTARS_LANE_NAME={"branch":"enhance/calendar-export","worktree_name":"calendar-export"}\nall done',
  )
  assert.deepEqual(value, { branch: "enhance/calendar-export", worktreeName: "calendar-export" })
})

test("rejects ambiguous or unsafe naming directives", () => {
  assert.throws(() => parseNameDirective('TARS_LANE_NAME={"branch":"bad name","worktree_name":"bad-name"}'), /invalid/)
  assert.throws(
    () =>
      parseNameDirective(
        'TARS_LANE_NAME={"branch":"issue/44-one","worktree_name":"issue-44-one"}\nTARS_LANE_NAME={"branch":"issue/44-two","worktree_name":"issue-44-two"}',
      ),
    /exactly one/,
  )
})

test("falls back deterministically when the namer output cannot be used", async () => {
  const names = await chooseLaneName(ISSUE, async () => "a wall of text")
  assert.deepEqual(names, { branch: "issue/44-add-calendar-export", worktreeName: "issue-44-add-calendar-export" })
  assert.deepEqual(fallbackLaneName(ISSUE), names)
})

test("uses a valid pair returned by the namer", async () => {
  const names = await chooseLaneName(
    ISSUE,
    async () => 'TARS_LANE_NAME={"branch":"enhance/calendar-export","worktree_name":"calendar-export"}',
  )
  assert.deepEqual(names, { branch: "enhance/calendar-export", worktreeName: "calendar-export" })
})
