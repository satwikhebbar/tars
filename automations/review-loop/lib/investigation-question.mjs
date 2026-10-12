import { readFile } from "node:fs/promises"

export const NAVIGATION_QUESTION = "navigation-efficiency"
export const questions = Object.freeze({
  [NAVIGATION_QUESTION]: Object.freeze({ version: 1, instructions: new URL("../questions/navigation-efficiency.md", import.meta.url) }),
})

/** Questions supply instructions only; retrieval and report validation remain generic. */
export async function resolveInvestigationQuestion({ question, adHoc, guidance } = {}) {
  if (question !== undefined && adHoc !== undefined) throw new Error("Choose --question or --ad-hoc, not both.")
  if (guidance !== undefined && adHoc === undefined) throw new Error("--report-guidance requires --ad-hoc.")
  if (adHoc !== undefined) {
    if (typeof adHoc !== "string" || !adHoc.trim()) throw new Error("Ad hoc question must not be empty.")
    if (guidance !== undefined && (typeof guidance !== "string" || !guidance.trim())) throw new Error("Report guidance must not be empty.")
    return { identity: { kind: "ad-hoc", text: adHoc }, instructions: adHoc + (guidance ? `\n\nReport guidance:\n${guidance}` : "") }
  }
  const id = question ?? NAVIGATION_QUESTION
  if (!Object.hasOwn(questions, id)) throw new Error(`Unsupported investigation question: ${id}`)
  return { identity: { kind: "built-in", id, version: questions[id].version }, instructions: await readFile(questions[id].instructions, "utf8") }
}
