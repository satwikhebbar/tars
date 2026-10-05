import { spawn } from "node:child_process"
import { mkdtemp, open, readFile, readdir, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { indexCodex, indexOpenCode } from "./investigation-index.mjs"
import { buildLaneBlocks } from "./investigation-blocks.mjs"
import { classifyEvent, readHandoffs } from "./coordinator.mjs"

const QUIET_STATES = new Set(["idle", "waiting"])
const MAX_INVENTORY_PARSE_BYTES = 16 * 1024 * 1024

/** A read-only preflight and native-source inventory for an active capture lane. */
export async function inspectLaneEvidence({ state, aoe, worktreePath, sources = nativeSources, now = () => new Date(), includeIndex = false }) {
  const lane = state.lane(worktreePath)
  if (!lane) throw new Error(`No active lane for ${worktreePath}.`)
  if (lane.investigationCapture !== "capture") throw new Error(`Lane ${worktreePath} was not started with --investigate capture.`)
  await assertQuiet(aoe, lane)
  const asOf = now().toISOString()
  const roles = {}
  for (const role of ["author", "reviewer"]) {
    const evidence = lane[`${role}Evidence`]
    const harness = lane[`${role}Harness`]
    let source
    try {
      source = await sources.inspect({ role, harness, evidence, worktreePath, includeIndex })
    } catch (error) {
      source = { status: "unavailable", reason: error instanceof Error ? error.message : String(error) }
    }
    if (includeIndex && evidence?.previous?.length) {
      const history = []
      const gaps = [...(source.gaps ?? [])]
      if (source.status === "unavailable") gaps.push(`current segment: ${source.reason}`)
      for (const [index, prior] of evidence.previous.entries()) {
        try {
          const result = await sources.inspect({ role, harness, evidence: prior, worktreePath, includeIndex })
          history.push(...result.segments ?? [])
          if (result.status !== "available") gaps.push(`prior segment ${index + 1}: ${result.gaps?.join("; ") ?? result.status}`)
        } catch (error) {
          gaps.push(`prior segment ${index + 1}: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      const segments = [...history, ...(source.segments ?? [])]
      source = { ...source, segments, gaps, status: gaps.length ? (segments.length ? "partial" : "unavailable") : source.status }
    }
    roles[role] = { harness, ...source }
  }
  let blocks
  if (includeIndex) {
    const handoffs = (await readHandoffs(worktreePath, ["inbox", "done"]))
      .map(({ handoff }) => ({ metadata: handoff.metadata, event: classifyEvent(handoff) }))
    blocks = buildLaneBlocks({ handoffs, deliveries: state.dispatchedEvents?.(worktreePath) ?? new Map(), roles })
  }
  await assertQuiet(aoe, lane)
  const current = state.lane(worktreePath)
  if (!current || current.investigationCapture !== "capture" ||
      current.authorSessionId !== lane.authorSessionId || current.reviewerSessionId !== lane.reviewerSessionId ||
      JSON.stringify(current.authorEvidence) !== JSON.stringify(lane.authorEvidence) ||
      JSON.stringify(current.reviewerEvidence) !== JSON.stringify(lane.reviewerEvidence)) {
    throw new Error("Lane sessions or evidence changed during collection; retry when both roles are idle.")
  }
  return { worktreePath, asOf, roles, ...(includeIndex ? { blocks } : {}) }
}

async function assertQuiet(aoe, lane) {
  const runtime = await aoe.runtimeSessions({ includeDead: true })
  for (const role of ["author", "reviewer"]) {
    const id = lane[`${role}SessionId`]
    const matches = runtime.filter((entry) => entry.session === id)
    if (matches.length !== 1 || !QUIET_STATES.has(matches[0].state)) {
      throw new Error(`${role} AoE session ${id} must be idle or waiting (found ${matches[0]?.state ?? "missing"}).`)
    }
  }
}

export const nativeSources = createNativeSources()

export function createNativeSources(run = runToFile) {
  return {
    async inspect({ role, harness, evidence, includeIndex = false }) {
    if (evidence?.status !== "available" || evidence.harness !== harness) {
      throw new Error(evidence?.reason ?? "Native evidence reference is unavailable.")
    }
    if (harness === "opencode") {
      if (!/^ses_[A-Za-z0-9]+$/.test(evidence.nativeSessionId ?? "")) throw new Error("OpenCode native session ID is missing or invalid.")
      return withTempDirectory(async (directory) => {
        const output = join(directory, "opencode-export.json")
        await run("opencode", ["export", evidence.nativeSessionId], output)
        const { size } = await stat(output)
        if (!size) throw new Error("OpenCode export was empty.")
        if (size > MAX_INVENTORY_PARSE_BYTES) {
          return { status: "partial", nativeSessionId: evidence.nativeSessionId, bytes: size,
            gaps: ["Export exceeds the 16 MiB diagnostic parse limit; its structure was not checked."] }
        }
        const native = JSON.parse(await readFile(output, "utf8"))
        if ((native.info?.id ?? native.id) !== evidence.nativeSessionId || !Array.isArray(native.messages)) {
          throw new Error(`OpenCode export does not match native session ${evidence.nativeSessionId}.`)
        }
        return { status: "available", nativeSessionId: evidence.nativeSessionId, bytes: size, messageCount: native.messages.length,
          ...(includeIndex ? { segments: [indexOpenCode(native, { role, sessionId: evidence.nativeSessionId })] } : {}) }
      })
    }
    if (harness === "codex") {
      if (!evidence.traceRoot) throw new Error("Codex trace root is missing.")
      const entries = await readdir(evidence.traceRoot, { withFileTypes: true })
      const bundles = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort()
      if (!bundles.length) throw new Error("Codex trace root has no bundles.")
      return withTempDirectory(async (directory) => {
        let bytes = 0
        const gaps = []
        const segments = []
        for (const [index, bundle] of bundles.entries()) {
          const bundlePath = join(evidence.traceRoot, bundle)
          try {
            await stat(join(bundlePath, "manifest.json"))
            const output = join(directory, `codex-${index}.json`)
            await run("codex", ["debug", "trace-reduce", bundlePath, "--output", output], output, { stdoutToFile: false })
            const size = (await stat(output)).size
            if (includeIndex) segments.push(indexCodex(JSON.parse(await readFile(output, "utf8")), { role, bundle }))
            bytes += size
          } catch (error) {
            gaps.push(`${bundle}: ${error instanceof Error ? error.message : String(error)}`)
          }
        }
        if (!bytes) throw new Error(`No Codex bundle could be reduced${gaps.length ? ` (${gaps.join("; ")})` : "."}`)
        return { status: gaps.length ? "partial" : "available", bundleCount: bundles.length, reducedBytes: bytes, gaps,
          ...(includeIndex ? { segments } : {}) }
      })
    }
    throw new Error(`Unsupported native source: ${harness}.`)
    },
  }
}

async function withTempDirectory(callback) {
  const directory = await mkdtemp(join(tmpdir(), "tars-evidence-"))
  try { return await callback(directory) }
  finally { await rm(directory, { recursive: true, force: true }) }
}

export async function runToFile(command, args, output, { stdoutToFile = true } = {}) {
  // OpenCode's export can stop at a pipe buffer boundary. A regular file as
  // stdout also avoids buffering the native export in TARS memory.
  const file = stdoutToFile ? await open(output, "w", 0o600) : null
  const child = spawn(command, args, { stdio: ["ignore", file?.fd ?? "ignore", "pipe"] })
  let errorText = ""
  child.stderr.on("data", (chunk) => { errorText = (errorText + chunk.toString()).slice(-1024) })
  const exited = new Promise((resolve, reject) => {
    child.once("error", reject)
    child.once("close", (code) => code === 0 ? resolve() : reject(new Error(`${command} exited ${code}: ${errorText.trim()}`)))
  })
  try { await exited }
  catch (error) {
    child.kill()
    throw error
  } finally { await file?.close() }
}
