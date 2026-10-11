import { createHash } from "node:crypto"
import { buildLaneBlocks } from "./investigation-blocks.mjs"
import { inspectLaneEvidence } from "./investigation-evidence.mjs"
import { classifyEvent, readHandoffs } from "./coordinator.mjs"
import { EvidenceSnapshots } from "./investigation-snapshot.mjs"

/** Presence-based reuse: only --force recollects native evidence. */
export async function prepareLaneEvidence({ state, aoe, worktreePath, force = false,
  cache = new EvidenceSnapshots(), sources, now = () => new Date() }) {
  const lane = state.lane(worktreePath)
  if (!lane) throw new Error(`No active lane for ${worktreePath}.`)
  if (lane.investigationCapture !== "capture") throw new Error(`Lane ${worktreePath} was not started with --investigate capture.`)
  // There is no persisted lane UUID for older lanes. Include the original
  // dispatch marker so a later lane at the same path cannot reuse this cache.
  const deliveries = state.dispatchRecords?.(worktreePath) ?? state.dispatchedEvents?.(worktreePath) ?? new Map()
  const laneId = JSON.stringify([worktreePath, deliveries.get("lane-start") ??
    [lane.authorSessionId, lane.reviewerSessionId]])
  return cache.prepare({ laneId, force, collect: async () => {
    const inventory = await inspectLaneEvidence({ state, aoe, worktreePath, sources, now, includeRecords: true })
    const currentDeliveries = state.dispatchRecords?.(worktreePath) ?? state.dispatchedEvents?.(worktreePath) ?? new Map()
    if (JSON.stringify([...deliveries]) !== JSON.stringify([...currentDeliveries])) {
      throw new Error("Lane dispatches changed during collection; retry when both roles are idle.")
    }
    const handoffs = (await readHandoffs(worktreePath, ["inbox", "in-progress", "done", "archive"]))
      .map(({ handoff }) => ({ metadata: handoff.metadata, event: classifyEvent(handoff) }))
    return snapshotEvidence(inventory, { deliveries, handoffs })
  } })
}

/** Connect the lossless generic timeline to the existing dispatch intervals. */
export function snapshotEvidence(inventory, { deliveries = new Map(), handoffs = [] } = {}) {
  const artifacts = new Map()
  const gaps = []
  const roles = {}
  for (const role of ["author", "reviewer"]) {
    const source = inventory.roles[role]
    if (source.status !== "available") gaps.push(`${role}: ${source.reason ?? source.status}`)
    for (const gap of source.gaps ?? []) gaps.push(`${role}: ${gap}`)
    for (const artifact of source.artifacts ?? []) artifacts.set(artifact.source.id, artifact)
    roles[role] = { segments: [{
      events: [...artifacts.values()].filter((artifact) => artifact.source.metadata.role === role).flatMap((artifact) => artifact.events),
      conversation: (source.segments ?? []).flatMap((segment) => segment.conversation ?? []),
    }] }
  }
  const events = [...artifacts.values()].flatMap((artifact) => artifact.events)
  const blocks = buildLaneBlocks({ deliveries, handoffs, roles })
  for (const block of blocks) {
    if (!block.nativeMessagePointer) continue
    const pointer = block.nativeMessagePointer
    const matching = events.filter((event) => event.role === block.role && event.type === "message" &&
      (pointer.harness === "opencode"
        ? event.pointer.sessionId === pointer.sessionId && event.pointer.messageId === pointer.messageId
        : event.pointer.bundle === pointer.bundle && event.pointer.section === "conversation_items" && event.pointer.key === pointer.itemId))
    block.openingEventId = matching.find((event) => !event.pointer.partId)?.id ?? null
    // A matched opening message belongs to its own block, even at the exact
    // boundary timestamp; unrelated timestamp ties remain unassigned.
    for (const event of matching) {
      event.blockId = block.id
      event.blockBoundaryUncertain = false
    }
  }
  const journalSourceId = "tars:dispatch-journal"
  const journal = Object.fromEntries(deliveries)
  const sources = [...artifacts.values()].map((artifact) => artifact.source)
  sources.push({ id: journalSourceId, metadata: { harness: "tars", kind: "dispatch_journal" }, native: journal })
  for (const block of blocks.filter((block) => block.start !== null)) {
    const key = block.id === "author:initial" ? "lane-start" : block.id.slice(block.role.length + 1)
    const id = `${journalSourceId}:${createHash("sha256").update(key).digest("hex").slice(0, 24)}`
    events.push({ id, sourceId: journalSourceId, role: block.role, type: "dispatch", time: block.start,
      blockId: block.id, pointer: { harness: "tars", key }, attributes: {
        boundaryConfidence: block.boundaryConfidence,
        ...(block.openingEventId ? { nativeMessageEventId: block.openingEventId } : {}),
      }, extra: journal[key] })
    block.dispatchEventId = id
  }
  return { sources, events, blocks, asOf: inventory.asOf, gaps,
    coverage: Object.fromEntries(Object.entries(inventory.roles).map(([role, source]) => [role, {
      harness: source.harness, status: source.status, reason: source.reason,
      bytes: source.bytes, reducedBytes: source.reducedBytes, messageCount: source.messageCount,
      bundleCount: source.bundleCount, nativeSessionId: source.nativeSessionId, gaps: source.gaps ?? [],
    }])) }
}
