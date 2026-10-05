import assert from "node:assert/strict"
import test from "node:test"
import { summarizeNavigation } from "../lib/investigation-metrics.mjs"

test("counts confirmed full rereads but excludes partial reads and resets at compaction", () => {
  const read = (id, full, time) => ({ kind: "read", visible: true, path: "a.ts", cwd: "/repo",
    extent: { full }, pointer: { id }, time, blockId: "author:initial" })
  const summary = summarizeNavigation([{ events: [read(1, true, 1), read(2, false, 2), read(3, true, 3),
    { kind: "compaction", time: 4, pointer: { id: 4 }, blockId: "author:initial" }, read(5, true, 5)] }])
  assert.equal(summary.observedFileBreadthLowerBound, 1)
  assert.equal(summary.repeatedFullReads.length, 1)
  assert.deepEqual(summary.repeatedFullReads[0].first, { id: 1 })
  assert.deepEqual(summary.repeatedFullReads[0].again, { id: 3 })
})

test("exact search repeats stay within one segment and reset on compaction", () => {
  const search = (id, time) => ({ kind: "search", query: "needle", path: "a.ts", pointer: { id }, time,
    blockId: "reviewer:initial" })
  const summary = summarizeNavigation([{ events: [search(1, 1), search(2, 2),
    { kind: "compaction", time: 3, blockId: "reviewer:initial" }, search(3, 4)] },
  { events: [search(4, 5)] }])
  assert.equal(summary.repeatedExactSearches.length, 1)
  assert.deepEqual(summary.repeatedExactSearches[0].again, { id: 2 })
})

test("unknown and unassigned events remain explicit coverage gaps", () => {
  const summary = summarizeNavigation([{ events: [
    { kind: "unknown", time: 1, blockId: null },
    { kind: "read", visible: false, path: "named-only.ts", time: 2, blockId: "author:initial" },
  ] }])
  assert.equal(summary.observedFileBreadthLowerBound, 0)
  assert.equal(summary.coverage.unclassifiedEvents, 1)
  assert.equal(summary.coverage.unassignedEvents, 1)
})

test("native event order keeps OpenCode compaction between reads with tied timestamps", () => {
  const read = (id, time) => ({ kind: "read", visible: true, path: "a.ts", cwd: "/repo",
    extent: { full: true }, pointer: { id }, time, order: id, blockId: "author:initial" })
  const summary = summarizeNavigation([{ events: [read(1, 101),
    { kind: "compaction", time: 100, order: 2, blockId: "author:initial" }, read(3, 102)] }])
  assert.equal(summary.repeatedFullReads.length, 0)
})

test("normalizes relative file paths while keeping different directories separate", () => {
  const read = (id, path, cwd) => ({ kind: "read", visible: true, path, cwd,
    extent: { full: true }, pointer: { id }, time: id, blockId: "author:initial" })
  const summary = summarizeNavigation([{ events: [read(1, "src/../src/a.ts", "/repo"),
    read(2, "/repo/src/a.ts", "/elsewhere"), read(3, "src/a.ts", "/other") ] }])
  assert.equal(summary.observedFileBreadthLowerBound, 2)
  assert.equal(summary.repeatedFullReads.length, 1)
  assert.deepEqual(summary.repeatedFullReads[0].again, { id: 2 })
})

test("does not compare repetitions across replacement sessions", () => {
  const search = (id) => ({ kind: "search", query: "needle", path: "src", pointer: { id },
    time: id, blockId: "author:initial" })
  const summary = summarizeNavigation([{ events: [search(1)] }, { events: [search(2)] }])
  assert.equal(summary.repeatedExactSearches.length, 0)
  assert.equal(summary.coverage.segments, 2)
})
