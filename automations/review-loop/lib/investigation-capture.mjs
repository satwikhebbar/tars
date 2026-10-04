import { randomUUID } from "node:crypto"
import { execFile, spawn } from "node:child_process"
import { mkdir } from "node:fs/promises"
import { createServer } from "node:net"
import { homedir } from "node:os"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { promisify } from "node:util"

const SUPPORTED_HARNESSES = new Set(["codex", "opencode"])
const execFileAsync = promisify(execFile)

export function assertCaptureSupported(roles) {
  for (const [role, harness] of Object.entries(roles)) {
    if (!SUPPORTED_HARNESSES.has(harness.key)) {
      throw new Error(`--investigate capture supports only Codex and OpenCode; ${role} uses ${harness.displayName}.`)
    }
  }
}

/** Creates per-role Codex trace locations before either harness starts. */
export async function prepareCapture({ roles, codexHome = process.env.CODEX_HOME || join(homedir(), ".codex") }) {
  const root = join(codexHome, "tars", "rollout-traces", `lane-${randomUUID()}`)
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
  return `env CODEX_ROLLOUT_TRACE_ROOT='${capture.traceRoot.replaceAll("'", "'\\\"'\\\"'")}' codex`
}

export function openCodeAttachCommand(evidence) {
  return `opencode attach http://127.0.0.1:${evidence.serverPort} --session ${evidence.nativeSessionId}`
}

export function openCodeServerConfig({ model, agent, buildModel, planModel } = {}) {
  const existing = process.env.OPENCODE_CONFIG_CONTENT ? JSON.parse(process.env.OPENCODE_CONFIG_CONTENT) : {}
  const configured = { ...existing }
  if (model) configured.model = model
  if (agent) configured.default_agent = agent
  if (buildModel || planModel) {
    configured.agent = { ...existing.agent }
    if (buildModel) configured.agent.build = { ...configured.agent.build, model: buildModel }
    if (planModel) configured.agent["tars-plan"] = { ...configured.agent["tars-plan"], model: planModel }
  }
  return JSON.stringify(configured)
}

/** Native identity is returned by OpenCode itself and kept only in active lane state. */
export async function createOpenCodeEvidence({ worktreePath, role, model, agent, buildModel, planModel, runtime = defaultOpenCodeRuntime }) {
  const port = await runtime.availablePort()
  const serverPid = await runtime.startServer({ worktreePath, port, config: openCodeServerConfig({ model, agent, buildModel, planModel }) })
  try {
    const session = await runtime.createSession({ port, worktreePath, title: `TARS ${role}` })
    if (typeof session.id !== "string" || !session.id.startsWith("ses_") || session.directory !== worktreePath) {
      throw new Error(`OpenCode created a session outside the lane worktree ${worktreePath}.`)
    }
    return { status: "available", harness: "opencode", nativeSessionId: session.id, serverPort: port, serverPid, model: model ?? null, initialAgent: agent ?? "build", buildModel: buildModel ?? null, planModel: planModel ?? null }
  } catch (error) {
    await runtime.stopServer(serverPid)
    throw error
  }
}

/** AoE's stored attach command keeps its port and native ID across restarts. */
export async function ensureOpenCodeServer({ evidence, worktreePath, runtime = defaultOpenCodeRuntime }) {
  if (evidence?.harness !== "opencode" || evidence.status !== "available") return evidence
  if (await runtime.hasSession({ port: evidence.serverPort, sessionId: evidence.nativeSessionId, worktreePath })) return evidence
  const serverPid = await runtime.startServer({ worktreePath, port: evidence.serverPort, config: openCodeServerConfig({ model: evidence.model, agent: evidence.initialAgent, buildModel: evidence.buildModel, planModel: evidence.planModel }) })
  if (!await runtime.hasSession({ port: evidence.serverPort, sessionId: evidence.nativeSessionId, worktreePath })) {
    await runtime.stopServer(serverPid)
    throw new Error(`OpenCode native session ${evidence.nativeSessionId} is unavailable after restarting its server.`)
  }
  return { ...evidence, serverPid }
}

export async function stopOpenCodeServer(evidence, runtime = defaultOpenCodeRuntime) {
  if (evidence?.harness === "opencode" && evidence.serverPid) await runtime.stopServer(evidence.serverPid, evidence.serverPort)
}

const defaultOpenCodeRuntime = {
  async availablePort() {
    const server = createServer()
    await new Promise((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve))
    const port = server.address().port
    await new Promise((resolve) => server.close(resolve))
    return port
  },
  async startServer({ worktreePath, port, config }) {
    const child = spawn("opencode", ["serve", "--hostname", "127.0.0.1", "--port", String(port)], {
      cwd: worktreePath,
      env: { ...process.env, OPENCODE_CONFIG_CONTENT: config },
      detached: true,
      stdio: "ignore",
    })
    const failed = new Promise((_, reject) => child.once("error", reject))
    try {
      for (let attempt = 0; attempt < 60; attempt += 1) {
        if (child.exitCode !== null) throw new Error(`OpenCode server exited with status ${child.exitCode}.`)
        try {
          const response = await fetch(`http://127.0.0.1:${port}/session/status`, { signal: AbortSignal.timeout(500) })
          if (response.ok) {
            child.unref()
            return child.pid
          }
        } catch {}
        await Promise.race([delay(200), failed])
      }
      throw new Error(`OpenCode server did not become ready on port ${port}.`)
    } catch (error) {
      child.kill()
      throw error
    }
  },
  async createSession({ port, worktreePath, title }) {
    const response = await fetch(`http://127.0.0.1:${port}/session`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-opencode-directory": worktreePath },
      body: JSON.stringify({ title }),
      signal: AbortSignal.timeout(5000),
    })
    if (!response.ok) throw new Error(`OpenCode session creation returned HTTP ${response.status}.`)
    return response.json()
  },
  async hasSession({ port, sessionId, worktreePath }) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/session/${encodeURIComponent(sessionId)}`, {
        headers: { "x-opencode-directory": worktreePath }, signal: AbortSignal.timeout(500),
      })
      if (!response.ok) return false
      const session = await response.json()
      return session.id === sessionId && session.directory === worktreePath
    } catch { return false }
  },
  async stopServer(pid, port) {
    if (port) {
      let command
      try { command = (await execFileAsync("ps", ["-p", String(pid), "-o", "command="])).stdout }
      catch { return }
      if (!command.includes("opencode serve") || !command.includes(`--port ${port}`)) return
    }
    try { process.kill(pid, "SIGTERM") } catch (error) { if (error.code !== "ESRCH") throw error }
  },
}
