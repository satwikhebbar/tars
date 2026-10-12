import { execFile } from "node:child_process"
import { constants } from "node:fs"
import { open } from "node:fs/promises"
import { promisify } from "node:util"
import { withEvidenceReader } from "./investigation-query.mjs"

const execFileAsync = promisify(execFile)
const MAX_ANSWER_BYTES = 1024 * 1024
const marker = /\{\{cite:([A-Za-z0-9_-]+)\}\}/g
export const REPORT_TEMPLATE = {
  schemaVersion: 1, snapshotId: "<assigned snapshot ID>", question: "<assigned question object>",
  scope: { kind: "whole-lane", descriptionMarkdown: "What this report covers; use partial when appropriate." },
  summaryMarkdown: "Lane-wide account with inline {{cite:c1}} where relevant.",
  findings: [{ title: "Observed symptom", blockIds: ["<block ID>"], analysisMarkdown: "Evidence, interpretation and uncertainty {{cite:c1}}." }],
  limitationsMarkdown: "Material limits, not an inventory of everything read.",
  conclusionMarkdown: "Grounded conclusion.",
  citations: { c1: { kind: "event", eventId: "<event ID>" },
    c2: { kind: "repository", commit: "<commit SHA>", path: "src/example.ts", line: 18 } },
}

/** Read only a bounded regular answer file; never follow a substituted symlink. */
export async function readReportFile(path) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const info = await file.stat()
    if (!info.isFile() || info.size > MAX_ANSWER_BYTES) throw new Error("Report must be a regular JSON file no larger than 1 MiB.")
    const buffer = Buffer.alloc(MAX_ANSWER_BYTES + 1)
    let size = 0
    while (size < buffer.length) {
      const { bytesRead } = await file.read(buffer, size, buffer.length - size, null)
      if (!bytesRead) break
      size += bytesRead
    }
    if (size > MAX_ANSWER_BYTES) throw new Error("Report exceeds 1 MiB.")
    return JSON.parse(buffer.subarray(0, size).toString("utf8"))
  } finally { await file.close() }
}

function shape(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`)
  for (const key of Object.keys(value)) if (!keys.includes(key)) throw new Error(`Unknown ${label} field: ${key}.`)
}
function text(value, label, empty = false) {
  if (typeof value !== "string" || (!empty && !value.trim())) throw new Error(`${label} must be ${empty ? "a string" : "a nonempty string"}.`)
}
export function validateReportShape(answer, context) {
  shape(answer, Object.keys(REPORT_TEMPLATE), "report")
  if (answer.schemaVersion !== 1) throw new Error("Report schemaVersion must be 1.")
  if (answer.snapshotId !== context.snapshotId) throw new Error("Report snapshotId does not match the assigned snapshot.")
  const expected = context.question
  shape(answer.question, Object.keys(expected), "question")
  for (const key of Object.keys(expected)) if (answer.question[key] !== expected[key]) throw new Error("Report question does not match the assigned question.")
  shape(answer.scope, ["kind", "descriptionMarkdown"], "scope")
  if (!["whole-lane", "partial"].includes(answer.scope.kind)) throw new Error("Report scope must be whole-lane or partial.")
  text(answer.scope.descriptionMarkdown, "scope.descriptionMarkdown")
  const prose = [answer.scope.descriptionMarkdown]
  for (const key of ["summaryMarkdown", "limitationsMarkdown", "conclusionMarkdown"]) {
    text(answer[key], key, key === "limitationsMarkdown"); prose.push(answer[key])
  }
  if (!Array.isArray(answer.findings)) throw new Error("Report findings must be an array.")
  for (const finding of answer.findings) {
    shape(finding, ["title", "blockIds", "analysisMarkdown"], "finding")
    text(finding.title, "finding.title"); text(finding.analysisMarkdown, "finding.analysisMarkdown")
    if (!Array.isArray(finding.blockIds) || finding.blockIds.some((id) => typeof id !== "string" || !id)) throw new Error("Finding blockIds must be an array of IDs.")
    prose.push(finding.title, finding.analysisMarkdown)
  }
  shape(answer.citations, Object.keys(answer.citations ?? {}), "citations")
  const used = new Set()
  for (const value of prose) {
    for (const match of value.matchAll(marker)) used.add(match[1])
    if (value.replace(marker, "").includes("{{cite:")) throw new Error("Malformed inline citation marker.")
  }
  for (const id of used) if (!Object.hasOwn(answer.citations, id)) throw new Error(`Undefined citation: ${id}.`)
  for (const [id, citation] of Object.entries(answer.citations)) {
    if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error(`Invalid citation ID: ${id}.`)
    if (!used.has(id)) throw new Error(`Unused citation: ${id}.`)
    if (citation?.kind === "event") {
      shape(citation, ["kind", "eventId"], "event citation"); text(citation.eventId, "eventId")
    } else if (citation?.kind === "repository") {
      shape(citation, ["kind", "commit", "path", "line"], "repository citation")
      if (typeof citation.commit !== "string" || !/^[0-9a-f]{7,64}$/i.test(citation.commit)) throw new Error("Repository citation needs a commit SHA.")
      if (typeof citation.path !== "string" || !citation.path || citation.path.startsWith("/") || citation.path.split("/").some((part) => part === "..") || /[\x00-\x1f]/.test(citation.path)) throw new Error("Repository citation needs a relative path.")
      if (citation.line !== undefined && (!Number.isSafeInteger(citation.line) || citation.line < 1)) throw new Error("Repository citation line must be positive.")
    } else throw new Error(`Unknown citation kind: ${id}.`)
  }
  return answer
}

/** Validate structure and reference existence, never the analyst's interpretation or reading coverage. */
export async function validateInvestigationReport(answer, context, { cache, checkRepository = repositoryReferenceExists } = {}) {
  validateReportShape(answer, context)
  await withEvidenceReader({ snapshotId: context.snapshotId, readerLease: context.readerLease, cache }, async (reader) => {
    const db = reader.database
    for (const finding of answer.findings) for (const id of finding.blockIds) {
      if (!db.prepare("SELECT 1 FROM blocks WHERE block_id=?").get(id)) throw new Error(`Unknown report block ID: ${id}.`)
    }
    const checked = new Set()
    for (const citation of Object.values(answer.citations)) {
      if (citation.kind === "event") {
        if (!db.prepare("SELECT 1 FROM events WHERE event_id=?").get(citation.eventId)) throw new Error(`Unknown cited event ID: ${citation.eventId}.`)
      } else {
        const key = JSON.stringify([citation.commit, citation.path])
        if (!checked.has(key)) {
          await checkRepository(context.worktreePath, citation.commit, citation.path)
          checked.add(key)
        }
      }
    }
  })
  return answer
}

async function repositoryReferenceExists(worktreePath, commit, path) {
  try {
    const options = { cwd: worktreePath, timeout: 20_000, maxBuffer: 1024 }
    await execFileAsync("git", ["cat-file", "-e", `${commit}^{commit}`], options)
    await execFileAsync("git", ["cat-file", "-e", `${commit}:${path}`], options)
  } catch { throw new Error(`Repository citation commit/path not found: ${commit}:${path}.`) }
}

export function renderInvestigationReport({ answer, snapshot, worktreePath }) {
  const cite = (value) => value.replace(marker, (_, id) => {
    const citation = answer.citations[id]
    const label = citation.kind === "event" ? citation.eventId : `${citation.commit}:${citation.path}${citation.line ? `:${citation.line}` : ""}`
    return `[${label.replace(/[\\\[\]]/g, "\\$&")}]`
  })
  const lines = ["# Lane investigation", "", `Lane: ${worktreePath}`, `Snapshot: ${snapshot.snapshotId}`,
    `Collected: ${snapshot.createdAt}; evidence cutoff: ${snapshot.cutoff ?? snapshot.asOf}`, "Analyst: Codex", "",
    `Question: ${answer.question.kind === "built-in" ? answer.question.id : answer.question.text}`, "",
    `Scope: ${answer.scope.kind}`, "", cite(answer.scope.descriptionMarkdown), "", "## Summary", "", cite(answer.summaryMarkdown), "", "## Findings", ""]
  if (!answer.findings.length) lines.push("No findings reported.", "")
  for (const finding of answer.findings) {
    lines.push(`### ${cite(finding.title)}`, "")
    if (finding.blockIds.length) lines.push(`Blocks: ${finding.blockIds.join(", ")}`, "")
    lines.push(cite(finding.analysisMarkdown), "")
  }
  lines.push("## Limitations", "", cite(answer.limitationsMarkdown) || "None declared by the analyst.", "", "## Conclusion", "", cite(answer.conclusionMarkdown))
  if (Object.values(answer.citations).some((citation) => citation.kind === "event")) {
    lines.push("", "## Using evidence citations", "",
      "Bracketed event IDs identify evidence in this report's snapshot. While that cached snapshot exists, inspect an event with:", "",
      "```sh", `tars lane evidence get_event_details --snapshot-id ${snapshot.snapshotId} --event-id <event-ID>`, "```", "",
      "Use get_event_content with a returned text field ID to read its content. Citations cannot be retrieved after the snapshot expires or is removed; rebuilding creates a new snapshot.")
  }
  return lines.join("\n").trimEnd() + "\n"
}
