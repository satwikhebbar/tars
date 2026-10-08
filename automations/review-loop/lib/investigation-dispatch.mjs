import { randomUUID } from "node:crypto"

const marker = /\[TARS dispatch ID: ([0-9a-f-]{36})\]/gi

/** The ID is observability metadata; the journal never copies the prompt body. */
export function markedDispatch(prompt) {
  const id = randomUUID()
  return { id, message: `${prompt}\n\n[TARS dispatch ID: ${id}]` }
}

export function dispatchIdIn(text) {
  if (typeof text !== "string") return null
  // A prompt may quote an earlier dispatch; TARS appends the current marker last.
  return [...text.matchAll(marker)].at(-1)?.[1]?.toLowerCase() ?? null
}
