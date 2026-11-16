import { execFile } from "node:child_process"
import { mkdtemp, realpath, rm } from "node:fs/promises"
import { join } from "node:path"
import { promisify } from "node:util"
import { assertLaneModels, catalogArgs } from "./models.mjs"

const execFileAsync = promisify(execFile)

export async function prepareHarnessPreflight(harness, { model, validateModels = assertLaneModels } = {}) {
  const directory = await realpath(await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "tars-lane-namer-")))
  const classifierHarness = { ...harness, launchArgs: harness.key === "opencode" ? ["--pure"] : catalogArgs(harness) }
  try {
    await validateModels([{ harness: classifierHarness, model, role: "classifier" }], { cwd: directory })
  } catch (error) {
    await rm(directory, { recursive: true, force: true })
    throw new Error(`${error.message} The classifier runs in an isolated temporary directory${harness.key === "opencode" ? " with --pure (no external plugins)" : ""}. Set --classifier-model to a model available there, or configure harnesses.${harness.key}.defaults.classifier.model.`, { cause: error })
  }
  return {
    run: (prompt) => executePreflight(classifierHarness, directory, prompt, model),
    dispose: () => rm(directory, { recursive: true, force: true }),
  }
}

export async function runHarnessPreflight(harness, prompt, options = {}) {
  const context = await prepareHarnessPreflight(harness, options)
  try {
    return await context.run(prompt)
  } finally {
    await context.dispose()
  }
}

async function executePreflight(harness, directory, prompt, model) {
  const entry = preflightCommand(harness, directory, prompt, model)
  if (!entry) throw new Error(`${harness.displayName} has no TARS preflight adapter`)
  try {
    const { stdout } = await execFileAsync(entry[0], entry[1], { cwd: directory, timeout: 60_000, maxBuffer: 1_000_000 })
    return stdout
  } catch (error) {
    // Some harness versions write a usable answer to stderr before exiting
    // nonzero. Let the strict directive parser decide whether that output is
    // safe to accept; preserve genuine command failures otherwise.
    const message = error.message?.startsWith("Command failed:") && error.message.includes("\n")
      ? error.message.slice(error.message.indexOf("\n") + 1)
      : error.message
    const output = [error.stdout, error.stderr, message].filter(Boolean).join("\n")
    if (output.includes("TARS") && output.includes("PREFLIGHT")) return output
    throw error
  }
}

export function preflightCommand(harness, directory, prompt, model) {
  const modelArgs = model ? ["--model", model] : []
  const commands = {
    opencode: ["opencode", ["run", "--pure", "--dir", directory, ...modelArgs, prompt]],
    codex: ["codex", [...catalogArgs(harness), "exec", "--ephemeral", "--skip-git-repo-check", "--sandbox", "read-only", "--color", "never", ...modelArgs, prompt]],
    claude: ["claude", ["--print", "--no-session-persistence", "--permission-mode", "plan", ...modelArgs, prompt]],
    cursor: ["cursor", ["-p", ...modelArgs, prompt]],
  }
  return commands[harness.key]
}
