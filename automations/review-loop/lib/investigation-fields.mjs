import { createHash } from "node:crypto"

export const fieldId = (path) => createHash("sha256").update(path).digest("hex").slice(0, 32)
export const childPath = (path, key) => `${path}/${String(key).replaceAll("~", "~0").replaceAll("/", "~1")}`

/** Store JSON structure separately from leaves so details never eagerly expand bodies. */
export function storeEventFields(db, eventId, value, pack) {
  const insert = db.prepare("INSERT INTO event_fields VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
  const walk = (item, path, parent, key, ordinal) => {
    const id = fieldId(path)
    const kind = Array.isArray(item) ? "array" : item === null ? "null" : typeof item
    const compound = kind === "array" || kind === "object"
    insert.run(eventId, id, parent, ordinal, JSON.stringify(key), kind,
      compound ? null : JSON.stringify(pack(item)), typeof item === "string" ? Buffer.byteLength(item) : null,
      typeof item === "string" ? item.split("\n").length : null, path)
    if (compound) Object.entries(item).forEach(([name, child], index) => walk(child, childPath(path, name), id, name, index))
  }
  walk(value, "", null, null, 0)
}

/** Context is established per native stream; no inferred continuity between bundles. */
export function orderEvidenceEvents(events, sources) {
  const ordered = []
  for (const source of sources) {
    const stream = events.filter((event) => event.sourceId === source.id)
    const nativeOrder = source.metadata.harness === "opencode"
    stream.sort(nativeOrder ? (a, b) => a.position - b.position :
      (a, b) => (a.time ?? Infinity) - (b.time ?? Infinity) || (a.position ?? 0) - (b.position ?? 0) || a.id.localeCompare(b.id))
    let segment = 0, prior = null
    const unknownCompaction = !nativeOrder && stream.some((event) => event.type === "compaction" && !Number.isFinite(event.time))
    const compactionTimes = new Set(stream.filter((event) => event.type === "compaction").map((event) => event.time))
    for (const event of stream) {
      const known = source.metadata.harness !== "tars" && !unknownCompaction &&
        (nativeOrder ? Number.isFinite(event.position) : Number.isFinite(event.time) &&
          (event.type === "compaction" || !compactionTimes.has(event.time)))
      const context = known ? { contextSegmentId: `${source.id}:context-${segment}`, precedingCompactionEventId: prior } :
        { contextSegmentId: null, precedingCompactionEventId: null }
      ordered.push({ ...event, ...context })
      if (event.type === "compaction" && known) { segment++; prior = event.id }
    }
  }
  return ordered
}
