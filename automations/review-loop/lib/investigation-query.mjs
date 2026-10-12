import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { hostname } from "node:os"
import { EvidenceSnapshots, openEvidenceSnapshot } from "./investigation-snapshot.mjs"
import { CONTENT_LIMITS, PAGE_LIMITS, defaultTokenCounter, fitsResponse } from "./investigation-response.mjs"

const METHODS = new Set(["overview", "list_events", "get_event_content", "get_event_details"])
const FILTERS = new Set(["blockId", "role", "eventType", "toolName", "action", "path", "pathUnder", "query", "minVisibleOutputBytes", "from", "to", "sourceId", "messageId"])
const preview = (text, length = 160) => [...String(text)].slice(0, length).join("")
const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex")

/** Operator queries take a short lease. An analyst borrows its launcher's lifetime lease. */
export async function queryEvidence({ snapshotId, method, filters = {}, eventId, field, fieldPath, fieldKey = false,
  lineStart, lineEnd, byteStart, byteEnd, cursor, readerLease, cache = new EvidenceSnapshots(), counter }) {
  if (!METHODS.has(method)) throw new Error(`Unknown evidence query ${method}.`)
  if (!snapshotId) throw new Error("Evidence queries require --snapshot-id.")
  return withEvidenceReader({ snapshotId, readerLease, cache }, async (reader, snapshot) => {
    const query = new EvidenceQuery(reader.database, snapshot, counter ?? await defaultTokenCounter())
    return query.run(method, { filters, eventId, field, fieldPath, fieldKey, lineStart, lineEnd, byteStart, byteEnd, cursor })
  })
}

/** Share lease checks with final report validation; borrowed queries never mutate the cache. */
export async function withEvidenceReader({ snapshotId, readerLease, cache = new EvidenceSnapshots() }, action) {
  let lease
  if (readerLease) {
    if (!/^[a-f0-9-]{36}$/.test(readerLease)) throw new Error("Invalid reader lease.")
    const snapshot = (await cache.list()).find((item) => item.snapshotId === snapshotId && item.usable)
    if (!snapshot) throw new Error("Unknown or expired evidence snapshot.")
    const owner = JSON.parse(await readFile(join(snapshot.directory, "leases", readerLease, "owner.json"), "utf8"))
    if (owner.host !== hostname() || !Number.isInteger(owner.pid) || owner.pid <= 0) throw new Error("Reader lease has no live local owner.")
    try { process.kill(owner.pid, 0) } catch (error) { if (error.code !== "EPERM") throw new Error("Reader lease owner is no longer running.") }
    lease = { snapshot, release: async () => {} }
  } else lease = await cache.lease(snapshotId)
  let reader
  try {
    reader = openEvidenceSnapshot(lease.snapshot.directory)
    return await action(reader, lease.snapshot)
  } finally { reader?.close(); await lease.release() }
}

class EvidenceQuery {
  constructor(db, snapshot, counter) { this.db = db; this.snapshot = snapshot; this.counter = counter }

  run(method, options) {
    const binding = { snapshotId: this.snapshot.snapshotId, version: this.snapshot.indexVersion, method,
      ...Object.fromEntries(Object.entries(options).filter(([key, value]) => key !== "cursor" && value !== undefined)) }
    this.binding = digest(binding)
    this.offset = 0
    if (options.cursor) {
      let decoded
      try { decoded = JSON.parse(Buffer.from(options.cursor, "base64url").toString("utf8")) } catch { throw new Error("Invalid evidence cursor.") }
      if (decoded.binding !== this.binding || !Number.isSafeInteger(decoded.offset) || decoded.offset < 0 ||
          decoded.check !== digest([decoded.binding, decoded.offset])) throw new Error("Cursor does not match this snapshot, command or filters.")
      this.offset = decoded.offset
    }
    if (method === "overview") return this.overview()
    if (method === "list_events") return this.events(options.filters)
    if (!options.eventId || !this.db.prepare("SELECT 1 FROM events WHERE event_id=?").get(options.eventId)) throw new Error("Unknown evidence event ID.")
    if (method === "get_event_details") return this.details(options)
    return this.content(options)
  }

  cursor(offset) { return Buffer.from(JSON.stringify({ binding: this.binding, offset, check: digest([this.binding, offset]) })).toString("base64url") }
  envelope(extra, more, offset) { return { snapshotId: this.snapshot.snapshotId, ...extra, hasMore: more, nextCursor: more ? this.cursor(offset) : null } }
  finish(value, limits = PAGE_LIMITS) {
    const result = fitsResponse(value, this.counter, limits)
    if (!result) throw new Error("Evidence response metadata exceeds the response limit.")
    return result
  }
  page(rows, total, make, extra, key = "items") {
    const items = []
    let accepted = this.finish(this.envelope({ ...extra, totalMatches: total, returnedCount: 0, [key]: [] }, total > this.offset, this.offset))
    for (const row of rows) {
      items.push(make(row))
      const next = this.offset + items.length
      const candidate = fitsResponse(this.envelope({ ...extra, totalMatches: total, returnedCount: items.length, [key]: items }, next < total, next), this.counter, PAGE_LIMITS)
      if (!candidate) { items.pop(); break }
      accepted = candidate
    }
    if (!items.length && total > this.offset) throw new Error("An evidence item exceeds the response limit; inspect its fields directly.")
    return accepted
  }
  node(event, path) { return this.db.prepare("SELECT * FROM event_fields WHERE event_id=? AND field_path=?").get(event, path) }
  children(event, parent) { return this.db.prepare("SELECT * FROM event_fields WHERE event_id=? AND parent_id=? ORDER BY ordinal").iterate(event, parent) }
  descriptor(row) {
    return { eventId: row.event_id, fieldId: row.field_id, kind: row.kind,
      ...(row.text_bytes !== null ? { bytes: row.text_bytes, lines: row.line_count } : {}) }
  }
  small(row, depth = 0) {
    if (!row) return undefined
    if (["object", "array"].includes(row.kind)) {
      const count = this.db.prepare("SELECT COUNT(*) AS n FROM event_fields WHERE event_id=? AND parent_id=?").get(row.event_id, row.field_id).n
      if (depth >= 2 || count > 8) return { ...this.descriptor(row), children: count }
      const entries = [...this.children(row.event_id, row.field_id)]
      if (entries.some((child) => Buffer.byteLength(child.key_json) > 200)) return { ...this.descriptor(row), children: count }
      const value = row.kind === "array" ? entries.map((child) => this.small(child, depth + 1)) :
        Object.fromEntries(entries.map((child) => [JSON.parse(child.key_json), this.small(child, depth + 1)]))
      return Buffer.byteLength(JSON.stringify(value)) > 512 ? { ...this.descriptor(row), children: count } : value
    }
    const value = JSON.parse(row.value_json)
    if (row.kind === "string" && (row.text_bytes > 200 || value?.$tarsContent)) return this.descriptor(row)
    return value
  }
  textChunks(row, key = false) {
    if (key) return [JSON.parse(row.key_json)]
    const value = JSON.parse(row.value_json)
    if (typeof value === "string") return [value]
    if (value?.$tarsContent) {
      const rows = this.db.prepare("SELECT text FROM event_content_chunks WHERE content_id=? ORDER BY chunk_no").iterate(value.$tarsContent)
      return (function* () { for (const chunk of rows) yield JSON.parse(chunk.text) })()
    }
    throw new Error("This field is not text; use get_event_details to inspect its children.")
  }
  excerpt(row, limit = 256) {
    if (!row || row.kind !== "string") return ""
    let result = ""
    for (const text of this.textChunks(row)) { result += preview(text, limit - [...result].length); if ([...result].length >= limit) break }
    return result
  }
  contentFields(event) {
    const fields = []
    const paths = ["/extra/text", "/extra/body", "/extra/state/output", "/extra/state/metadata/display/text",
      "/extra/result/formatted_output", "/extra/result/stdout", "/attributes/rawCommand", "/extra/state/input/command"]
    for (const path of paths) { const row = this.node(event, path); if (row?.kind === "string") fields.push({ ...this.descriptor(row), field: path }) }
    return fields
  }
  eventView(row) {
    const event = row.event_id
    const view = { eventId: event, role: row.role, type: row.event_type,
      nativeOrder: { sourceId: row.source_id, position: row.native_position }, blockId: row.block_id,
      ...(row.time_ms !== null ? { time: row.time_ms } : {}),
      contextSegmentId: this.small(this.node(event, "/contextSegmentId")),
      precedingCompactionEventId: this.small(this.node(event, "/precedingCompactionEventId")),
      source: this.small(this.node(event, "/pointer")), attributes: this.attributeView(event),
      details: this.descriptor(this.node(event, "/extra")), contentFields: this.contentFields(event) }
    const uncertain = this.node(event, "/blockBoundaryUncertain")
    if (uncertain) view.blockBoundaryUncertain = this.small(uncertain)
    // Parent OpenCode messages retain metadata; their text parts are separate events.
    const message = this.node(event, "/pointer/messageId")
    if (message && !this.node(event, "/pointer/partId")) {
      const id = JSON.parse(message.value_json)
      const partSql = " FROM events e JOIN event_facts f USING(event_id) WHERE source_id=? AND f.message_id=? AND EXISTS (SELECT 1 FROM event_fields p WHERE p.event_id=e.event_id AND p.field_path='/pointer/partId')"
      view.messagePartCount = this.db.prepare("SELECT COUNT(*) AS n" + partSql).get(row.source_id, id).n
      const parts = this.db.prepare("SELECT e.event_id" + partSql + " ORDER BY native_position LIMIT 8").all(row.source_id, id)
      view.contentFields.push(...parts.flatMap((part) => this.contentFields(part.event_id)).slice(0, 8))
      view.messagePartsFilter = { role: row.role, sourceId: row.source_id, messageId: id }
    }
    return view
  }

  attributeView(event) {
    const root = this.node(event, "/attributes")
    if (!root) return {}
    const result = { details: this.descriptor(root) }
    for (const key of ["name", "speaker", "outcome", "durationMs", "rawCommand", "parsedCommand", "extent",
      "visibleOutputBytes", "outputCompleteness", "normalizationLimit", "auto", "pairedTerminalEventId", "normalizedAction"]) {
      const node = this.node(event, `/attributes/${key}`)
      if (node) result[key] = this.small(node)
    }
    return result
  }

  overview() {
    const total = this.db.prepare("SELECT COUNT(*) AS n FROM blocks").get().n
    const rows = this.db.prepare("SELECT * FROM blocks ORDER BY rowid LIMIT -1 OFFSET ?").iterate(this.offset)
    const coverage = Object.fromEntries(Object.entries(this.snapshot.coverage ?? {}).map(([role, source]) => [role,
      { status: source.status, harness: source.harness, gapCount: source.gaps?.length ?? 0,
        ...(source.reason ? { reasonExcerpt: preview(source.reason) } : {}) }]))
    return this.page(rows, total, (row) => {
      const block = JSON.parse(row.metadata_json)
      const counts = this.db.prepare("SELECT e.event_type AS type,COUNT(*) AS count FROM events e WHERE block_id=? GROUP BY event_type").all(row.block_id)
      const sizes = this.db.prepare("SELECT SUM(f.visible_output_bytes) AS total, MAX(f.visible_output_bytes) AS maximum FROM event_facts f JOIN events e USING(event_id) WHERE block_id=?").get(row.block_id)
      const tools = this.db.prepare("SELECT COUNT(*) AS total, SUM(CASE WHEN f.action IS NOT NULL THEN 1 ELSE 0 END) AS normalized FROM event_facts f JOIN events e USING(event_id) WHERE block_id=? AND e.event_type='tool_call'").get(row.block_id)
      let excerpt = ""
      if (block.openingEventId) {
        const opening = this.db.prepare("SELECT event_id,source_id,block_id,role,event_type,native_position,time_ms FROM events WHERE event_id=?").get(block.openingEventId)
        for (const field of opening ? this.eventView(opening).contentFields : []) {
          const text = this.db.prepare("SELECT * FROM event_fields WHERE event_id=? AND field_id=?").get(field.eventId, field.fieldId)
          excerpt += this.excerpt(text, 256 - [...excerpt].length)
          if ([...excerpt].length >= 256) break
        }
      }
      return { blockId: row.block_id, role: block.role, start: block.start, end: block.end,
        boundaryConfidence: block.boundaryConfidence, headCommit: block.headCommit,
        dispatchEventId: block.dispatchEventId ?? null, openingEventId: block.openingEventId ?? null,
        ...(excerpt ? { openingMessageExcerpt: excerpt } : {}), eventCounts: counts, visibleOutputBytes: sizes,
        toolRecordCounts: { total: tools.total, normalized: tools.normalized ?? 0, unclassified: tools.total - (tools.normalized ?? 0) } }
    }, { cutoff: this.snapshot.cutoff, createdAt: this.snapshot.createdAt, coverage,
      gapCount: this.snapshot.gaps?.length ?? 0, eventCount: this.snapshot.eventCount,
      unassignedEventCount: this.db.prepare("SELECT COUNT(*) AS n FROM events WHERE block_id IS NULL").get().n,
      ordering: "Native source order; Codex records use known timestamps, with untimed records last. No order is implied between sources." }, "blocks")
  }

  events(filters) {
    const predicates = [], args = []
    for (const key of Object.keys(filters)) if (!FILTERS.has(key)) throw new Error(`Unknown event filter ${key}.`)
    for (const [key, column] of [["blockId", "e.block_id"], ["role", "e.role"], ["eventType", "e.event_type"], ["toolName", "f.tool_name"], ["action", "f.action"], ["query", "f.query"], ["sourceId", "e.source_id"], ["messageId", "f.message_id"]]) {
      if (filters[key] !== undefined) { predicates.push(`${column}=?`); args.push(filters[key]) }
    }
    if (filters.role && !["author", "reviewer"].includes(filters.role)) throw new Error("Invalid evidence role.")
    for (const [key, column, operator] of [["minVisibleOutputBytes", "f.visible_output_bytes", ">="], ["from", "e.time_ms", ">="], ["to", "e.time_ms", "<="]]) {
      if (filters[key] !== undefined) {
        if (!Number.isSafeInteger(filters[key]) || filters[key] < 0) throw new Error(`Invalid ${key} filter.`)
        predicates.push(`${column}${operator}?`); args.push(filters[key])
      }
    }
    if (filters.from !== undefined && filters.to !== undefined && filters.from > filters.to) throw new Error("Invalid time range.")
    if (filters.path !== undefined) { predicates.push("EXISTS (SELECT 1 FROM json_each(f.targets_json) p WHERE json_extract(p.value,'$.path')=?)"); args.push(filters.path) }
    if (filters.pathUnder !== undefined) {
      const path = filters.pathUnder.replace(/\/+$/, "") || "/"
      const prefix = path === "/" ? "/" : `${path}/`
      predicates.push("EXISTS (SELECT 1 FROM json_each(f.targets_json) p WHERE json_extract(p.value,'$.path')=? OR substr(json_extract(p.value,'$.path'),1,?)=?)")
      args.push(path, prefix.length, prefix)
    }
    const sql = " FROM events e JOIN event_facts f USING(event_id)" + (predicates.length ? " WHERE " + predicates.join(" AND ") : "")
    const total = this.db.prepare("SELECT COUNT(*) AS n" + sql).get(...args).n
    const rows = this.db.prepare("SELECT e.event_id,e.source_id,e.block_id,e.role,e.event_type,e.native_position,e.time_ms" + sql + " ORDER BY f.timeline_position LIMIT -1 OFFSET ?").iterate(...args, this.offset)
    return this.page(rows, total, (row) => this.eventView(row), {}, "events")
  }

  details({ eventId, field, fieldPath }) {
    if (field && fieldPath !== undefined) throw new Error("Specify field ID or field path, not both.")
    const root = field ? this.db.prepare("SELECT * FROM event_fields WHERE event_id=? AND field_id=?").get(eventId, field) : this.node(eventId, fieldPath ?? "/extra")
    if (!root) throw new Error("Unknown event field.")
    const compound = ["object", "array"].includes(root.kind)
    const total = compound ? this.db.prepare("SELECT COUNT(*) AS n FROM event_fields WHERE event_id=? AND parent_id=?").get(eventId, root.field_id).n : 1
    const rows = compound ? this.db.prepare("SELECT * FROM event_fields WHERE event_id=? AND parent_id=? ORDER BY ordinal LIMIT -1 OFFSET ?").iterate(eventId, root.field_id, this.offset) : this.offset === 0 ? [root] : []
    return this.page(rows, total, (row) => {
      const key = JSON.parse(row.key_json)
      return { key: preview(key), ...(String(key).length > 160 ? { keyTruncated: true, keyContent: {
        ...this.descriptor(row), fieldKey: true, bytes: Buffer.byteLength(key), lines: key.split("\n").length,
      } } : {}),
        ...this.descriptor(row), value: ["object", "array"].includes(row.kind) ? this.descriptor(row) : this.small(row) }
    }, { eventId, fieldId: root.field_id, kind: root.kind }, "fields")
  }

  content({ eventId, field, fieldKey, lineStart, lineEnd, byteStart, byteEnd }) {
    if (!field) throw new Error("Content requires a field ID from an event or details response.")
    const row = this.db.prepare("SELECT * FROM event_fields WHERE event_id=? AND field_id=?").get(eventId, field)
    if (!row || (!fieldKey && row.kind !== "string")) throw new Error("Unknown text field; use details for structured fields.")
    if (fieldKey && typeof JSON.parse(row.key_json) !== "string") throw new Error("This field has no text key.")
    const totalBytes = fieldKey ? Buffer.byteLength(JSON.parse(row.key_json)) : row.text_bytes
    const totalLines = fieldKey ? JSON.parse(row.key_json).split("\n").length : row.line_count
    const hasLines = lineStart !== undefined || lineEnd !== undefined
    const hasBytes = byteStart !== undefined || byteEnd !== undefined
    if (hasLines && hasBytes) throw new Error("Choose a line range or byte range.")
    if (hasLines && (fieldKey || totalLines <= 1)) throw new Error("Use byte ranges for text without line breaks.")
    let start = byteStart ?? 0, end = byteEnd ?? totalBytes
    if (hasLines) {
      const first = lineStart ?? 1, last = lineEnd ?? totalLines
      if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last) || first < 1 || last < first || last > totalLines) throw new Error("Invalid line range.")
      let line = 1, offset = 0
      start = first === 1 ? 0 : null; end = totalBytes
      for (const chunk of this.textChunks(row)) {
        for (const char of chunk) { offset += Buffer.byteLength(char); if (char === "\n") { line++; if (line === first) start = offset; if (line === last + 1) { end = offset; break } } }
        if (line > last) break
      }
      if (start === null) throw new Error("Line range is outside the field.")
    }
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end > totalBytes) throw new Error("Invalid byte range.")
    const requestedStart = start
    start += this.offset
    if (start > end) throw new Error("Cursor is outside the selected range.")
    let offset = 0, text = "", returned = 0
    for (const chunk of this.textChunks(row, fieldKey)) {
      for (const char of chunk) {
        const bytes = Buffer.byteLength(char), after = offset + bytes
        if ((offset < start && after > start) || (offset < end && after > end)) throw new Error("Byte range must use UTF-8 character boundaries.")
        if (offset >= start && after <= end) { text += char; returned += bytes }
        offset = after
        if (offset >= end || returned >= CONTENT_LIMITS.bytes) break
      }
      if (offset >= end || returned >= CONTENT_LIMITS.bytes) break
    }
    let characters = [...text]
    for (;;) {
      text = characters.join(""); returned = Buffer.byteLength(text)
      const next = start + returned
      const candidate = fitsResponse(this.envelope({ eventId, fieldId: field, fieldKey,
        text, returnedBytes: returned, totalBytes, totalLines, byteStart: start, byteEnd: next,
        requestedByteStart: requestedStart, requestedByteEnd: end,
        ...(hasLines ? { requestedLineStart: lineStart ?? 1, requestedLineEnd: lineEnd ?? totalLines } : {}) }, next < end, next - requestedStart), this.counter, CONTENT_LIMITS)
      if (candidate) return candidate
      if (!characters.length) throw new Error("Content envelope exceeds the response limit.")
      characters = characters.slice(0, Math.floor(characters.length / 2))
    }
  }
}
