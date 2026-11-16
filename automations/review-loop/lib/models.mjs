import { spawn } from "node:child_process"
import { createInterface } from "node:readline"

/** Validate resolved CLI/config values before classification or lane creation. */
export async function assertLaneModels(entries, { cwd, readCatalog = readCodexCatalog } = {}) {
  const selected = entries.filter(({ model }) => model !== undefined)
  for (const { harness, model, role } of selected) {
    if (typeof model !== "string" || !model || /\s|[\x00-\x1f\x7f]/.test(model) || model.startsWith("-")) {
      throw new Error(`${role} model must be a nonempty model identifier without whitespace or control characters.`)
    }
    if (harness.key === "codex" && model.startsWith("openai/")) {
      throw new Error(`${role} model '${model}' uses OpenCode provider/model syntax. Codex expects the bare model ID; use '${model.slice(7)}'.`)
    }
    if (harness.key === "opencode" && !/^[^/]+\/.+/.test(model)) {
      throw new Error(`${role} model '${model}' must use OpenCode provider/model syntax (for example, openai/${model}).`)
    }
  }
  const codex = selected.filter(({ harness }) => harness.key === "codex")
  if (!codex.length) return
  const catalog = await readCatalog({ cwd, harness: codex[0].harness })
  // API keys and custom providers can use models outside Codex's picker catalog.
  if (!catalog) return
  for (const { model, role } of codex) {
    if (!catalog.includes(model)) {
      throw new Error(`${role} model '${model}' is not in Codex's ChatGPT model catalog. Available model IDs: ${catalog.join(", ")}. Choose an ID shown by Codex /model.`)
    }
  }
}

/** Metadata only: no threads, prompts, or inference requests. */
export async function readCodexCatalog({ cwd, harness, timeoutMs = 10_000, command = "codex" } = {}) {
  const args = []
  // Match profile/provider overrides used by the lane, without forwarding TUI flags.
  const launchArgs = harness?.launchArgs ?? []
  for (let i = 0; i < launchArgs.length; i += 1) {
    const arg = launchArgs[i]
    if (["-c", "--config", "-p", "--profile"].includes(arg)) args.push(arg, launchArgs[++i])
    else if (/^--(?:config|profile)=/.test(arg)) args.push(arg)
  }
  const child = spawn(command, [...args, "app-server"], { cwd, stdio: ["pipe", "pipe", "pipe"] })
  const lines = createInterface({ input: child.stdout })
  const pending = new Map()
  let nextId = 0
  let failure
  const fail = (error) => {
    failure = error
    for (const { reject } of pending.values()) reject(error)
    pending.clear()
  }
  const timer = setTimeout(() => { fail(new Error("Codex model catalog check timed out")); child.kill("SIGKILL") }, timeoutMs)
  child.on("error", fail)
  child.stdin.on("error", fail)
  child.stderr.resume()
  child.on("exit", () => fail(new Error("Codex exited during the model catalog check")))
  lines.on("line", (line) => {
    let message
    try { message = JSON.parse(line) } catch { fail(new Error("Invalid JSON from Codex model catalog check")); return }
    const request = pending.get(message.id)
    if (!request) return
    pending.delete(message.id)
    if (message.error) request.reject(new Error(message.error.message ?? "Codex catalog request failed"))
    else request.resolve(message.result)
  })
  const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`)
  const request = (method, params) => {
    if (failure) return Promise.reject(failure)
    return new Promise((resolve, reject) => {
      const id = nextId++
      pending.set(id, { resolve, reject })
      send({ id, method, params })
    })
  }
  try {
    await request("initialize", { clientInfo: { name: "tars", version: "1.0.0" } })
    send({ method: "initialized" })
    const { config } = await request("config/read", {})
    const { account } = await request("account/read", { refreshToken: false })
    if (account?.type !== "chatgpt" || (config.model_provider && config.model_provider !== "openai")) return null
    const models = new Set(), cursors = new Set()
    let cursor = null
    do {
      const page = await request("model/list", { includeHidden: true, limit: 100, cursor })
      if (!Array.isArray(page?.data) || page.data.some((model) => typeof model.model !== "string")) {
        throw new Error("Invalid model catalog returned by Codex")
      }
      for (const model of page.data) models.add(model.model)
      cursor = page.nextCursor ?? null
      if (cursor && (typeof cursor !== "string" || cursors.has(cursor))) throw new Error("Invalid Codex model catalog pagination")
      cursors.add(cursor)
    } while (cursor)
    if (!models.size) throw new Error("Codex returned an empty model catalog")
    return [...models]
  } catch (error) {
    throw new Error(`Cannot validate Codex models: ${error.message}. Check Codex login/configuration and try again.`, { cause: error })
  } finally {
    clearTimeout(timer)
    lines.close()
    child.stdin.destroy()
    child.kill("SIGKILL")
  }
}
