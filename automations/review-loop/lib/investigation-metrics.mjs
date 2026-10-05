import { isAbsolute, normalize, resolve } from "node:path"

/** Deterministic lower-bound counts; interpretation belongs to the analyst. */
export function summarizeNavigation(segments) {
  const seenFiles = new Set()
  const repeatedFullReads = []
  const repeatedExactSearches = []
  const coverage = { unclassifiedEvents: 0, unassignedEvents: 0, segments: segments.length }
  for (const segment of segments) {
    const fullReads = new Map()
    const searches = new Map()
    // Each native adapter supplies its own ordered trail. OpenCode compaction
    // parts can carry their parent message's earlier timestamp.
    for (const event of segment.events) {
      if (event.kind === "compaction") { fullReads.clear(); searches.clear(); continue }
      if (event.kind === "unknown") coverage.unclassifiedEvents += 1
      if (!event.blockId) coverage.unassignedEvents += 1
      const path = event.path && (isAbsolute(event.path) ? normalize(event.path) :
        event.cwd && isAbsolute(event.cwd) ? resolve(event.cwd, event.path) : null)
      if (event.kind === "read" && event.visible && path) seenFiles.add(path)
      if (event.kind === "read" && event.visible && event.extent?.full && path) {
        if (fullReads.has(path)) repeatedFullReads.push({ path, first: fullReads.get(path), again: event.pointer })
        fullReads.set(path, event.pointer)
      }
      if (event.kind === "search" && event.query && event.path) {
        const key = `${event.query}\u0000${event.path}`
        if (searches.has(key)) repeatedExactSearches.push({ query: event.query, path: event.path,
          first: searches.get(key), again: event.pointer })
        searches.set(key, event.pointer)
      }
    }
  }
  return { observedFileBreadthLowerBound: seenFiles.size, repeatedFullReads, repeatedExactSearches, coverage }
}
