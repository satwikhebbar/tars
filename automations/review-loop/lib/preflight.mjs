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
    const { stdout } = await execFileAsync(entry[0], entry[1], { cwd: directory, timeout: 60_000, maxBuffer: 1_000_000 })
    return stdout
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}
