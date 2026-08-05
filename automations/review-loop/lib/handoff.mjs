import { readFile } from "node:fs/promises"

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/

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
  const { metadata } = handoff
  return (
    typeof metadata.id === "string" &&
    (typeof metadata.workflow_id === "string" || Number.isInteger(metadata.workflow_id)) &&
    Number.isInteger(metadata.round)
  )
}

function parseScalar(value) {
  const trimmed = value.trim()
  if (/^\d+$/.test(trimmed)) return Number(trimmed)
  if (trimmed === "true") return true
  if (trimmed === "false") return false
  const quoted = trimmed.match(/^(["'])(.*)\1$/)
  return quoted ? quoted[2] : trimmed
}
