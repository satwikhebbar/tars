import assert from "node:assert/strict"
import test from "node:test"
import { questions, resolveInvestigationQuestion } from "../lib/investigation-question.mjs"

test("built-in navigation is versioned instructions, without projection or judgment hooks", async () => {
  const question = await resolveInvestigationQuestion()
  assert.deepEqual(question.identity, { kind: "built-in", id: "navigation-efficiency", version: 1 })
  assert(question.instructions.trim().length > 0)
  assert.equal(questions[question.identity.id].project, undefined)
})
test("ad hoc question and optional guidance reuse the same generic protocol", async () => {
  const result = await resolveInvestigationQuestion({ adHoc: "Was any deployment risky?", guidance: "Explain approvals." })
  assert.deepEqual(result.identity, { kind: "ad-hoc", text: "Was any deployment risky?" })
  assert.match(result.instructions, /Explain approvals/)
  assert(!result.instructions.includes(result.identity.text))
  assert.equal((await resolveInvestigationQuestion({ adHoc: "What happened?" })).instructions, "")
  for (const options of [{ question: "unknown" }, { question: "__proto__" }, { question: "navigation-efficiency", adHoc: "x" }, { adHoc: " " }, { guidance: "x" }, { adHoc: "x", guidance: "" }]) await assert.rejects(resolveInvestigationQuestion(options))
})
