import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { lstat, readFile, symlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { promisify } from "node:util"
import test from "node:test"
import { readReportFile, validateReportShape, validateInvestigationReport, renderInvestigationReport } from "../lib/investigation-report.mjs"
import { investigationFixture, reportAnswer } from "./helpers/investigation.mjs"
const exec = promisify(execFile)

test("structured report validates real event/block IDs and renders inline citations at their original positions", async (t) => {
  const { cache, snapshot, context } = await investigationFixture(t)
  const answer = reportAnswer(context)
  await validateInvestigationReport(answer, context, { cache })
  const markdown = renderInvestigationReport({ answer, snapshot, worktreePath: context.worktreePath })
  assert.match(markdown, /An observed task \[E1\]/)
  assert.match(markdown, /Observed evidence \[E1\]. \*\*Hypothesis\*\*/)
  assert(!markdown.includes("{{cite:")); assert(markdown.includes(snapshot.asOf))
  assert.equal(markdown, renderInvestigationReport({ answer, snapshot, worktreePath: context.worktreePath }))
})
test("zero-findings partial and ad hoc reports use the generic schema", async (t) => {
  const { cache, context, snapshot } = await investigationFixture(t)
  context.question = { kind: "ad-hoc", text: "What happened?" }
  const answer = reportAnswer(context, { scope: { kind: "partial", descriptionMarkdown: "Only author context was examined." }, findings: [] })
  await validateInvestigationReport(answer, context, { cache })
  const text = renderInvestigationReport({ answer, snapshot, worktreePath: context.worktreePath })
  assert.match(text, /Scope: partial/); assert.match(text, /What happened/); assert.match(text, /No findings reported/)
})
test("schema rejects missing/wrong fields, invalid scope, mismatched identity and malformed citations", async (t) => {
  const { context } = await investigationFixture(t)
  const changes = [{ schemaVersion: 2 }, { snapshotId: "wrong" }, { question: { kind: "ad-hoc", text: "wrong" } },
    { scope: { kind: "selected", descriptionMarkdown: "x" } }, { scope: { kind: "partial", descriptionMarkdown: "" } },
    { summaryMarkdown: "" }, { limitationsMarkdown: null }, { findings: {} }, { citations: [] }, { extra: true },
    { summaryMarkdown: "{{cite:missing}}" }, { summaryMarkdown: "{{cite:bad id}}" },
    { citations: { c1: { kind: "other" } } }, { citations: { c1: { kind: "event", eventId: "E1", path: "extra" } } },
    { citations: { c1: { kind: "event", eventId: "E1" }, unused: { kind: "event", eventId: "E1" } } },
    { findings: [{ title: "x", blockIds: [null], analysisMarkdown: "x" }] }]
  for (const change of changes) assert.throws(() => validateReportShape(reportAnswer(context, change), context))
  const missing = reportAnswer(context); delete missing.conclusionMarkdown
  assert.throws(() => validateReportShape(missing, context), /conclusionMarkdown/)
  const reordered = reportAnswer(context); reordered.question = { version: 1, id: "navigation-efficiency", kind: "built-in" }
  validateReportShape(reordered, context)
})
test("unknown event and block references fail without reading native bodies", async (t) => {
  const { cache, context } = await investigationFixture(t)
  await assert.rejects(validateInvestigationReport(reportAnswer(context, { citations: { c1: { kind: "event", eventId: "missing" } } }), context, { cache }), /Unknown cited event/)
  await assert.rejects(validateInvestigationReport(reportAnswer(context, { findings: [{ title: "x", blockIds: ["missing"], analysisMarkdown: "x" }] }), context, { cache }), /Unknown report block/)
})
test("repository citations verify commit/path locally and allow optional lines without interpreting them", async (t) => {
  const { root, cache, context } = await investigationFixture(t)
  await exec("git", ["init", "-q", root])
  await writeFile(join(root, "guide.md"), "Guide\n")
  await exec("git", ["-C", root, "add", "guide.md"])
  await exec("git", ["-C", root, "-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "-qm", "fixture"])
  const { stdout } = await exec("git", ["-C", root, "rev-parse", "HEAD"])
  const citation = { kind: "repository", commit: stdout.trim(), path: "guide.md", line: 999 }
  const answer = reportAnswer(context, { citations: { c1: citation } })
  await validateInvestigationReport(answer, context, { cache })
  for (const change of [{ path: "missing" }, { commit: "a".repeat(40) }]) await assert.rejects(validateInvestigationReport(reportAnswer(context, { citations: { c1: { ...citation, ...change } } }), context, { cache }), /commit\/path not found/)
  for (const change of [{ path: "../outside" }, { path: "/absolute" }, { commit: "HEAD" }, { line: 0 }]) assert.throws(() => validateReportShape(reportAnswer(context, { citations: { c1: { ...citation, ...change } } }), context))
})
test("answer file rejects malformed JSON, symlinks and oversized files", async (t) => {
  const { root, context } = await investigationFixture(t)
  const file = join(root, "answer.json")
  await writeFile(file, JSON.stringify(reportAnswer(context))); assert.equal((await readReportFile(file)).schemaVersion, 1)
  await symlink(file, join(root, "link")); await assert.rejects(readReportFile(join(root, "link")), /ELOOP/)
  await writeFile(file, "not json"); await assert.rejects(readReportFile(file), /JSON/)
  await writeFile(file, " ".repeat(1024 * 1024 + 1)); await assert.rejects(readReportFile(file), /1 MiB/)
})
test("self-validation CLI borrows the lease, opens no lane registry and returns actionable errors", async (t) => {
  const { root, cache, context, snapshot } = await investigationFixture(t)
  const lease = await cache.lease(snapshot.snapshotId)
  try {
    const assigned = { ...context, cacheRoot: cache.root, readerLease: lease.leaseId }
    const file = join(root, "answer.json"), contextPath = join(root, "context.json")
    await writeFile(file, JSON.stringify(reportAnswer(context))); await writeFile(contextPath, JSON.stringify(assigned))
    const cli = new URL("../cli.mjs", import.meta.url).pathname
    const args = [cli, "lane", "investigate", "validate-report", "--file", file, "--context", contextPath]
    const env = { ...process.env, XDG_STATE_HOME: join(root, "state") }
    const { stdout } = await exec(process.execPath, args, { env })
    assert.equal(JSON.parse(stdout).valid, true)
    await assert.rejects(lstat(join(root, "state")), /ENOENT/)
    await writeFile(file, JSON.stringify(reportAnswer(context, { citations: { c1: { kind: "event", eventId: "missing" } } })))
    await assert.rejects(exec(process.execPath, args, { env }), /Unknown cited event/)
    await assert.rejects(cache.remove(snapshot.snapshotId), /in use|lease/i)
  } finally { await lease.release() }
})
