import { execFile, spawn } from "node:child_process"
import { createInterface } from "node:readline"
import { promisify, stripVTControlCharacters } from "node:util"

const execFileAsync = promisify(execFile)

/** Validate resolved CLI/config values before classification or lane creation. */
export async function assertLaneModels(entries, { cwd, readCatalog = readCodexCatalog, readOpenCode = readOpenCodeCatalog } = {}) {
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
  const catalogs = new Map()
  for (const { harness, model, role } of selected) {
    if (!["codex", "opencode"].includes(harness.key)) continue
    const key = JSON.stringify([harness.key, catalogArgs(harness)])
    if (!catalogs.has(key)) catalogs.set(key, await (harness.key === "codex" ? readCatalog : readOpenCode)({ cwd, harness }))
    const catalog = catalogs.get(key)
    // API keys and custom Codex providers can use models outside its picker.
    if (!catalog || catalog.includes(model)) continue
    if (harness.key === "codex") {
      throw new Error(`${role} model '${model}' is not in Codex's ChatGPT model catalog. Available model IDs: ${catalog.join(", ")}. Choose an ID shown by Codex /model.`)
    }
    const provider = model.slice(0, model.indexOf("/"))
    const available = catalog.filter((id) => id.startsWith(`${provider}/`))
    const detail = available.length
      ? `Model is not in the effective catalog. Examples: ${available.slice(0, 5).join(", ")}.`
      : `Provider '${provider}' is unavailable in this configuration (not connected, disabled, or has no enabled models).`
    throw new Error(`${role} OpenCode model '${model}' is unavailable. ${detail} Run 'opencode models ${provider}' in ${cwd ?? "the target directory"} with the same environment${catalogArgs(harness).includes("--pure") ? " and --pure" : ""}; connect/configure the provider or run 'opencode models --refresh' if the catalog is stale.`)
  }
}

/** Only configuration-affecting flags, never model/session/TUI arguments. */
export function catalogArgs(harness) {
  const args = []
  const launchArgs = harness?.launchArgs ?? []
  for (let i = 0; i < launchArgs.length; i += 1) {
    const arg = launchArgs[i]
    if (harness?.key === "opencode") {
      if (arg === "--pure" || /^--pure=(true|false)$/.test(arg)) args.push(arg)
    } else {
      if (["-c", "--config", "-p", "--profile"].includes(arg)) args.push(arg, launchArgs[++i])
      else if (/^--(?:config|profile)=/.test(arg)) args.push(arg)
    }
  }
  return args
}

/** OpenCode resolves custom models, plugins, credentials and filters itself. */
export async function readOpenCodeCatalog({ cwd, harness, timeoutMs = 10_000, command = "opencode" } = {}) {
  try {
    const { stdout } = await execFileAsync(command, ["models", ...catalogArgs({ ...harness, key: "opencode" })], {
      cwd, timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 8 * 1024 * 1024,
    })
    const models = stripVTControlCharacters(stdout).split(/\r?\n/).filter((line) => line !== "")
    if (!models.length || models.some((id) => !/^[^/\s\x00-\x1f\x7f]+\/[^\s\x00-\x1f\x7f]+$/.test(id))) {
      throw new Error("empty or malformed model catalog")
    }
    return [...new Set(models)]
  } catch (error) {
    // Do not expose provider/plugin stderr, which may contain credentials.
    const reason = error.killed ? "timed out or exceeded the output limit" : error.code ? `command failed (${error.code})` : error.message
    throw new Error(`Cannot validate OpenCode models: ${reason}. Run 'opencode models' in the target directory with the same environment and fix its configuration before retrying.`, { cause: error })
  }
}

/** Metadata only: no threads, prompts, or inference requests. */
export async function readCodexCatalog(options) {
  return (await readCodexModels(options)).catalog
}

export async function readCodexDefaultModel(options) {
  const { defaultModel } = await readCodexModels({ ...options, resolveDefault: true })
  if (!defaultModel) throw new Error("Cannot resolve Codex's default implementation model. Set --author-model or configure the Codex author model in TARS.")
  return defaultModel
}

async function readCodexModels({ cwd, harness, timeoutMs = 10_000, command = "codex", resolveDefault = false } = {}) {
  const args = catalogArgs(harness)
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
    if (resolveDefault && config.model) return { defaultModel: config.model }
    if (!resolveDefault) {
      const { account } = await request("account/read", { refreshToken: false })
      if (account?.type !== "chatgpt" || (config.model_provider && config.model_provider !== "openai")) return { catalog: null }
    }
    const models = new Set(), cursors = new Set()
    let cursor = null
    let defaultModel
    do {
      const page = await request("model/list", { includeHidden: true, limit: 100, cursor })
      if (!Array.isArray(page?.data) || page.data.some((model) => typeof model.model !== "string")) {
        throw new Error("Invalid model catalog returned by Codex")
      }
      for (const model of page.data) {
        models.add(model.model)
        if (model.isDefault) defaultModel ??= model.model
      }
      cursor = page.nextCursor ?? null
      if (cursor && (typeof cursor !== "string" || cursors.has(cursor))) throw new Error("Invalid Codex model catalog pagination")
      cursors.add(cursor)
    } while (cursor)
    if (!models.size) throw new Error("Codex returned an empty model catalog")
    return { catalog: [...models], defaultModel }
  } catch (error) {
    throw new Error(`Cannot validate Codex models: ${error.message}. Check Codex login/configuration and try again.`, { cause: error })
  } finally {
    clearTimeout(timer)
    lines.close()
    child.stdin.destroy()
    child.kill("SIGKILL")
  }
}
