import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import test from "node:test"
import { EvidenceSnapshots, openEvidenceSnapshot } from "../lib/investigation-snapshot.mjs"
import { nativeArtifactRecords } from "../lib/investigation-records.mjs"
import { orderEvidenceEvents } from "../lib/investigation-fields.mjs"
import { queryEvidence } from "../lib/investigation-query.mjs"
import { localTokenCounter, measureResponse, PAGE_LIMITS, CONTENT_LIMITS } from "../lib/investigation-response.mjs"

const rough = { method: "test:characters", count: (text) => Math.ceil([...text].length / 4) }
const source = { id: "s", metadata: { role: "author", harness: "opencode" }, native: {} }
const makeEvent = (index, changes = {}) => ({ id: `E${index}`, sourceId: "s", role: "author", type: "tool_call",
  position: index, time: index * 10, blockId: "B", pointer: { harness: "opencode", sessionId: "ses_test" },
  attributes: { name: "bash", normalizedAction: { kind: "search", confidence: "inferred", query: "foo",
    targets: [{ path: "src/a.ts", visibleContent: true }] }, visibleOutputBytes: 123, outputCompleteness: "unknown" },
  extra: { state: { output: "visible text" } }, ...changes })
async function setup(t, events = [makeEvent(0)], options = {}) {
  const root = await mkdtemp(join(tmpdir(), "tars-query-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const cache = new EvidenceSnapshots({ root: join(root, "agent-review-loop/evidence-indexes") })
  const snapshot = await cache.prepare({ laneId: "lane", collect: async () => ({ sources: options.sources ?? [source], events,
    blocks: options.blocks ?? [{ id: "B", role: "author", start: 0, end: null, boundaryConfidence: "native" }],
    coverage: { author: { status: "available", harness: "opencode", gaps: [] } }, asOf: "2026-10-11T00:00:00Z" }) })
  return { root, cache, snapshot, query: (method, args = {}) => queryEvidence({ cache, snapshotId: snapshot.snapshotId, counter: rough, method, ...args }) }
}
function bounded(response, limits = PAGE_LIMITS, counter = rough) {
  const text = JSON.stringify(response) + "\n"
  assert.equal(response.responseBytes, Buffer.byteLength(text))
  assert(response.responseBytes <= limits.bytes)
  assert(response.estimatedTokens <= limits.tokens)
  assert(response.estimatedTokens >= counter.count(text))
}
async function all(query, method = "list_events", args = {}, key = "events") {
  const result = []; let cursor
  do { const page = await query(method, { ...args, cursor }); bounded(page); result.push(...page[key]); cursor = page.nextCursor } while (cursor)
  return result
}

test("long timelines page every event once in stable native order, with bounded serialized envelopes", async (t) => {
  const events = Array.from({ length: 1000 }, (_, i) => makeEvent(i))
  const { query } = await setup(t, events)
  const page = await query("list_events")
  assert.equal(page.totalMatches, 1000); assert(page.hasMore)
  const rows = await all(query)
  assert.deepEqual(rows.map((row) => row.eventId), events.map((event) => event.id))
  assert(rows.every((row) => !JSON.stringify(row).includes("visible text")))
})

test("filters combine before paging and preserve exact query, path-array and subtree semantics", async (t) => {
  const targets = (path) => ({ name: "bash", normalizedAction: { kind: "search", query: "foo", targets: [{ path: "other" }, { path }] }, visibleOutputBytes: 200 })
  const { query } = await setup(t, [makeEvent(0, { attributes: targets("src/a.ts") }), makeEvent(1, { attributes: targets("src-old/a.ts") }),
    makeEvent(2, { role: "reviewer", attributes: targets("src/a.ts") }), makeEvent(3, { attributes: { ...targets("src/b.ts"), normalizedAction: { ...targets("src/b.ts").normalizedAction, query: "FOO" } } }),
    makeEvent(4, { type: "native_other", attributes: {} })])
  assert.deepEqual((await all(query, "list_events", { filters: { role: "author", path: "src/a.ts", query: "foo", action: "search", toolName: "bash", blockId: "B", eventType: "tool_call", minVisibleOutputBytes: 200 } })).map((e) => e.eventId), ["E0"])
  assert.deepEqual((await all(query, "list_events", { filters: { pathUnder: "src/", role: "author" } })).map((e) => e.eventId), ["E0", "E3"])
  assert.equal((await query("list_events", { filters: { query: "fo" } })).totalMatches, 0)
  assert.equal((await query("list_events", { filters: { from: 10, to: 20 } })).totalMatches, 2)
  assert.equal((await query("list_events", { filters: { minVisibleOutputBytes: 201 } })).totalMatches, 0)
  await assert.rejects(query("list_events", { filters: { minVisibleOutputBytes: -1 } }), /Invalid/)
  await assert.rejects(query("list_events", { filters: { role: "unknown" } }), /Invalid/)
  await assert.rejects(query("list_events", { filters: { sql: "DELETE" } }), /Unknown event filter/)
})

test("cursors reject changed snapshot, method, filters, content range and malformed payloads", async (t) => {
  const { query, cache, snapshot } = await setup(t, Array.from({ length: 40 }, (_, i) => makeEvent(i, { extra: { text: "x".repeat(30000) } })))
  const cursor = (await query("list_events")).nextCursor
  assert(cursor)
  await assert.rejects(query("list_events", { filters: { role: "author" }, cursor }), /Cursor does not match/)
  await assert.rejects(query("overview", { cursor }), /Cursor does not match/)
  await assert.rejects(query("list_events", { cursor: "invalid" }), /Invalid evidence cursor/)
  const other = await cache.prepare({ laneId: "other", collect: async () => ({ sources: [], events: [], asOf: "now" }) })
  await assert.rejects(queryEvidence({ cache, snapshotId: other.snapshotId, method: "list_events", counter: rough, cursor }), /Cursor does not match/)
  const field = (await query("list_events")).events[0].contentFields[0].fieldId
  const content = await query("get_event_content", { eventId: "E0", field })
  await assert.rejects(query("get_event_content", { eventId: "E0", field, cursor: content.nextCursor, byteEnd: 10000 }), /Cursor does not match/)
  assert(snapshot.snapshotId)
})

test("large Unicode and escaped bodies page losslessly; UTF-8 ranges must land on character boundaries", async (t) => {
  const text = '\"\\\n🙂漢字'.repeat(4000)
  const { query } = await setup(t, [makeEvent(0, { extra: { text } })])
  const field = (await query("list_events")).events[0].contentFields[0].fieldId
  let cursor, reconstructed = "", pages = 0
  do {
    const page = await query("get_event_content", { eventId: "E0", field, cursor })
    bounded(page, CONTENT_LIMITS); reconstructed += page.text; cursor = page.nextCursor; pages++
  } while (cursor)
  assert.equal(reconstructed, text); assert(pages > 1)
  const page = await query("get_event_content", { eventId: "E0", field, byteStart: 3, byteEnd: 7 })
  assert.equal(page.text, "🙂")
  await assert.rejects(query("get_event_content", { eventId: "E0", field, byteStart: 4, byteEnd: 7 }), /UTF-8/)
})

test("line ranges include selected lines, page long lines and offer byte fallback for unbroken text", async (t) => {
  const { query } = await setup(t, [makeEvent(0, { extra: { text: "one\n" + "🙂".repeat(5000) + "\nthree\n" } }),
    makeEvent(1, { extra: { text: "x".repeat(30000) } })])
  const fields = (await query("list_events")).events.map((e) => e.contentFields[0].fieldId)
  let cursor, text = ""
  do { const page = await query("get_event_content", { eventId: "E0", field: fields[0], lineStart: 2, lineEnd: 2, cursor }); bounded(page, CONTENT_LIMITS); text += page.text; cursor = page.nextCursor } while (cursor)
  assert.equal(text, "🙂".repeat(5000) + "\n")
  assert.equal((await query("get_event_content", { eventId: "E0", field: fields[0], lineStart: 4, lineEnd: 4 })).text, "")
  await assert.rejects(query("get_event_content", { eventId: "E1", field: fields[1], lineStart: 1 }), /byte ranges/)
  await assert.rejects(query("get_event_content", { eventId: "E0", field: fields[0], lineStart: 0 }), /Invalid line/)
  await assert.rejects(query("get_event_content", { eventId: "E0", field: fields[0], lineStart: 2, byteStart: 0 }), /Choose/)
})

test("details expose unknown fields and huge nested bodies through IDs without eager expansion", async (t) => {
  const hugeKey = "long-key".repeat(3000)
  const extra = { future: { body: "PRIVATE".repeat(20000), special: { $tarsContent: "native" } }, [hugeKey]: "value", "a/b~c": [null, false, 0] }
  const { query, snapshot } = await setup(t, [makeEvent(0, { extra })])
  const details = await query("get_event_details", { eventId: "E0" }); bounded(details)
  assert(!JSON.stringify(details).includes("PRIVATE"))
  const future = details.fields.find((f) => f.key === "future")
  const nested = await query("get_event_details", { eventId: "E0", field: future.fieldId }); bounded(nested)
  const body = nested.fields.find((f) => f.key === "body")
  assert.equal((await query("get_event_content", { eventId: "E0", field: body.fieldId, byteEnd: 7 })).text, "PRIVATE")
  const key = details.fields.find((f) => f.keyTruncated)
  assert.equal((await query("get_event_content", { eventId: "E0", field: key.fieldId, fieldKey: true, byteEnd: 8 })).text, "long-key")
  assert.equal((await query("get_event_details", { eventId: "E0", fieldPath: "/extra/a~1b~0c" })).fields.length, 3)
  const reader = openEvidenceSnapshot(snapshot.directory)
  assert.deepEqual(reader.unpack(JSON.parse(reader.database.prepare("SELECT extra_json FROM events WHERE event_id='E0'").get().extra_json)), extra)
  reader.close()
})

test("details pagination handles wide arrays and leaf values without losing fields", async (t) => {
  const { query } = await setup(t, [makeEvent(0, { extra: { array: Array.from({ length: 400 }, (_, i) => `value-${i}`) } })])
  const fields = await all(query, "get_event_details", { eventId: "E0", fieldPath: "/extra/array" }, "fields")
  assert.deepEqual(fields.map((f) => f.value), Array.from({ length: 400 }, (_, i) => `value-${i}`))
  assert.equal((await query("get_event_details", { eventId: "E0", fieldPath: "/extra/array/3" })).fields[0].value, "value-3")
})

test("filtered rereads carry compaction context, with independent streams and uncertainty for tied Codex timestamps", async (t) => {
  const events = [makeEvent(0), makeEvent(1, { type: "compaction", attributes: {}, extra: {} }), makeEvent(2)]
  const { query } = await setup(t, events)
  const reads = (await query("list_events", { filters: { eventType: "tool_call" } })).events
  assert.notEqual(reads[0].contextSegmentId, reads[1].contextSegmentId)
  assert.equal(reads[1].precedingCompactionEventId, "E1")
  const codex = { ...source, metadata: { harness: "codex" } }
  const sorted = orderEvidenceEvents([makeEvent(1, { time: 20 }), makeEvent(2, { time: 20, type: "compaction" }), makeEvent(3, { time: 30 }), makeEvent(4, { time: undefined })], [codex])
  assert.equal(sorted[0].contextSegmentId, null)
  assert.equal(sorted[2].precedingCompactionEventId, "E2")
  assert.equal(sorted[3].contextSegmentId, null)
  const uncertain = orderEvidenceEvents([makeEvent(0), makeEvent(1, { type: "compaction", time: undefined })], [codex])
  assert(uncertain.every((e) => e.contextSegmentId === null))
})

test("both native adapters expose factual visible sizes and preserve large sparse command fields", async (t) => {
  const artifacts = []
  for (const [harness, name, role] of [["opencode", "opencode-export.json", "author"], ["codex", "codex-reduced.json", "reviewer"]]) {
    const native = JSON.parse(await readFile(new URL(`./fixtures/native/${name}`, import.meta.url), "utf8"))
    artifacts.push(nativeArtifactRecords(native, { role, harness, sessionId: "ses_fixture", bundle: "bundle", sourceId: harness }))
  }
  const { query } = await setup(t, artifacts.flatMap((a) => a.events).map((e) => ({ ...e, blockId: "B" })), { sources: artifacts.map((a) => a.source) })
  const large = await query("list_events", { filters: { minVisibleOutputBytes: 1 } })
  assert(large.events.some((e) => e.role === "author")); assert(large.events.some((e) => e.role === "reviewer"))
  assert(large.events.every((e) => e.attributes.outputCompleteness === "unknown"))
  assert.equal((await query("list_events", { filters: { eventType: "native_other" } })).totalMatches > 0, true)
})

test("overview pages blocks with counts, cutoff, unassigned coverage and native opening excerpts", async (t) => {
  const opening = makeEvent(0, { type: "message", extra: { body: "DISPATCH".repeat(10000) } })
  const blocks = Array.from({ length: 120 }, (_, i) => ({ id: `B${i}`, role: "author", start: i, end: i + 1, boundaryConfidence: "native", openingEventId: "E0" }))
  const { query } = await setup(t, [{ ...opening, blockId: "B0" }, makeEvent(1, { blockId: null })], { blocks })
  const first = await query("overview"); bounded(first); assert(first.hasMore)
  assert.equal(first.unassignedEventCount, 1)
  assert.equal(first.cutoff, "2026-10-11T00:00:00Z")
  assert(first.blocks[0].openingMessageExcerpt.startsWith("DISPATCH"))
  assert.equal((await all(query, "overview", {}, "blocks")).length, 120)
})

test("OpenCode parent messages expose their part content and a filter for the full native message", async (t) => {
  const native = { info: { id: "ses_test" }, messages: [{ info: { id: "m", role: "user", time: { created: 1 } }, parts: [
    { id: "p", sessionID: "ses_test", messageID: "m", type: "text", text: "opening dispatch text" } ] }] }
  const artifact = nativeArtifactRecords(native, { role: "author", harness: "opencode", sessionId: "ses_test", sourceId: "s" })
  const { query } = await setup(t, artifact.events.map((e) => ({ ...e, blockId: "B" })), { sources: [artifact.source] })
  const messages = (await query("list_events", { filters: { eventType: "message" } })).events
  assert.equal(messages[0].messagePartCount, 1)
  const part = messages[0].contentFields[0]
  assert.equal((await query("get_event_content", { eventId: part.eventId, field: part.fieldId })).text, "opening dispatch text")
  assert.equal((await query("list_events", { filters: messages[0].messagePartsFilter })).totalMatches, 2)
})

test("query errors release leases and read-only borrowed leases work without cache mutation", async (t) => {
  const { query, cache, snapshot } = await setup(t)
  await assert.rejects(query("get_event_details", { eventId: "missing" }), /Unknown evidence event/)
  assert.deepEqual(await readdir(join(snapshot.directory, "leases")), [])
  const lease = await cache.lease(snapshot.snapshotId)
  const before = (await stat(join(cache.root, "cache-lock.sqlite"))).mtimeMs
  await queryEvidence({ cache, snapshotId: snapshot.snapshotId, method: "list_events", readerLease: lease.leaseId, counter: rough })
  assert.equal((await stat(join(cache.root, "cache-lock.sqlite"))).mtimeMs, before)
  await lease.release()
  await assert.rejects(queryEvidence({ cache, snapshotId: snapshot.snapshotId, method: "list_events", readerLease: lease.leaseId, counter: rough }), /ENOENT/)
  await assert.rejects(queryEvidence({ cache, snapshotId: snapshot.snapshotId, method: "list_events", readerLease: "../../outside", counter: rough }), /Invalid reader/)
})

test("local tokenizer measures final JSON including escapes and labels its offline fallback", async (t) => {
  const counter = await localTokenCounter()
  assert.equal(counter.method, "local:o200k_base")
  assert.equal(counter.count("hello world"), 2)
  assert.equal(counter.count("<|endoftext|>"), 7)
  const response = measureResponse({ text: '🙂\\\"\n'.repeat(100) }, counter)
  bounded(response, PAGE_LIMITS, counter)
  const fallback = await localTokenCounter(async () => { throw new Error("missing ranks") })
  assert.match(fallback.method, /^approximate:/)
  assert.equal(fallback.count("abcdefgh"), 2)
  const { query, cache, snapshot } = await setup(t, [makeEvent(0, { extra: { text: "漢字🙂".repeat(5000) } })])
  const field = (await query("list_events")).events[0].contentFields[0].fieldId
  const page = await queryEvidence({ cache, snapshotId: snapshot.snapshotId, method: "get_event_content", eventId: "E0", field, counter })
  bounded(page, CONTENT_LIMITS, counter)
})

test("progressive CLI queries emit bounded JSON without opening lane state and reject bad ranges", async (t) => {
  const { root, snapshot } = await setup(t)
  const exec = promisify(execFile)
  const run = (args) => exec(process.execPath, [new URL("../cli.mjs", import.meta.url).pathname,
    "lane", "evidence", ...args, "--snapshot-id", snapshot.snapshotId, "--state", join(root, "state.sqlite")], { env: { ...process.env, XDG_CACHE_HOME: root } })
  const page = JSON.parse((await run(["list_events", "--role", "author", "--action", "search", "--query", "foo"])).stdout)
  bounded(page, PAGE_LIMITS, await localTokenCounter())
  assert.equal(page.events.length, 1)
  assert.match((await run(["overview"])).stdout, /cutoff/)
  await assert.rejects(run(["unknown"]), /Unknown evidence query/)
  await assert.rejects(run(["list_events", "--min-visible-output-bytes=-1"]), /nonnegative integer/)
  await assert.rejects(run(["list_events", "--from", "nonsense"]), /ISO timestamp/)
  await assert.rejects(stat(join(root, "state.sqlite")), /ENOENT/)
})

test("oversized commands and uncommon nested attributes cannot defeat event response limits", async (t) => {
  const command = '\"\\漢字'.repeat(20000)
  const attributes = { name: "bash", rawCommand: command, parsedCommand: Array.from({ length: 8 }, () => "x".repeat(190)),
    normalizedAction: { kind: "search", query: command, targets: Array.from({ length: 8 }, (_, i) => ({ path: "p".repeat(2000) + i })) },
    hugeUnknown: Array.from({ length: 1000 }, () => ({ sparse: "preserved" })) }
  const { query } = await setup(t, [makeEvent(0, { attributes })])
  const page = await query("list_events"); bounded(page)
  assert.equal(page.events[0].attributes.rawCommand.kind, "string")
  const full = await query("get_event_content", { eventId: "E0", field: page.events[0].attributes.rawCommand.fieldId, byteEnd: 2 })
  assert.equal(full.text, '\"\\')
  // Long literal values remain filterable even when their display value is a reference.
  assert.equal((await query("list_events", { filters: { query: command, path: "p".repeat(2000) + "7" } })).totalMatches, 1)
})

test("failed and truncated native outputs keep conservative sizes without claiming complete agent visibility", async (t) => {
  const native = JSON.parse(await readFile(new URL("./fixtures/native/opencode-export.json", import.meta.url), "utf8"))
  native.messages[0].parts[0].state.status = "error"
  native.messages[0].parts[1].state.metadata.truncated = true
  const { events } = nativeArtifactRecords(native, { role: "author", harness: "opencode", sessionId: "ses_fixture", sourceId: "s" })
  assert.equal(events.find((e) => e.pointer.partId === "part_read").attributes.visibleOutputBytes, undefined)
  const truncated = events.find((e) => e.pointer.partId === "part_bash")
  assert.equal(truncated.attributes.visibleOutputBytes, Buffer.byteLength("one\ntwo"))
  assert.equal(truncated.attributes.outputCompleteness, "unknown")
})

test("compaction in one role or source does not reset another role's context", async (t) => {
  const sources = [source, { ...source, id: "review", metadata: { harness: "opencode", role: "reviewer" } }]
  const { query } = await setup(t, [makeEvent(0), makeEvent(1, { type: "compaction" }), makeEvent(2),
    makeEvent(3, { sourceId: "review", role: "reviewer" }), makeEvent(4, { sourceId: "review", role: "reviewer" })], { sources })
  const rows = (await query("list_events")).events
  assert.notEqual(rows[0].contextSegmentId, rows[2].contextSegmentId)
  assert.equal(rows[3].contextSegmentId, rows[4].contextSegmentId)
  assert.equal(rows[3].precedingCompactionEventId, null)
  assert.notEqual(rows[2].contextSegmentId, rows[3].contextSegmentId)
})

test("empty result sets, empty bodies and zero-length byte ranges have no spurious continuation", async (t) => {
  const { query } = await setup(t, [makeEvent(0, { extra: { text: "" } })])
  const empty = await query("list_events", { filters: { blockId: "missing" } }); bounded(empty)
  assert.deepEqual(empty.events, []); assert.equal(empty.hasMore, false); assert.equal(empty.nextCursor, null)
  const field = (await query("list_events")).events[0].contentFields[0].fieldId
  const text = await query("get_event_content", { eventId: "E0", field, byteStart: 0, byteEnd: 0 }); bounded(text, CONTENT_LIMITS)
  assert.equal(text.text, ""); assert.equal(text.hasMore, false)
  await assert.rejects(query("get_event_content", { eventId: "E0", field, byteEnd: 1 }), /Invalid byte range/)
  await assert.rejects(query("get_event_details", { eventId: "E0", fieldPath: "/extra/missing" }), /Unknown event field/)
})

test("details preserve literal reference-like objects and special JSON-pointer keys", async (t) => {
  const { query } = await setup(t, [makeEvent(0, { extra: { special: { $tarsContent: "literal native field" }, "": false } })])
  const special = await query("get_event_details", { eventId: "E0", fieldPath: "/extra/special" })
  assert.equal(special.fields[0].key, "$tarsContent")
  assert.equal(special.fields[0].value, "literal native field")
  assert.equal((await query("get_event_details", { eventId: "E0", fieldPath: "/extra/" })).fields[0].value, false)
})

test("expired or incompatible snapshots reject queries; old cursors do not follow forced refreshes", async (t) => {
  const { query, snapshot, cache } = await setup(t, Array.from({ length: 50 }, (_, i) => makeEvent(i)))
  const cursor = (await query("list_events")).nextCursor
  const fresh = await cache.prepare({ laneId: "lane", force: true, collect: async () => ({ sources: [], events: [], asOf: "now" }) })
  await assert.rejects(queryEvidence({ cache, snapshotId: fresh.snapshotId, method: "list_events", cursor, counter: rough }), /Cursor does not match/)
  const manifestPath = join(snapshot.directory, "manifest.json")
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"))
  await writeFile(manifestPath, JSON.stringify({ ...manifest, expiresAt: "2000-01-01" }))
  await assert.rejects(query("list_events"), /expired/)
  await writeFile(manifestPath, JSON.stringify({ ...manifest, indexVersion: 999 }))
  await assert.rejects(query("list_events"), /expired/)
})
