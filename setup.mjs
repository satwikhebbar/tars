#!/usr/bin/env node
import { createInterface } from "node:readline/promises"
import { stdin as input, stdout as output } from "node:process"
import { dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { installedAoeTools, BUILTIN_HARNESSES, loadHarnessConfig, provisionHarnessSkills, provisionOpenCodeCommand, saveHarnessConfig } from "./automations/review-loop/lib/harnesses.mjs"

const ROOT = dirname(fileURLToPath(import.meta.url))

async function main() {
  const config = await loadHarnessConfig()
  const installed = await installedAoeTools()
  const choices = Object.values(BUILTIN_HARNESSES).filter((harness) => installed.has(harness.tool))
  if (!choices.length) throw new Error("No supported AoE harness is installed. Run `aoe agents` first.")
  const rl = createInterface({ input, output })
  try {
    const names = choices.map((harness) => harness.key).join(", ")
    const author = await choose(rl, `Default author (${names}) [${config.defaults.author}]: `, choices, config.defaults.author)
    const reviewer = await choose(rl, `Default reviewer (${names}) [${config.defaults.reviewer}]: `, choices, config.defaults.reviewer)
    config.defaults = { author, reviewer }
    await saveHarnessConfig(config)
    await Promise.all([provisionHarnessSkills({ root: ROOT, harness: BUILTIN_HARNESSES[author] }), provisionHarnessSkills({ root: ROOT, harness: BUILTIN_HARNESSES[reviewer] })])
    if (author === "opencode") await provisionOpenCodeCommand(ROOT)
    console.log(`Configured TARS defaults: author=${author}, reviewer=${reviewer}`)
  } finally { rl.close() }
}

async function choose(rl, question, choices, fallback) {
  const answer = (await rl.question(question)).trim() || fallback
  if (!choices.some((harness) => harness.key === answer)) throw new Error(`Choose one installed harness: ${choices.map((harness) => harness.key).join(", ")}`)
  return answer
}

await main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1 })
