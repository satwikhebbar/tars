import { randomUUID } from "node:crypto"
import { mkdir } from "node:fs/promises"
import { dirname, join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { execFile } from "node:child_process"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)
const SUPPORTED_HARNESSES = new Set(["codex", "opencode"])

export function assertCaptureSupported(roles) {
  for (const [role, harness] of Object.entries(roles)) {
    if (!SUPPORTED_HARNESSES.has(harness.key)) {
      throw new Error(`--investigate capture supports only Codex and OpenCode; ${role} uses ${harness.displayName}.`)
    }
  }
}

/** Creates per-role native evidence locations before either harness starts. */
export async function prepareCapture({ statePath, roles }) {
  const root = join(dirname(statePath), "native-evidence", `lane-${randomUUID()}`)
  const roleCapture = {}
  for (const [role, harness] of Object.entries(roles)) {
    if (harness.key !== "codex") {
      roleCapture[role] = { status: "pending", harness: harness.key }
      continue
    }
    const traceRoot = join(root, role)
    await mkdir(traceRoot, { recursive: true })
    roleCapture[role] = { status: "available", harness: "codex", traceRoot }
  }
  return { mode: "capture", root, roles: roleCapture }
}

/** The command is generated from TARS-owned paths, never from operator input. */
export function captureLaunchCommand(harness, capture) {
  if (harness.key !== "codex" || !capture) return undefined
  return `env CODEX_ROLLOUT_TRACE_ROOT=${shellQuote(capture.traceRoot)} codex`
}

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\\"'\\\"'")}'`
}

/**
 * Maps a fresh interactive OpenCode role to its native session without a
 * directory or timing heuristic. The nonce stays only in the native prompt.
 */
export async function attributeOpenCodeSession({ aoe, aoeSessionId, role, command = "opencode", attempts = 6, sleep = delay }) {
  const nonce = `tars-capture-${role}-${randomUUID()}`
  const prompt = `TARS capture initialization ${nonce}. Reply with exactly: capture ready. Do not use tools or inspect the repository.`
  await aoe.send(aoeSessionId, prompt)

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const ids = await listOpenCodeSessionIds(command)
    const matches = []
    for (const id of ids) {
      const exported = await exportOpenCodeSession(command, id)
      if (containsExactString(exported, prompt)) matches.push(id)
    }
    if (matches.length === 1) return { status: "available", harness: "opencode", nativeSessionId: matches[0] }
    if (attempt < attempts - 1) await sleep(500)
  }
  return { status: "unavailable", harness: "opencode", reason: "No unique native OpenCode session matched the launch handshake." }
}

async function listOpenCodeSessionIds(command) {
  const { stdout } = await execFileAsync(command, ["session", "list", "--format", "json"])
  const sessions = JSON.parse(stdout)
  if (!Array.isArray(sessions)) throw new Error("OpenCode session list did not return an array.")
  return sessions.map((session) => session.id ?? session.sessionID).filter((id) => typeof id === "string")
}

async function exportOpenCodeSession(command, sessionId) {
  const { stdout } = await execFileAsync(command, ["export", sessionId])
  return JSON.parse(stdout)
}

function containsExactString(value, expected) {
  if (value === expected) return true
  if (Array.isArray(value)) return value.some((entry) => containsExactString(entry, expected))
  if (value && typeof value === "object") return Object.values(value).some((entry) => containsExactString(entry, expected))
  return false
}
