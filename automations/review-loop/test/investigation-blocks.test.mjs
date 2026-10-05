import assert from "node:assert/strict"
import test from "node:test"
import { buildLaneBlocks } from "../lib/investigation-blocks.mjs"

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
  assert.equal(roles.reviewer.segments[0].events[1].blockId, "reviewer:implementation:implementation-1:abc")
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
