/** Transient, source-neutral observations. This module never writes native data. */
export function indexOpenCode(native, { role, sessionId }) {
  if ((native?.info?.id ?? native?.id) !== sessionId || !Array.isArray(native.messages)) {
    throw new Error(`OpenCode export does not match native session ${sessionId}.`)
  }
  const events = []
  const usage = []
  const conversation = []
  for (const message of native.messages) {
    if (["user", "assistant"].includes(message.info?.role)) {
      const text = (message.parts ?? []).filter((part) => ["text", "reasoning"].includes(part.type) && typeof part.text === "string")
        .map((part) => part.text).join("\n")
      if (text) conversation.push({ time: message.info?.time?.created ?? null, role: message.info.role, text,
        pointer: { harness: "opencode", sessionId, messageId: message.info.id } })
    }
    for (const part of message.parts ?? []) {
      if (!part.id || part.sessionID !== sessionId || part.messageID !== message.info?.id) {
        throw new Error("OpenCode part has invalid native provenance.")
      }
      const pointer = { harness: "opencode", sessionId, messageId: part.messageID, partId: part.id }
      if (part.type === "step-finish") {
        usage.push({ pointer, metrics: { tokens: part.tokens ?? null, cost: part.cost ?? null } })
        continue
      }
      if (part.type === "compaction") {
        events.push({ role, pointer, order: events.length, time: message.info?.time?.created ?? null,
          kind: "compaction", confidence: "direct", auto: part.auto ?? null })
        continue
      }
      if (part.type !== "tool") continue
      const state = part.state ?? {}
      const time = state.time?.start ?? message.info?.time?.created ?? null
      const base = { role, pointer, order: events.length, time, tool: part.tool, cwd: native.info?.directory ?? null,
        outcome: state.status, durationMs: duration(state.time?.start, state.time?.end) }
      if (part.tool === "read") {
        const display = state.metadata?.display
        const path = state.input?.filePath
        const visible = state.status === "completed" && display?.type === "file" &&
          display.path === path && typeof display.text === "string" && display.text.length > 0
        events.push({ ...base, kind: visible ? "read" : "unknown", confidence: visible ? "direct" : "unknown",
          path: path ?? null, visible, extent: visible ? {
            start: display.lineStart, end: display.lineEnd, total: display.totalLines,
            full: display.lineStart === 1 && display.lineEnd === display.totalLines && !display.truncated,
          } : null, reason: visible ? null : "Native read has no confirmed visible file content." })
      } else if (part.tool === "bash") {
        events.push({ ...base, ...classifyShell(state.input?.command, state.output, {
          truncated: state.metadata?.truncated, completed: state.status === "completed", exitCode: state.metadata?.exit,
        }) })
      } else if (part.tool === "grep" || part.tool === "glob") {
        events.push({ ...base, kind: "search", confidence: "direct", query: state.input?.pattern ?? null,
          path: state.input?.path ?? null, visible: part.tool === "grep" && state.status === "completed" &&
            Number(state.metadata?.matches) > 0, filenameOnly: part.tool === "glob",
          truncated: state.metadata?.truncated ?? null })
      } else {
        events.push({ ...base, kind: "other", confidence: "direct" })
      }
    }
  }
  return { harness: "opencode", role, segmentId: sessionId, cwd: native.info?.directory ?? null, events, usage, conversation }
}

export function indexCodex(native, { role, bundle }) {
  if (native?.schema_version !== 1 || !native.trace_id || !native.rollout_id ||
      !native.terminal_operations || !native.compactions) {
    throw new Error("Unsupported Codex reduced trace shape.")
  }
  const events = []
  for (const [key, operation] of Object.entries(native.terminal_operations)) {
    if (key !== operation.operation_id) throw new Error("Codex operation ID does not match its native key.")
    const command = operation.request?.command
    // exec_command records the shell argv; only a known shell invocation can be unwrapped.
    const shell = Array.isArray(command) && command.length === 3 &&
      ["/bin/zsh", "/bin/bash", "zsh", "bash"].includes(command[0]) && command[1] === "-lc"
      ? command[2] : null
    const result = operation.result ?? {}
    const visibleOutput = typeof result.formatted_output === "string" ? result.formatted_output : result.stdout
    events.push({ role, pointer: { harness: "codex", bundle, traceId: native.trace_id,
      rolloutId: native.rollout_id, operationId: key, toolCallId: operation.tool_call_id },
      order: operation.execution?.started_seq ?? null, time: operation.execution?.started_at_unix_ms ?? null,
      tool: operation.kind, cwd: operation.request?.cwd ?? null, outcome: operation.execution?.status,
      durationMs: duration(operation.execution?.started_at_unix_ms, operation.execution?.ended_at_unix_ms),
      ...classifyShell(shell, visibleOutput, { completed: operation.execution?.status === "completed",
      exitCode: result.exit_code, truncated: null, originalCommand: command }) })
  }
  const terminalCallIds = new Set(events.map((event) => event.pointer.toolCallId))
  for (const [key, call] of Object.entries(native.tool_calls ?? {})) {
    if (key !== call.tool_call_id) throw new Error("Codex tool-call ID does not match its native key.")
    if (terminalCallIds.has(key)) continue
    events.push({ role, pointer: { harness: "codex", bundle, traceId: native.trace_id,
      rolloutId: native.rollout_id, toolCallId: key }, order: call.execution?.started_seq ?? null,
      time: call.execution?.started_at_unix_ms ?? null, tool: call.kind?.type ?? "unknown", cwd: null,
      outcome: call.execution?.status, durationMs: duration(call.execution?.started_at_unix_ms,
        call.execution?.ended_at_unix_ms), kind: "other", confidence: "direct" })
  }
  for (const [key, compaction] of Object.entries(native.compactions)) {
    events.push({ role, pointer: { harness: "codex", bundle, traceId: native.trace_id,
      rolloutId: native.rollout_id, compactionId: key }, order: null,
      time: compaction.installed_at_unix_ms ?? null, kind: "compaction", confidence: "direct" })
  }
  events.sort((a, b) => (a.time ?? Infinity) - (b.time ?? Infinity) ||
    (a.order ?? Infinity) - (b.order ?? Infinity) || JSON.stringify(a.pointer).localeCompare(JSON.stringify(b.pointer)))
  const usage = Object.values(native.inference_calls ?? {}).map((call) => ({
    pointer: { harness: "codex", bundle, traceId: native.trace_id,
      rolloutId: native.rollout_id, inferenceCallId: call.inference_call_id },
    metrics: call.usage ?? null,
  }))
  const conversation = Object.values(native.conversation_items ?? {})
    .filter((item) => ["user", "assistant", "tool"].includes(item.role) && item.body)
    .map((item) => ({ time: item.first_seen_at_unix_ms ?? null, role: item.role,
      text: item.body, pointer: { harness: "codex", bundle, traceId: native.trace_id,
        rolloutId: native.rollout_id, itemId: item.item_id } }))
  return { harness: "codex", role, segmentId: native.rollout_id, events, usage, conversation }
}

/** Supported shell grammar is intentionally small. No command is executed or expanded. */
export function classifyShell(command, output, { completed = false, exitCode = null, truncated = null, originalCommand = command } = {}) {
  const rawCommand = typeof originalCommand === "string" ? originalCommand : originalCommand ?? null
  const base = { rawCommand, command: typeof command === "string" ? command : null,
    wrappers: [], kind: "unknown", confidence: "unknown", visible: false,
    path: null, query: null, extent: null, reason: "Unsupported shell command." }
  if (typeof command !== "string" || !command.trim()) return base
  const parsed = tokenizeSimpleShell(command)
  if (!parsed.tokens) return { ...base, reason: parsed.reason }
  const tokens = parsed.tokens
  const wrappers = []
  if (tokens[0] === "rtk") { wrappers.push("rtk"); tokens.shift() }
  if (tokens[0] === "proxy" && wrappers.length) return { ...base, wrappers, reason: "rtk proxy is unsupported." }
  const [tool, ...args] = tokens
  const visible = completed && exitCode === 0 && truncated !== true && typeof output === "string" &&
    output.length > 0 && output.trim() !== "(no output)"
  const result = { ...base, wrappers }
  if (tool === "cat" && args.length === 1 && !args[0].startsWith("-")) {
    return { ...result, kind: "read", confidence: "inferred", path: args[0], visible,
      extent: { start: 1, end: null, total: null, full: false }, reason: null }
  }
  if ((tool === "sed" && args.length === 3 && args[0] === "-n" && /^\d+,\d+p$/.test(args[1])) ||
      (tool === "head" && args.length === 3 && args[0] === "-n" && /^\d+$/.test(args[1]))) {
    const start = tool === "sed" ? Number(args[1].split(",")[0]) : 1
    const end = tool === "sed" ? Number(args[1].split(",")[1].slice(0, -1)) : Number(args[1])
    if (start < 1 || end < start || args[2].startsWith("-")) return result
    return { ...result, kind: "read", confidence: "inferred", path: args[2], visible,
      extent: { start, end, total: null, full: false }, reason: null }
  }
  if ((tool === "rg" || tool === "grep") && args.length === 3 && args[0] === "-n" && args[1] && args[2]) {
    return { ...result, kind: "search", confidence: "inferred", query: args[1], path: args[2],
      visible: visible && /(?:^|\n)(?:[^\n:]+:)?\d+:\S/.test(output), reason: null }
  }
  if (tool === "find" && ((args.length === 1 && !args[0].startsWith("-")) ||
      (args.length === 3 && !args[0].startsWith("-") && args[1] === "-name" && args[2]))) {
    return { ...result, kind: "filename-only", confidence: "inferred", reason: null }
  }
  return { ...result, reason: wrappers.length ? "Underlying wrapper command is unsupported." : base.reason }
}

function duration(start, end) {
  return Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : null
}

function tokenizeSimpleShell(command) {
  const tokens = []
  let token = ""
  let quote = null
  let active = false
  for (const character of command) {
    if (character === "\\" || character === "`" || character === "$" || character === "\n") {
      return { reason: "Shell expansion or escaping is unsupported." }
    }
    if (quote) {
      if (character === quote) quote = null
      else token += character
      continue
    }
    if (character === "'" || character === '"') { quote = character; active = true; continue }
    if (/[|;&<>*?\[\]{}()]/.test(character)) return { reason: "Shell composition, redirection, or glob expansion is unsupported." }
    if (/\s/.test(character)) {
      if (active) { tokens.push(token); token = ""; active = false }
    } else { token += character; active = true }
  }
  if (quote) return { reason: "Unclosed shell quote." }
  if (active) tokens.push(token)
  return { tokens }
}
