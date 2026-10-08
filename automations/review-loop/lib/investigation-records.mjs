import { indexCodex, indexOpenCode } from "./investigation-index.mjs"

/** The versioned inventory describes individual records, never investigation findings. */
export const NORMALIZATION_REGISTRY = Object.freeze({
  version: 1,
  opencode: { message: "message", text: "message", reasoning: "message", tool: "tool_call",
    compaction: "compaction", "step-finish": "native_accounting" },
  codex: { conversation_items: "message", terminal_operations: "tool_call", tool_calls: "tool_call",
    compactions: "compaction", inference_calls: "native_accounting" },
  shell: { wrapper: "rtk", forms: ["cat <path>", "sed -n <start>,<end>p <path>", "head -n <count> <path>",
    "rg -n <query> <target>", "grep -n <query> <target>", "find <path>", "find <path> -name <pattern>"],
    confidence: "inferred", unsupported: "Preserve the command and output without a normalized action." },
  fallback: "native_other",
})

/** Preserve the complete chosen artifact, with a factual view of every record. */
export function nativeArtifactRecords(native, { role, harness, sessionId, bundle, sourceId }) {
  if (typeof sourceId !== "string" || !sourceId) throw new Error("A source identity is required.")
  if (!["author", "reviewer"].includes(role)) throw new Error("Invalid evidence role.")
  if (!["opencode", "codex"].includes(harness)) throw new Error("Unsupported evidence harness.")
  const legacy = harness === "opencode" ? indexOpenCode(native, { role, sessionId }) : indexCodex(native, { role, bundle })
  const normalizedByKey = new Map(legacy.events.map((event) => [
    event.pointer.partId ? `part:${event.pointer.partId}` : event.pointer.operationId ? `operation:${event.pointer.operationId}` :
      event.pointer.compactionId ? `compaction:${event.pointer.compactionId}` : `tool:${event.pointer.toolCallId}`, event]))
  const events = []
  const add = (type, record, pointer, time, normalized) => {
    const attributes = {}
    if (type === "message" && record.role) attributes.speaker = record.role
    if (normalized) {
      for (const [from, to] of [["tool", "name"], ["outcome", "outcome"], ["durationMs", "durationMs"], ["rawCommand", "rawCommand"],
        ["command", "parsedCommand"], ["extent", "extent"]]) {
        if (normalized[from] !== null && normalized[from] !== undefined) attributes[to] = normalized[from]
      }
      const action = normalized.filenameOnly || normalized.kind === "filename-only" ? "filename_only" : normalized.kind
      const supported = ["read", "search", "filename_only"].includes(action) &&
        (action !== "search" || (typeof normalized.query === "string" && typeof normalized.path === "string"))
      if (supported) {
        attributes.normalizedAction = { kind: action, confidence: normalized.confidence,
          targets: normalized.path ? [{ path: normalized.path, visibleContent: normalized.visible === true }] : [] }
        if (normalized.query !== null && normalized.query !== undefined) attributes.normalizedAction.query = normalized.query
      }
      if (typeof normalized.visibleOutput === "string") {
        attributes.visibleOutputBytes = Buffer.byteLength(normalized.visibleOutput)
        attributes.outputCompleteness = "unknown"
      }
      if (normalized.reason) attributes.normalizationLimit = normalized.reason
    }
    const event = { id: `${sourceId}:${events.length}`, sourceId, role, type, position: events.length,
      pointer, attributes, extra: record }
    if (Number.isFinite(time)) event.time = time
    events.push(event)
  }
  if (harness === "opencode") {
    add("native_other", Object.fromEntries(Object.entries(native).filter(([key]) => key !== "messages")), { harness, sessionId }, undefined)
    for (const message of native.messages) {
      add("message", Object.fromEntries(Object.entries(message).filter(([key]) => key !== "parts")),
        { harness, sessionId, messageId: message.info?.id }, message.info?.time?.created)
      events.at(-1).attributes.speaker = message.info?.role ?? "unknown"
      for (const part of message.parts ?? []) {
        const normalized = normalizedByKey.get(`part:${part.id}`)
        add(NORMALIZATION_REGISTRY.opencode[part.type] ?? "native_other", part,
          { harness, sessionId, messageId: message.info?.id, partId: part.id },
          normalized?.time ?? message.info?.time?.created, normalized)
        if (part.type === "compaction" && typeof part.auto === "boolean") events.at(-1).attributes.auto = part.auto
        if (["text", "reasoning"].includes(part.type)) events.at(-1).attributes.speaker = message.info?.role ?? "unknown"
      }
    }
  } else {
    for (const [section, value] of Object.entries(native)) {
      if (NORMALIZATION_REGISTRY.codex[section] && value && typeof value === "object" && !Array.isArray(value)) {
        for (const [key, record] of Object.entries(value)) {
          const normalized = normalizedByKey.get(`${section === "terminal_operations" ? "operation" :
            section === "tool_calls" ? "tool" : section === "compactions" ? "compaction" : "accounting"}:${key}`)
          add(NORMALIZATION_REGISTRY.codex[section], record, { harness, bundle, traceId: native.trace_id,
            rolloutId: native.rollout_id, section, key }, normalized?.time ?? record.first_seen_at_unix_ms ??
              record.execution?.started_at_unix_ms, normalized)
        }
      } else add("native_other", { [section]: value }, { harness, bundle, section }, undefined)
    }
  }
  if (harness === "codex") {
    const terminalByCall = new Map(events.filter((event) => event.pointer.section === "terminal_operations")
      .map((event) => [event.extra.tool_call_id, event]))
    for (const event of events.filter((event) => event.pointer.section === "tool_calls")) {
      const terminal = terminalByCall.get(event.pointer.key)
      if (terminal) event.attributes.pairedTerminalEventId = terminal.id
    }
  }
  return { source: { id: sourceId, metadata: { role, harness, nativeId: legacy.segmentId,
    normalizationVersion: NORMALIZATION_REGISTRY.version,
    upstreamLimit: harness === "codex" ? "Preserves reduced JSON; reduction may omit raw trace payloads." : "Preserves the raw native export." }, native }, events }
}
