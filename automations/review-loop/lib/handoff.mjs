import { readFile } from "node:fs/promises"

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/
const WORKFLOW_TYPES = new Set(["plan-review", "plan-review-verdict", "implementation-response", "code-review"])

/** Reads the deliberately small YAML subset used by the agent handoff protocol. */
export async function readHandoff(path) {
  const contents = await readFile(path, "utf8")
  const match = contents.match(FRONTMATTER)
  if (!match) return null
  return { path, metadata: parseFrontmatter(match[1]) }
}

/** Parses scalar keys and simple string lists without adding a runtime dependency. */
export function parseFrontmatter(source) {
  const metadata = {}
  let listKey = null
  for (const rawLine of source.split(/\r?\n/)) {
    if (!rawLine.trim() || rawLine.trimStart().startsWith("#")) continue
    const list = rawLine.match(/^\s+-\s+(.+)$/)
    if (list && listKey) {
      metadata[listKey].push(parseScalar(list[1]))
      continue
    }
    const keyValue = rawLine.match(/^([A-Za-z_][\w-]*):\s*(.*)$/)
    if (!keyValue) {
      listKey = null
      continue
    }
    const [, key, rawValue] = keyValue
    if (!rawValue.trim()) {
      metadata[key] = []
      listKey = key
      continue
    }
    metadata[key] = parseScalar(rawValue)
    listKey = null
  }
  return metadata
}

/** Returns only actionable, protocol-v2 handoffs. */
export function isWorkflowHandoff(handoff) {
  return validateWorkflowHandoff(handoff).length === 0
}

/** Identifies a handoff intended for the review-loop protocol, even if incomplete. */
export function isWorkflowHandoffCandidate(handoff) {
  return Boolean(handoff?.metadata && WORKFLOW_TYPES.has(handoff.metadata.type))
}

/** Returns deterministic protocol errors; an empty array means the handoff is actionable. */
export function validateWorkflowHandoff(handoff) {
  if (!handoff?.metadata) return ["missing YAML frontmatter"]
  const { metadata } = handoff
  const errors = []
  if (!WORKFLOW_TYPES.has(metadata.type)) return ["unsupported or missing type"]
  if (typeof metadata.id !== "string" || !metadata.id.trim()) errors.push("missing id")
  if (!(typeof metadata.workflow_id === "string" && metadata.workflow_id.trim()) && !Number.isInteger(metadata.workflow_id)) errors.push("missing workflow_id")
  if (!Number.isInteger(metadata.round) || metadata.round < 1) errors.push("missing positive integer round")
  if (metadata.type === "plan-review" && (!Array.isArray(metadata.target) || metadata.target.length === 0)) errors.push("missing target")
  if (metadata.type === "implementation-response" && (typeof metadata.head_commit !== "string" || !metadata.head_commit.trim())) errors.push("missing head_commit")
  if (["plan-review-verdict", "code-review"].includes(metadata.type) && !["approved", "changes_requested", "blocked"].includes(metadata.outcome)) errors.push("missing valid outcome")
  if (metadata.type === "plan-review-verdict" && metadata.outcome === "approved" && (!Number.isInteger(metadata.iteration_count) || metadata.iteration_count < 1)) errors.push("approved plan verdict requires positive iteration_count")
  return errors
}

function parseScalar(value) {
  const trimmed = value.trim()
  if (/^\d+$/.test(trimmed)) return Number(trimmed)
  if (trimmed === "true") return true
  if (trimmed === "false") return false
  const quoted = trimmed.match(/^(["'])(.*)\1$/)
  return quoted ? quoted[2] : trimmed
}
