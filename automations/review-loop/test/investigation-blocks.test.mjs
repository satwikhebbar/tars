import assert from "node:assert/strict"
import test from "node:test"
import { buildLaneBlocks } from "../lib/investigation-blocks.mjs"
import { indexCodex, indexOpenCode } from "../lib/investigation-index.mjs"

test("dispatch times place both roles into handoff blocks and retain commit context", () => {
  const roles = {
    author: { segments: [{ events: [{ time: 1000 }, { time: 3000 }, { time: null }] }] },
    reviewer: { segments: [{ events: [{ time: 2500 }, { time: 3500 }] }] },
  }
  const handoffs = [
    { metadata: { id: "implementation-1", type: "implementation-response", head_commit: "abc" },
      event: { key: "implementation:implementation-1:abc", destination: "reviewer", round: 1, iteration: 1 } },
    { metadata: { id: "review-1", type: "code-review" },
      event: { key: "review:review-1:changes_requested", destination: "author", round: 1, iteration: 1 } },
  ]
  const deliveries = new Map([
    ["implementation:implementation-1:abc", new Date(2000).toISOString()],
    ["review:review-1:changes_requested", new Date(2800).toISOString()],
  ])
  const blocks = buildLaneBlocks({ handoffs, deliveries, roles })
  assert.equal(blocks.find((block) => block.handoffId === "implementation-1").headCommit, "abc")
  assert.equal(roles.author.segments[0].events[0].blockId, "author:initial")
  assert.equal(roles.author.segments[0].events[1].blockId, "author:review:review-1:changes_requested")
  assert.equal(roles.author.segments[0].events[2].blockId, null)
  assert.equal(roles.reviewer.segments[0].events[0].blockId, "reviewer:implementation:implementation-1:abc")
  assert.equal(roles.reviewer.segments[0].events[1].blockId, null)
})

test("undispatched handoffs never create a block boundary", () => {
  const roles = { author: { segments: [] }, reviewer: { segments: [{ events: [{ time: 2500 }] }] } }
  const blocks = buildLaneBlocks({ handoffs: [{ metadata: { id: "pending", type: "implementation-response" },
    event: { key: "pending", destination: "reviewer" } }], deliveries: new Map(), roles })
  assert.equal(blocks.length, 2)
  assert.equal(roles.reviewer.segments[0].events[0].blockId, "reviewer:initial")
})

test("multiple review rounds keep each role in its own dispatched window", () => {
  const roles = {
    author: { segments: [{ events: [100, 301, 601, null].map((time) => ({ time })) }] },
    reviewer: { segments: [{ events: [201, 401, 501].map((time) => ({ time })) }] },
  }
  const handoffs = [
    { metadata: { id: "implementation-1", type: "implementation-response", head_commit: "aaa" },
      event: { key: "impl-1", destination: "reviewer", iteration: 1, round: 1 } },
    { metadata: { id: "review-1", type: "code-review" },
      event: { key: "review-1", destination: "author", iteration: 1, round: 1 } },
    { metadata: { id: "implementation-2", type: "implementation-response", head_commit: "bbb" },
      event: { key: "impl-2", destination: "reviewer", iteration: 2, round: 1 } },
    { metadata: { id: "review-2", type: "code-review" },
      event: { key: "review-2", destination: "author", iteration: 2, round: 1 } },
  ]
  const deliveries = new Map([["impl-1", 200], ["review-1", 300], ["impl-2", 400], ["review-2", 600]]
    .map(([key, time]) => [key, new Date(time).toISOString()]))
  const blocks = buildLaneBlocks({ handoffs, deliveries, roles })
  assert.deepEqual(roles.author.segments[0].events.map((event) => event.blockId),
    ["author:initial", "author:review-1", "author:review-2", null])
  assert.deepEqual(roles.reviewer.segments[0].events.map((event) => event.blockId),
    ["reviewer:impl-1", "reviewer:impl-2", "reviewer:impl-2"])
  assert.deepEqual(blocks.filter((block) => block.role === "reviewer" && block.headCommit)
    .map((block) => [block.handoffId, block.headCommit, block.iteration]),
  [["implementation-1", "aaa", 1], ["implementation-2", "bbb", 2]])
})

test("native dispatch messages anchor both roles before delayed journal timestamps", () => {
  const authorMessage = { role: "user", time: 100, text: "Start\n[TARS dispatch ID: aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa]", pointer: { messageId: "a" } }
  const reviewerMessage = { role: "user", time: 300, text: "Review\n[TARS dispatch ID: bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb]", pointer: { itemId: "b" } }
  const roles = {
    author: { segments: [{ conversation: [authorMessage], events: [{ time: 150 }, { time: 350 }] }] },
    reviewer: { segments: [{ conversation: [reviewerMessage], events: [{ time: 325 }] }] },
  }
  const handoffs = [{ metadata: { id: "impl", type: "implementation-response", head_commit: "abc" },
    event: { key: "impl", destination: "reviewer" } }]
  const deliveries = new Map([
    ["lane-start", { createdAt: new Date(200).toISOString(), dispatchId: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa", destinationRole: "author" }],
    ["impl", { createdAt: new Date(400).toISOString(), dispatchId: "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb", destinationRole: "reviewer" }],
  ])
  const blocks = buildLaneBlocks({ handoffs, deliveries, roles })
  assert.deepEqual(blocks.filter((block) => block.boundaryConfidence === "native").map((block) => block.start), [100, 300])
  assert.deepEqual(blocks.find((block) => block.id === "reviewer:impl").nativeMessagePointer, { itemId: "b" })
  assert.equal(roles.author.segments[0].events[0].blockId, "author:initial")
  assert.equal(roles.author.segments[0].events[1].blockId, null)
  assert.equal(roles.reviewer.segments[0].events[0].blockId, "reviewer:impl")
})

test("ambiguous native matches fall back to journal time and tied events remain unassigned", () => {
  const text = "[TARS dispatch ID: cccccccc-cccc-4ccc-cccc-cccccccccccc]"
  const roles = { author: { segments: [{ conversation: [
    { role: "user", time: 100, text }, { role: "user", time: 101, text },
  ], events: [{ time: 199 }, { time: 200 }, { time: null }] }] }, reviewer: { segments: [] } }
  const blocks = buildLaneBlocks({ handoffs: [], deliveries: new Map([["lane-start", {
    createdAt: new Date(200).toISOString(), dispatchId: "cccccccc-cccc-4ccc-cccc-cccccccccccc", destinationRole: "author",
  }]]), roles })
  assert.equal(blocks.find((block) => block.id === "author:initial").boundaryConfidence, "approximate")
  assert.deepEqual(roles.author.segments[0].events.map((event) => event.blockId), [null, null, null])
  assert.equal(roles.author.segments[0].events[1].blockBoundaryUncertain, true)
})

test("command journal entries do not open work blocks", () => {
  const blocks = buildLaneBlocks({ handoffs: [], deliveries: new Map([["compact", {
    createdAt: new Date(100).toISOString(), boundaryKind: "command", destinationRole: "author",
  }]]), roles: { author: { segments: [] }, reviewer: { segments: [] } } })
  assert.deepEqual(blocks.map((block) => block.id), ["reviewer:initial", "author:initial"])
})

test("matches marker text from both harness adapters", () => {
  const author = indexOpenCode({ info: { id: "ses_1" }, messages: [{
    info: { id: "msg_1", role: "user", time: { created: 100 } },
    parts: [{ id: "part_1", sessionID: "ses_1", messageID: "msg_1", type: "text",
      text: "Start [TARS dispatch ID: aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa]" }],
  }] }, { role: "author", sessionId: "ses_1" })
  const reviewer = indexCodex({ schema_version: 1, trace_id: "trace", rollout_id: "rollout",
    terminal_operations: {}, compactions: {}, conversation_items: { user_1: {
      item_id: "user_1", role: "user", first_seen_at_unix_ms: 300,
      body: { parts: [{ type: "input_text", text: "Review [TARS dispatch ID: bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb]" }] },
    } },
  }, { role: "reviewer", bundle: "bundle" })
  const blocks = buildLaneBlocks({ handoffs: [], roles: {
    author: { segments: [author] }, reviewer: { segments: [reviewer] },
  }, deliveries: new Map([
    ["lane-start", { createdAt: new Date(200).toISOString(), dispatchId: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa", destinationRole: "author" }],
    ["plan-build:key", { createdAt: new Date(400).toISOString(), dispatchId: "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb", destinationRole: "reviewer" }],
  ]) })
  assert.equal(blocks.find((block) => block.id === "author:initial").start, 100)
  assert.equal(blocks.find((block) => block.id === "reviewer:plan-build:key").start, 300)
})

test("missing native dispatch leaves a journal-time boundary and marks adjacent assignments uncertain", () => {
  const events = [{ time: 199 }, { time: 200 }, { time: 201 }]
  const roles = { author: { segments: [{ conversation: [{
    role: "assistant", time: 100, text: "[TARS dispatch ID: aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa]",
  }], events }] }, reviewer: { segments: [] } }
  const blocks = buildLaneBlocks({ handoffs: [], roles, deliveries: new Map([["lane-start", {
    createdAt: new Date(200).toISOString(), dispatchId: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa", destinationRole: "author",
  }]]) })
  assert.equal(blocks.find((block) => block.id === "author:initial").start, 200)
  assert.equal(blocks.find((block) => block.id === "author:initial").boundaryConfidence, "approximate")
  assert.deepEqual(events.map(({ blockId, blockBoundaryUncertain }) => [blockId, blockBoundaryUncertain]),
    [[null, false], [null, true], ["author:initial", true]])
})

test("a native message without a usable timestamp falls back to the journal", () => {
  const roles = { author: { segments: [{ conversation: [{
    role: "user", time: null, text: "[TARS dispatch ID: aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa]",
  }], events: [{ time: 201 }] }] }, reviewer: { segments: [] } }
  const blocks = buildLaneBlocks({ handoffs: [], roles, deliveries: new Map([["lane-start", {
    createdAt: new Date(200).toISOString(), dispatchId: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa", destinationRole: "author",
  }]]) })
  assert.equal(blocks.find((block) => block.id === "author:initial").boundaryConfidence, "approximate")
  assert.equal(roles.author.segments[0].events[0].blockBoundaryUncertain, true)
})

test("a quoted earlier dispatch ID does not hide the current prompt marker", () => {
  const roles = { author: { segments: [{ conversation: [{ role: "user", time: 100,
    text: "Earlier: [TARS dispatch ID: aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa]\n" +
      "[TARS dispatch ID: bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb]" }], events: [] }] }, reviewer: { segments: [] } }
  const blocks = buildLaneBlocks({ handoffs: [], roles, deliveries: new Map([["lane-start", {
    createdAt: new Date(200).toISOString(), dispatchId: "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb", destinationRole: "author",
  }]]) })
  assert.equal(blocks.find((block) => block.id === "author:initial").start, 100)
  assert.equal(blocks.find((block) => block.id === "author:initial").boundaryConfidence, "native")
})

test("an approximate next dispatch makes the preceding block's assignment uncertain", () => {
  const roles = {
    author: { segments: [{ conversation: [{ role: "user", time: 100,
      text: "[TARS dispatch ID: aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa]" }],
    events: [{ time: 150 }] }] }, reviewer: { segments: [] },
  }
  const blocks = buildLaneBlocks({ handoffs: [{ metadata: { id: "impl" },
    event: { key: "impl", destination: "reviewer" } }], roles, deliveries: new Map([
    ["lane-start", { createdAt: new Date(110).toISOString(), dispatchId: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa", destinationRole: "author" }],
    ["impl", { createdAt: new Date(200).toISOString(), destinationRole: "reviewer" }],
  ]) })
  assert.equal(blocks.find((block) => block.id === "author:initial").endBoundaryConfidence, "approximate")
  assert.deepEqual([roles.author.segments[0].events[0].blockId,
    roles.author.segments[0].events[0].blockBoundaryUncertain], ["author:initial", true])
})

test("delivery order does not determine block order and a later role closes the earlier role's block", () => {
  const roles = {
    author: { segments: [{ events: [{ time: 150 }, { time: 250 }, { time: 350 }] }] },
    reviewer: { segments: [{ events: [{ time: 250 }, { time: 350 }] }] },
  }
  const handoffs = [{ metadata: { id: "impl" }, event: { key: "impl", destination: "reviewer" } }]
  const deliveries = new Map([
    ["impl", { createdAt: new Date(300).toISOString() }],
    ["lane-start", { createdAt: new Date(100).toISOString() }],
  ])
  const blocks = buildLaneBlocks({ handoffs, deliveries, roles })
  assert.deepEqual(blocks.filter((block) => block.start !== null).map((block) => block.id),
    ["author:initial", "reviewer:impl"])
  assert.equal(blocks.find((block) => block.id === "author:initial").end, 300)
  assert.deepEqual(roles.author.segments[0].events.map((event) => event.blockId),
    ["author:initial", "author:initial", null])
  assert.deepEqual(roles.reviewer.segments[0].events.map((event) => event.blockId),
    [null, "reviewer:impl"])
})

test("simultaneous dispatches leave tied events unassigned instead of choosing a role block", () => {
  const roles = {
    author: { segments: [{ events: [{ time: 200 }, { time: 201 }] }] },
    reviewer: { segments: [{ events: [{ time: 200 }, { time: 201 }] }] },
  }
  const handoffs = [{ metadata: { id: "impl" }, event: { key: "impl", destination: "reviewer" } }]
  buildLaneBlocks({ handoffs, roles, deliveries: new Map([
    ["lane-start", { createdAt: new Date(200).toISOString(), destinationRole: "author" }],
    ["impl", { createdAt: new Date(200).toISOString(), destinationRole: "reviewer" }],
  ]) })
  assert.deepEqual(roles.author.segments[0].events.map((event) => event.blockId), [null, null])
  assert.deepEqual(roles.reviewer.segments[0].events.map((event) => event.blockId), [null, "reviewer:impl"])
  assert.equal(roles.author.segments[0].events[0].blockBoundaryUncertain, true)
  assert.equal(roles.reviewer.segments[0].events[0].blockBoundaryUncertain, true)
})

test("only valid prompt deliveries open blocks and repeated indexing clears stale event annotations", () => {
  const event = { time: 150, blockId: "stale", blockBoundaryUncertain: true }
  const roles = { author: { segments: [{ events: [event] }] }, reviewer: { segments: [] } }
  const deliveries = new Map([
    ["ignored-role", { createdAt: new Date(100).toISOString(), destinationRole: "observer" }],
    ["invalid-time", { createdAt: "invalid", destinationRole: "author" }],
    ["compact", { createdAt: new Date(120).toISOString(), boundaryKind: "command", destinationRole: "author" }],
    ["terminal", { createdAt: new Date(130).toISOString(), boundaryKind: "terminal", destinationRole: "author" }],
  ])
  assert.deepEqual(buildLaneBlocks({ handoffs: [], deliveries, roles }).map((block) => block.id),
    ["reviewer:initial", "author:initial"])
  assert.deepEqual([event.blockId, event.blockBoundaryUncertain], ["author:initial", true])
  event.time = null
  buildLaneBlocks({ handoffs: [], deliveries, roles })
  assert.deepEqual([event.blockId, event.blockBoundaryUncertain], [null, false])
})
