import { dispatchIdIn } from "./investigation-dispatch.mjs"

/** Assign events to lane-wide dispatch intervals, conservatively at uncertain boundaries. */
export function buildLaneBlocks({ handoffs, deliveries, roles }) {
  const handoffByKey = new Map(handoffs.filter((handoff) => handoff.event).map((handoff) => [handoff.event.key, handoff]))
  const starts = []
  for (const [key, raw] of deliveries) {
    const record = typeof raw === "string" ? { createdAt: raw } : raw
    if (record.boundaryKind && record.boundaryKind !== "prompt") continue
    const handoff = handoffByKey.get(key)
    // Older journals have no destination_role. An approved terminal verdict
    // still sends a follow-up prompt to the author; a blocked verdict does not.
    const legacyDestination = handoff?.event?.destination === "terminal" && handoff.event.outcome === "approved"
      ? "author" : handoff?.event?.destination
    const role = record.destinationRole ?? legacyDestination ?? (key === "lane-start" ? "author" : null)
    if (!["author", "reviewer"].includes(role)) continue
    const journalTime = Date.parse(record.createdAt)
    if (!Number.isFinite(journalTime)) continue
    const matches = record.dispatchId ? nativeMessages(roles[role]).filter((message) =>
      message.role === "user" && dispatchIdIn(nativeMessageText(message.text)) === record.dispatchId.toLowerCase()) : []
    const native = matches.length === 1 && Number.isFinite(matches[0].time) ? matches[0] : null
    starts.push({ id: key === "lane-start" ? "author:initial" : `${role}:${key}`, role,
      start: native?.time ?? journalTime, dispatchId: record.dispatchId ?? null,
      nativeMessagePointer: native?.pointer ?? null,
      boundaryConfidence: native ? "native" : "approximate", journalTime,
      handoffId: handoff?.metadata.id ?? null, handoffType: handoff?.metadata.type ?? null,
      iteration: handoff?.event.iteration ?? handoff?.metadata.iteration ?? null,
      round: handoff?.event.round ?? null, headCommit: handoff?.metadata.head_commit ?? null })
  }
  starts.sort((a, b) => a.start - b.start || a.id.localeCompare(b.id))
  const blocks = starts.map((item, index) => ({ ...item, end: starts[index + 1]?.start ?? null,
    endBoundaryConfidence: starts[index + 1]?.boundaryConfidence ?? null }))
  if (!starts.some((item) => item.id === "author:initial")) blocks.unshift(initial("author", starts[0]?.start ?? null))
  blocks.unshift(initial("reviewer", starts[0]?.start ?? null))
  for (const role of ["author", "reviewer"]) {
    for (const segment of roles[role]?.segments ?? []) {
      for (const event of segment.events) {
        event.blockId = null
        event.blockBoundaryUncertain = false
        if (!Number.isFinite(event.time)) continue
        if (starts.some((item) => item.start === event.time)) { event.blockBoundaryUncertain = true; continue }
        const candidates = blocks.filter((block) => block.role === role &&
          (block.start === null || event.time > block.start) &&
          (block.end === null || event.time < block.end))
        if (candidates.length === 1) {
          event.blockId = candidates[0].id
          event.blockBoundaryUncertain = candidates[0].boundaryConfidence !== "native" ||
            candidates[0].endBoundaryConfidence === "approximate"
        }
      }
    }
  }
  return blocks
}

function nativeMessages(source) {
  return (source?.segments ?? []).flatMap((segment) => segment.conversation ?? [])
}

function nativeMessageText(body) {
  if (typeof body === "string") return body
  if (Array.isArray(body)) return body.map(nativeMessageText).filter(Boolean).join("\n")
  if (!body || typeof body !== "object") return ""
  return [body.text, body.content, body.message, body.parts].map(nativeMessageText).filter(Boolean).join("\n")
}

function initial(role, end) {
  return { id: `${role}:initial`, role, start: null, end, boundaryConfidence: "unanchored",
    endBoundaryConfidence: null, dispatchId: null, nativeMessagePointer: null, handoffId: null, handoffType: null,
    iteration: null, round: null, headCommit: null }
}
