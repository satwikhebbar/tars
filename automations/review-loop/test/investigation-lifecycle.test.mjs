import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { EvidenceSnapshots, openEvidenceSnapshot } from "../lib/investigation-snapshot.mjs"
import { createNativeSources } from "../lib/investigation-evidence.mjs"
import { nativeArtifactRecords } from "../lib/investigation-records.mjs"
import { prepareLaneEvidence, snapshotEvidence } from "../lib/investigation-prepare.mjs"
import { markedDispatch } from "../lib/investigation-dispatch.mjs"
import { indexOpenCode } from "../lib/investigation-index.mjs"

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), "tars-lifecycle-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  let time = new Date("2026-10-01")
  return { root, cache: new EvidenceSnapshots({ root: join(root, "cache"), now: () => time }),
    advance: () => { time = new Date("2026-10-09") } }
}
const empty = () => ({ sources: [], events: [], asOf: "2026-10-01" })

test("concurrent publishers serialize and reuse one complete snapshot", async (t) => {
  const { cache } = await setup(t)
  let collections = 0
  const collect = async () => { collections++; await new Promise((resolve) => setTimeout(resolve, 100)); return empty() }
  const [a, b] = await Promise.all([cache.prepare({ laneId: "lane", collect }),
    new EvidenceSnapshots({ root: cache.root, now: cache.now }).prepare({ laneId: "lane", collect })])
  assert.equal(collections, 1)
  assert.equal(a.snapshotId, b.snapshotId)
  assert.equal([a, b].filter((item) => item.reused).length, 1)
})

test("reader lease pins expired snapshots until release and is idempotent", async (t) => {
  const { cache, advance } = await setup(t)
  const snapshot = await cache.prepare({ laneId: "lane", collect: async () => empty() })
  const lease = await cache.lease(snapshot.snapshotId)
  const reader = openEvidenceSnapshot(lease.snapshot.directory)
  advance()
  await assert.rejects(cache.remove(snapshot.snapshotId), /in use/)
  assert.deepEqual(await cache.prune(), [])
  assert.equal(reader.database.prepare("SELECT COUNT(*) AS n FROM events").get().n, 0)
  reader.close()
  await lease.release(); await lease.release()
  await assert.rejects(cache.lease(snapshot.snapshotId), /expired/)
  assert.deepEqual(await cache.prune(), [snapshot.snapshotId])
})

test("SIGKILL releases mutation lock and abandoned staging is recovered", async (t) => {
  const { cache } = await setup(t)
  const module = new URL("../lib/investigation-snapshot.mjs", import.meta.url).href
  const child = spawn(process.execPath, ["--input-type=module", "-e", `
    import { EvidenceSnapshots } from ${JSON.stringify(module)};
    await new EvidenceSnapshots({root:process.argv[1]}).prepare({laneId:'lane',collect:async()=>{
      process.send('locked'); setInterval(()=>{},1000); await new Promise(()=>{});
    }});
  `, cache.root], { stdio: ["ignore", "ignore", "pipe", "ipc"] })
  t.after(() => child.kill("SIGKILL"))
  await Promise.race([once(child, "message"), once(child, "exit").then(([code]) => { throw new Error(`Test child exited early: ${code}`) })])
  const exited = once(child, "exit"); child.kill("SIGKILL"); await exited
  const snapshot = await cache.prepare({ laneId: "lane", collect: async () => empty() })
  assert.ok(snapshot.usable)
  assert.deepEqual(await readdir(join(snapshot.directory, "..")), [snapshot.snapshotId])
})

test("dead reader lease and incomplete lease publication are recovered", async (t) => {
  const { cache, advance } = await setup(t)
  const snapshot = await cache.prepare({ laneId: "lane", collect: async () => empty() })
  const module = new URL("../lib/investigation-snapshot.mjs", import.meta.url).href
  const child = spawn(process.execPath, ["--input-type=module", "-e", `
    import { EvidenceSnapshots } from ${JSON.stringify(module)};
    await new EvidenceSnapshots({root:process.argv[1],now:()=>new Date('2026-10-01')}).lease(process.argv[2]);
    process.send('leased'); setInterval(()=>{},1000);
  `, cache.root, snapshot.snapshotId], { stdio: ["ignore", "ignore", "pipe", "ipc"] })
  t.after(() => child.kill("SIGKILL"))
  await Promise.race([once(child, "message"), once(child, "exit").then(([code]) => { throw new Error(`Test child exited early: ${code}`) })])
  await assert.rejects(cache.remove(snapshot.snapshotId), /in use/)
  const exited = once(child, "exit"); child.kill("SIGKILL"); await exited
  await mkdir(join(snapshot.directory, ".lease-pending-interrupted"))
  advance()
  assert.deepEqual(await cache.prune(), [snapshot.snapshotId])
})

function openCode(messages) {
  return { info: { id: "ses_test" }, messages: messages.map(([id, time, text]) => ({
    info: { id, time: { created: time }, role: "user" },
    parts: [{ id: `part_${id}`, messageID: id, sessionID: "ses_test", type: "text", text }],
  })) }
}
function role(native) {
  return { status: "available", harness: "opencode",
    segments: [indexOpenCode(native, { role: "author", sessionId: "ses_test" })],
    artifacts: [nativeArtifactRecords(native, { role: "author", harness: "opencode", sessionId: "ses_test", sourceId: "s" })] }
}

test("generic messages get native dispatch blocks and metadata markers without duplicated prompts", () => {
  const dispatch = markedDispatch("PRIVATE TASK")
  const native = openCode([["before", 90, "before"], ["opening", 100, dispatch.message], ["after", 110, "after"]])
  const result = snapshotEvidence({ asOf: "now", roles: { author: role(native), reviewer: { status: "unavailable", harness: "codex", reason: "missing" } } },
    { deliveries: new Map([["lane-start", { createdAt: new Date(105).toISOString(), dispatchId: dispatch.id, destinationRole: "author" }]]) })
  const block = result.blocks.find((block) => block.id === "author:initial")
  assert.equal(block.start, 100)
  assert.equal(block.boundaryConfidence, "native")
  assert.equal(result.events.find((event) => event.id === block.openingEventId).pointer.messageId, "opening")
  assert.equal(result.events.find((event) => event.pointer.messageId === "after").blockId, block.id)
  assert.equal(result.events.find((event) => event.pointer.messageId === "before").blockId, null)
  const marker = result.events.find((event) => event.id === block.dispatchEventId)
  assert.equal(marker.type, "dispatch")
  assert.equal(marker.attributes.nativeMessageEventId, block.openingEventId)
  assert.doesNotMatch(JSON.stringify(marker), /PRIVATE TASK/)
  assert.deepEqual(result.gaps, ["reviewer: missing"])
})

test("approximate boundaries preserve uncertain ties and untimed records", () => {
  const native = openCode([["tie", 100, "no ID"], ["after", 110, "after"]])
  const result = snapshotEvidence({ asOf: "now", roles: { author: role(native), reviewer: { status: "available" } } },
    { deliveries: new Map([["lane-start", new Date(100).toISOString()]]) })
  assert.equal(result.events.find((event) => event.pointer.messageId === "tie").blockId, null)
  assert.equal(result.events.find((event) => event.pointer.messageId === "after").blockBoundaryUncertain, true)
  assert.equal(result.events.find((event) => event.type === "native_other").blockId, null)
})

test("snapshot collection parses exports over 16 MiB and retains all sparse fields", async (t) => {
  const { cache } = await setup(t)
  const native = openCode([["m", 100, "body"]]); native.sparse = "x".repeat(16 * 1024 * 1024)
  let file
  const sources = createNativeSources(async (_cmd, _args, output) => { file = output; await writeFile(output, JSON.stringify(native)) })
  const result = await sources.inspect({ role: "author", harness: "opencode", includeRecords: true,
    evidence: { status: "available", harness: "opencode", nativeSessionId: "ses_test" } })
  assert.equal(result.status, "available")
  assert.ok(result.bytes > 16 * 1024 * 1024)
  const artifact = result.artifacts[0]
  const snapshot = await cache.prepare({ laneId: "lane", collect: async () => ({ sources: [artifact.source], events: artifact.events, asOf: "now" }) })
  const reader = openEvidenceSnapshot(snapshot.directory)
  assert.deepEqual(reader.native(artifact.source.id), native)
  reader.close()
  await assert.rejects(readFile(file), /ENOENT/)
})

test("active lane cache reuse skips AoE and exports; force validates runtime and preserves prior cache on failure", async (t) => {
  const { root, cache } = await setup(t)
  const lane = { worktreePath: root, investigationCapture: "capture", authorSessionId: "a", reviewerSessionId: "r",
    authorHarness: "opencode", reviewerHarness: "codex" }
  const state = { lane: () => lane }
  let calls = 0, busy = false
  const aoe = { runtimeSessions: async () => { calls++; return [{ session: "a", state: busy ? "running" : "idle" }, { session: "r", state: "idle" }] } }
  const sources = { inspect: async ({ role: name }) => name === "author" ? role(openCode([["m", 100, "task"]])) : { status: "unavailable", reason: "missing" } }
  const options = { state, aoe, cache, sources, worktreePath: root }
  const first = await prepareLaneEvidence(options)
  assert.equal(calls, 2)
  busy = true
  const reused = await prepareLaneEvidence(options)
  assert.equal(reused.snapshotId, first.snapshotId)
  assert.equal(calls, 2)
  await assert.rejects(prepareLaneEvidence({ ...options, force: true }), /idle or waiting/)
  assert.equal((await cache.list()).length, 1)
  lane.investigationCapture = "off"
  await assert.rejects(prepareLaneEvidence(options), /not started/)
})

test("both native collectors persist complete fixtures and recoverable historical source gaps", async (t) => {
  const { root, cache } = await setup(t)
  const traceRoot = join(root, "traces")
  await mkdir(join(traceRoot, "bundle"), { recursive: true })
  await writeFile(join(traceRoot, "bundle", "manifest.json"), "{}")
  const opencode = JSON.parse(await readFile(new URL("./fixtures/native/opencode-export.json", import.meta.url), "utf8"))
  const codex = JSON.parse(await readFile(new URL("./fixtures/native/codex-reduced.json", import.meta.url), "utf8"))
  const outputs = []
  const sources = createNativeSources(async (command, args, output) => {
    outputs.push(output)
    if (args[1] === "ses_missing") throw new Error("historical session missing")
    await writeFile(output, JSON.stringify(command === "opencode" ? opencode : codex))
  })
  const lane = { worktreePath: root, investigationCapture: "capture", authorSessionId: "a", reviewerSessionId: "r",
    authorHarness: "opencode", reviewerHarness: "codex",
    authorEvidence: { status: "available", harness: "opencode", nativeSessionId: "ses_fixture",
      previous: [{ status: "available", harness: "opencode", nativeSessionId: "ses_missing" }] },
    reviewerEvidence: { status: "available", harness: "codex", traceRoot } }
  const snapshot = await prepareLaneEvidence({ state: { lane: () => lane },
    aoe: { runtimeSessions: async () => [{ session: "a", state: "idle" }, { session: "r", state: "waiting" }] },
    worktreePath: root, cache, sources })
  assert.equal(snapshot.coverage.author.status, "partial")
  assert.equal(snapshot.coverage.reviewer.status, "available")
  assert.match(snapshot.gaps.join("\n"), /historical session missing/)
  const reader = openEvidenceSnapshot(snapshot.directory)
  for (const source of snapshot.sources.filter((item) => item.harness !== "tars")) {
    assert.deepEqual(reader.native(source.sourceId), source.harness === "opencode" ? opencode : codex)
  }
  assert.equal(reader.database.prepare("SELECT COUNT(DISTINCT role) AS n FROM events WHERE source_id != 'tars:dispatch-journal'").get().n, 2)
  reader.close()
  for (const output of outputs) await assert.rejects(readFile(output), /ENOENT/)
})

test("a changing dispatch journal aborts publication even if both sessions stay idle", async (t) => {
  const { root, cache } = await setup(t)
  let changed = false
  const lane = { investigationCapture: "capture", authorSessionId: "a", reviewerSessionId: "r" }
  const state = { lane: () => lane, dispatchRecords: () => changed ? new Map([["lane-start", "2026-10-01"]]) : new Map() }
  await assert.rejects(prepareLaneEvidence({ state, cache, worktreePath: root,
    aoe: { runtimeSessions: async () => [{ session: "a", state: "idle" }, { session: "r", state: "idle" }] },
    sources: { inspect: async () => { changed = true; return { status: "available", segments: [], artifacts: [] } } },
  }), /dispatches changed/)
  assert.deepEqual(await cache.list(), [])
})

test("Codex native opening-message reference and compaction are assigned to generic blocks", async () => {
  const dispatch = markedDispatch("Review")
  const native = { schema_version: 1, trace_id: "trace", rollout_id: "rollout", terminal_operations: {},
    compactions: { c: { installed_at_unix_ms: 120 } },
    conversation_items: { m: { item_id: "m", role: "user", body: dispatch.message, first_seen_at_unix_ms: 100 } } }
  const { indexCodex } = await import("../lib/investigation-index.mjs")
  const result = snapshotEvidence({ asOf: "now", roles: { author: { status: "available" }, reviewer: {
    status: "available", segments: [indexCodex(native, { role: "reviewer", bundle: "bundle" })],
    artifacts: [nativeArtifactRecords(native, { role: "reviewer", harness: "codex", bundle: "bundle", sourceId: "codex" })],
  } } }, { deliveries: new Map([["review-key", { createdAt: new Date(105).toISOString(), dispatchId: dispatch.id, destinationRole: "reviewer" }]]) })
  const block = result.blocks.find((block) => block.id === "reviewer:review-key")
  assert.equal(result.events.find((event) => event.id === block.openingEventId).pointer.key, "m")
  assert.equal(result.events.find((event) => event.type === "compaction").blockId, block.id)
})

test("successful force publishes a new snapshot; a relaunched lane at the same path cannot reuse it", async (t) => {
  const { root, cache } = await setup(t)
  const lane = { investigationCapture: "capture", authorSessionId: "a", reviewerSessionId: "r" }
  let start = "2026-10-01"
  const options = { worktreePath: root, cache, state: { lane: () => lane, dispatchRecords: () => new Map([["lane-start", start]]) },
    aoe: { runtimeSessions: async () => [{ session: "a", state: "idle" }, { session: "r", state: "idle" }] },
    sources: { inspect: async () => ({ status: "unavailable", reason: "missing" }) } }
  const first = await prepareLaneEvidence(options)
  const forced = await prepareLaneEvidence({ ...options, force: true })
  assert.notEqual(first.snapshotId, forced.snapshotId)
  assert.equal((await prepareLaneEvidence(options)).snapshotId, forced.snapshotId)
  start = "2026-10-02"
  const relaunched = await prepareLaneEvidence(options)
  assert.notEqual(relaunched.laneId, forced.laneId)
  assert.equal(relaunched.reused, false)
})
