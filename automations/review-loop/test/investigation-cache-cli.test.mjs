import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { mkdtemp, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import test from "node:test"
import { EvidenceSnapshots } from "../lib/investigation-snapshot.mjs"

const exec = promisify(execFile)
test("cache CLI lists size/expiry, removes selected IDs, prunes expired and rejects traversal", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "tars-cache-cli-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const cache = new EvidenceSnapshots({ root: join(root, "agent-review-loop", "evidence-indexes") })
  const old = new EvidenceSnapshots({ root: cache.root, now: () => new Date("2000-01-01") })
  const make = (laneId) => ({ laneId, collect: async () => ({ sources: [], events: [], asOf: "now" }) })
  const fresh = await cache.prepare(make("fresh"))
  const expired = await old.prepare(make("expired"))
  const run = (args) => exec(process.execPath, [new URL("../cli.mjs", import.meta.url).pathname,
    "lane", ...args, "--state", join(root, "state.sqlite")], { env: { ...process.env, XDG_CACHE_HOME: root } })
  const listed = await run(["indexes"])
  assert.match(listed.stdout, new RegExp(fresh.snapshotId + "\\tusable\\t\\d+ bytes\\texpires="))
  assert.match(listed.stdout, new RegExp(expired.snapshotId + "\\texpired/incompatible"))
  const lease = await cache.lease(fresh.snapshotId)
  await assert.rejects(run(["remove-index", "--snapshot-id", fresh.snapshotId]), /in use/)
  assert.match((await run(["prune-indexes"])).stdout, /Pruned 1/)
  await assert.rejects(stat(expired.directory), /ENOENT/)
  await assert.rejects(run(["remove-index"]), /requires --snapshot-id/)
  await assert.rejects(run(["remove-index", "--snapshot-id", "../../outside"]), /Unknown evidence snapshot/)
  await lease.release()
  assert.match((await run(["remove-index", "--snapshot-id", fresh.snapshotId])).stdout, /Removed evidence snapshot/)
  assert.equal((await run(["indexes"])).stdout, "")
  await assert.rejects(stat(join(root, "state.sqlite")), /ENOENT/)
})
