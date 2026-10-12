import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { EvidenceSnapshots } from "../../lib/investigation-snapshot.mjs"
import { resolveInvestigationQuestion } from "../../lib/investigation-question.mjs"

export async function investigationFixture(t, coverage = { author: { status: "available" }, reviewer: { status: "available" } }) {
  const root = await mkdtemp(join(tmpdir(), "tars-report-test-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const cache = new EvidenceSnapshots({ root: join(root, "cache", "agent-review-loop", "evidence-indexes") })
  const snapshot = await cache.prepare({ laneId: "lane", collect: async () => ({ sources: [{ id: "s", metadata: {}, native: {} }],
    events: [{ id: "E1", sourceId: "s", role: "author", type: "message", position: 0, time: 1, blockId: "B", pointer: {}, attributes: { speaker: "user" }, extra: { text: "task" } }],
    blocks: [{ id: "B", role: "author", start: 0, end: null, openingEventId: "E1" }], coverage, asOf: "2026-10-12T00:00:00Z", gaps: [] }) })
  const question = await resolveInvestigationQuestion()
  const context = { snapshotId: snapshot.snapshotId, question: question.identity, worktreePath: root }
  return { root, cache, snapshot, question, context }
}
export function reportAnswer(context, changes = {}) {
  return { schemaVersion: 1, snapshotId: context.snapshotId, question: context.question,
    scope: { kind: "whole-lane", descriptionMarkdown: "Both roles through the cutoff." }, summaryMarkdown: "An observed task {{cite:c1}}.",
    findings: [{ title: "Symptom", blockIds: ["B"], analysisMarkdown: "Observed evidence {{cite:c1}}. **Hypothesis**, with uncertainty." }],
    limitationsMarkdown: "Native uncertainty remains.", conclusionMarkdown: "No supported problem found.",
    citations: { c1: { kind: "event", eventId: "E1" } }, ...changes }
}
export function assignedContext(command) {
  const answerPath = JSON.parse(command.prompt.match(/Write valid JSON to (.+)\. Your final chat/)[1])
  const contextPath = join(command.cwd, "context.json")
  return { answerPath, contextPath }
}
