/** Assign native events only to role windows anchored by TARS dispatch records. */
export function buildLaneBlocks({ handoffs, deliveries, roles }) {
  const starts = []
  for (const handoff of handoffs) {
    const event = handoff.event
    if (!event || !["author", "reviewer"].includes(event.destination)) continue
    const deliveredAt = deliveries.get(event.key)
    const start = Date.parse(deliveredAt)
    if (!Number.isFinite(start)) continue
    starts.push({ id: `${event.destination}:${event.key}`, role: event.destination, start,
      handoffId: handoff.metadata.id, handoffType: handoff.metadata.type,
      iteration: event.iteration ?? handoff.metadata.iteration ?? null,
      round: event.round ?? null, headCommit: handoff.metadata.head_commit ?? null })
  }
  const blocks = []
  for (const role of ["author", "reviewer"]) {
    const roleStarts = starts.filter((item) => item.role === role).sort((a, b) => a.start - b.start || a.id.localeCompare(b.id))
    const roleBlocks = [{ id: `${role}:initial`, role, start: null, end: roleStarts[0]?.start ?? null,
      handoffId: null, handoffType: null, iteration: null, round: null, headCommit: null },
    ...roleStarts.map((item, index) => ({ ...item, end: roleStarts[index + 1]?.start ?? null }))]
    blocks.push(...roleBlocks)
    for (const segment of roles[role]?.segments ?? []) {
      for (const event of segment.events) {
        if (!Number.isFinite(event.time)) { event.blockId = null; continue }
        const matches = roleBlocks.filter((block) =>
          (block.start === null || event.time >= block.start) && (block.end === null || event.time < block.end))
        event.blockId = matches.length === 1 ? matches[0].id : null
      }
    }
  }
  return blocks
}
