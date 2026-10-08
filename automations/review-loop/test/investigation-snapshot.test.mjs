import assert from "node:assert/strict"
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { EvidenceSnapshots, evidenceCacheRoot, openEvidenceSnapshot } from "../lib/investigation-snapshot.mjs"
import { nativeArtifactRecords, NORMALIZATION_REGISTRY } from "../lib/investigation-records.mjs"

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), "tars-snapshot-test-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  let time = new Date("2026-10-08T12:00:00Z")
  return { root, cache: new EvidenceSnapshots({ root, now: () => time }), advance: (ms) => { time = new Date(+time + ms) } }
}
function evidence(native = { text: "hello" }) {
  return { asOf: "2026-10-08T11:59:00Z", sources: [{ id: "s1", metadata: { role: "author", harness: "opencode", status: "available" }, native }],
    blocks: [{ id: "author:initial" }], events: [{ id: "E1", sourceId: "s1", blockId: "author:initial", role: "author", type: "message", extra: native }] }
}

test("snapshot reuse never recollects evidence; force publishes a separate immutable database", async (t) => {
  const { cache } = await setup(t)
  let calls = 0
  const collect = async () => { calls++; return evidence({ revision: calls }) }
  const first = await cache.prepare({ laneId: "/repo", collect })
  const reused = await cache.prepare({ laneId: "/repo", collect })
  assert.equal(reused.snapshotId, first.snapshotId)
  assert.equal(reused.reused, true)
  assert.equal(calls, 1)
  const forced = await cache.prepare({ laneId: "/repo", collect, force: true })
  assert.notEqual(forced.snapshotId, first.snapshotId)
  assert.equal((await cache.prepare({ laneId: "/repo", collect })).snapshotId, forced.snapshotId)
  assert.equal(calls, 2)
  for (const [snapshot, revision] of [[first, 1], [forced, 2]]) {
    const reader = openEvidenceSnapshot(snapshot.directory)
    assert.deepEqual(reader.native("s1"), { revision }); reader.close()
  }
  assert.equal((await cache.list()).length, 2)
})

test("expired snapshots are swept and reads do not extend seven-day retention", async (t) => {
  const { cache, advance } = await setup(t)
  const first = await cache.prepare({ laneId: "lane", collect: async () => evidence() })
  advance(6 * 86400000)
  const reused = await cache.prepare({ laneId: "lane", collect: async () => { throw new Error("must reuse") } })
  assert.equal(reused.expiresAt, first.expiresAt)
  advance(86400000)
  const next = await cache.prepare({ laneId: "lane", collect: async () => evidence() })
  assert.notEqual(next.snapshotId, first.snapshotId)
  await assert.rejects(stat(first.directory), { code: "ENOENT" })
})

test("failed collection and failed SQL insertion leave no published or staging snapshot", async (t) => {
  const { cache, root } = await setup(t)
  await assert.rejects(cache.prepare({ laneId: "lane", collect: async () => { throw new Error("export failed") } }), /export failed/)
  const bad = evidence(); bad.events.push(bad.events[0])
  await assert.rejects(cache.prepare({ laneId: "lane", collect: async () => bad }), /UNIQUE/)
  assert.deepEqual(await cache.list(), [])
  for (const lane of await readdir(root)) assert.deepEqual(await readdir(join(root, lane)), [])
})

test("Unicode bodies, sparse unknown fields and reference-like native objects round-trip losslessly", async (t) => {
  const { cache } = await setup(t)
  const body = "🙂漢字\n".repeat(10000) + "\ud800"
  const native = { body, duplicate: body, sparse: [null, false, 0, { strange: "field" }],
    special: { $tarsContent: "native-not-reference" }, another: { $tarsLiteral: [["a", "b"]] } }
  const snapshot = await cache.prepare({ laneId: "lane", collect: async () => evidence(native) })
  const reader = openEvidenceSnapshot(snapshot.directory)
  t.after(() => reader.close())
  assert.deepEqual(reader.native("s1"), native)
  const chunks = reader.database.prepare("SELECT * FROM event_content_chunks").all()
  assert.ok(chunks.length > 1)
  assert.equal(new Set(chunks.map((row) => row.content_id)).size, 1)
  assert.ok(chunks.every((row) => row.bytes <= 8192))
  const extra = reader.database.prepare("SELECT extra_json FROM events").get()
  assert.deepEqual(reader.unpack(JSON.parse(extra.extra_json)), native)
  assert.throws(() => reader.native("missing"), /Unknown evidence source/)
  assert.throws(() => reader.database.exec("DELETE FROM events"), /readonly/)
  assert.equal((await stat(snapshot.directory)).mode & 0o777, 0o700)
  assert.equal((await stat(join(snapshot.directory, "evidence.sqlite"))).mode & 0o777, 0o600)
})

test("lane isolation, explicit deletion and cache path selection", async (t) => {
  const { cache } = await setup(t)
  const a = await cache.prepare({ laneId: "../../lane-a", collect: async () => evidence() })
  const b = await cache.prepare({ laneId: "lane-b", collect: async () => evidence() })
  assert.notEqual(a.directory, b.directory)
  await assert.rejects(cache.remove("../../outside"), /Unknown/)
  await cache.remove(a.snapshotId)
  assert.deepEqual((await cache.list()).map((item) => item.snapshotId), [b.snapshotId])
  assert.equal(evidenceCacheRoot({ XDG_CACHE_HOME: "/cache" }), "/cache/agent-review-loop/evidence-indexes")
})

test("incompatible snapshots rebuild; staging and malformed manifests are never reusable", async (t) => {
  const { cache } = await setup(t)
  const first = await cache.prepare({ laneId: "lane", collect: async () => evidence() })
  const manifestPath = join(first.directory, "manifest.json")
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"))
  await writeFile(manifestPath, JSON.stringify({ ...manifest, indexVersion: 999 }))
  assert.equal((await cache.list())[0].usable, false)
  const next = await cache.prepare({ laneId: "lane", collect: async () => evidence() })
  assert.notEqual(first.snapshotId, next.snapshotId)
  await writeFile(manifestPath, "invalid JSON")
  await mkdir(join(next.directory, "..", ".staging-interrupted"))
  assert.equal((await cache.list()).length, 1)
})

test("active leases prevent expiry pruning and explicit removal", async (t) => {
  const { cache, advance } = await setup(t)
  const snapshot = await cache.prepare({ laneId: "lane", collect: async () => evidence() })
  const lease = join(snapshot.directory, "leases", "analyst")
  await mkdir(lease, { recursive: true })
  advance(8 * 86400000)
  assert.deepEqual(await cache.prune(), [])
  await assert.rejects(cache.remove(snapshot.snapshotId), /in use/)
  await rm(lease, { recursive: true })
  assert.deepEqual(await cache.prune(), [snapshot.snapshotId])
})

test("native adapter registry preserves both fixture artifacts and exposes unknown records", async (t) => {
  const { cache } = await setup(t)
  const sources = [], events = []
  for (const [harness, name, role] of [["opencode", "opencode-export.json", "author"], ["codex", "codex-reduced.json", "reviewer"]]) {
    const native = JSON.parse(await readFile(new URL(`./fixtures/native/${name}`, import.meta.url), "utf8"))
    native.future_field = { future: "preserve this" }
    const records = nativeArtifactRecords(native, { harness, role, sessionId: "ses_fixture", bundle: "bundle", sourceId: harness })
    sources.push(records.source); events.push(...records.events)
    assert.ok(records.events.some((event) => event.type === "native_other"))
    assert.ok(records.events.some((event) => event.type === "tool_call"))
  }
  const snapshot = await cache.prepare({ laneId: "lane", collect: async () => ({ sources, events, asOf: "now" }) })
  const reader = openEvidenceSnapshot(snapshot.directory)
  for (const source of sources) assert.deepEqual(reader.native(source.id), source.native)
  reader.close()
  assert.equal(NORMALIZATION_REGISTRY.version, 1)
  assert.equal(events.find((event) => event.pointer.partId === "part_read").attributes.normalizedAction.kind, "read")
  const paired = events.find((event) => event.pointer.section === "tool_calls")
  assert.ok(paired.attributes.pairedTerminalEventId)
  assert.throws(() => nativeArtifactRecords({}, { role: "observer", harness: "codex", sourceId: "s" }), /Invalid evidence role/)
})

test("distinct malformed Unicode strings do not collide in content deduplication", async (t) => {
  const { cache } = await setup(t)
  const native = { a: "x".repeat(2048) + "\ud800", b: "x".repeat(2048) + "�" }
  const snapshot = await cache.prepare({ laneId: "lane", collect: async () => evidence(native) })
  const reader = openEvidenceSnapshot(snapshot.directory)
  assert.deepEqual(reader.native("s1"), native)
  assert.equal(reader.database.prepare("SELECT COUNT(DISTINCT content_id) AS n FROM event_content_chunks").get().n, 2)
  reader.close()
})

test("foreign-key failures preserve the last usable snapshot", async (t) => {
  const { cache } = await setup(t)
  const first = await cache.prepare({ laneId: "lane", collect: async () => evidence() })
  const bad = evidence(); bad.events[0].blockId = "nonexistent"
  await assert.rejects(cache.prepare({ laneId: "lane", force: true, collect: async () => bad }), /FOREIGN KEY/)
  const reused = await cache.prepare({ laneId: "lane", collect: async () => { throw new Error("must reuse") } })
  assert.equal(reused.snapshotId, first.snapshotId)
})

test("OpenCode unknown parts, accounting and compaction remain individually queryable", () => {
  const part = (id, type, extra = {}) => ({ id, type, sessionID: "ses_test", messageID: "msg_test", ...extra })
  const native = { info: { id: "ses_test" }, messages: [{ info: { id: "msg_test", role: "user", time: { created: 100 } },
    parts: [part("p1", "text", { text: "task" }), part("p2", "step-finish", { tokens: { input: 42 } }),
      part("p3", "compaction", { auto: true }), part("p4", "future-part", { field: "keep" })] }] }
  const { events } = nativeArtifactRecords(native, { harness: "opencode", role: "author", sessionId: "ses_test", sourceId: "s" })
  assert.deepEqual(events.map((event) => event.type), ["native_other", "message", "message", "native_accounting", "compaction", "native_other"])
  assert.equal(events.find((event) => event.type === "compaction").attributes.auto, true)
  assert.deepEqual(events.at(-1).extra, native.messages[0].parts.at(-1))
})
