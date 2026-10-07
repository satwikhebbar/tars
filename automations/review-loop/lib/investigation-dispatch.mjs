import { randomUUID } from "node:crypto"

const marker = /\[TARS dispatch ID: ([0-9a-f-]{36})\]/i

/** The ID is observability metadata; the journal never copies the prompt body. */
export function markedDispatch(prompt) {
  const id = randomUUID()
  return { id, message: `${prompt}\n\n[TARS dispatch ID: ${id}]` }
}

export function dispatchIdIn(text) {
  return typeof text === "string" ? marker.exec(text)?.[1]?.toLowerCase() ?? null : null
}
