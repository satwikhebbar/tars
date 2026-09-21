import { execFile } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

export async function runHarnessPreflight(harness, prompt) {
  const directory = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "tars-lane-namer-"))
  try {
    const commands = {
      opencode: ["opencode", ["run", "--pure", "--dir", directory, prompt]],
      claude: ["claude", ["-p", prompt]],
      cursor: ["cursor", ["-p", prompt]],
    }
    const entry = commands[harness.key]
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
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}
