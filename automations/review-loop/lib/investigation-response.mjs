export const PAGE_LIMITS = Object.freeze({ bytes: 16384, tokens: 4000 })
export const CONTENT_LIMITS = Object.freeze({ bytes: 8192, tokens: 2000 })

let tokenizer
/** Load only local ranks. Estimates describe a response, not a harness session. */
export async function localTokenCounter(load = () => Promise.all([
  import("js-tiktoken/lite"), import("js-tiktoken/ranks/o200k_base"),
])) {
  try {
    const [{ Tiktoken }, { default: ranks }] = await load()
    const encoding = new Tiktoken(ranks)
    return { method: "local:o200k_base", count: (text) => encoding.encode(text, [], []).length }
  } catch {
    return { method: "approximate:four-characters-per-token", count: (text) => Math.ceil([...text].length / 4) }
  }
}
export const defaultTokenCounter = () => tokenizer ??= localTokenCounter()

/** Prefer whitespace boundaries; bound work even for unbroken text. Totals remain approximate. */
export function estimateContentTokens(text, counter, count = (part) => counter.count(part)) {
  const limit = 2048
  if (text.length <= limit) return { estimatedTokens: count(text), method: counter.method }
  let tokens = 0
  for (let start = 0; start < text.length;) {
    let end = Math.min(start + limit, text.length)
    if (end < text.length) {
      // Keep leading whitespace with the following word, as tokenizers commonly do.
      // Search the latter half so an early space cannot create tiny chunks.
      for (let boundary = end; boundary >= start + limit / 2; boundary--) {
        if (/\s/u.test(text[boundary]) && !/\s/u.test(text[boundary - 1])) { end = boundary; break }
      }
    }
    if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]) && /[\uDC00-\uDFFF]/.test(text[end])) end--
    tokens += count(text.slice(start, end)); start = end
  }
  return { estimatedTokens: tokens, method: `${counter.method}:chunked-estimate` }
}

/** Include escaping, envelope, estimates and the stdout newline in the byte cap. */
export function measureResponse(value, counter) {
  const result = { ...value, responseBytes: 0, estimatedTokens: 0, tokenEstimateMethod: counter.method }
  for (let i = 0; i < 12; i++) {
    const serialized = JSON.stringify(result) + "\n"
    const bytes = Buffer.byteLength(serialized), tokens = counter.count(serialized)
    if (result.responseBytes === bytes && result.estimatedTokens === tokens) return result
    result.responseBytes = bytes; result.estimatedTokens = tokens
  }
  // Self-referential token digits can oscillate. Report a conservative upper bound.
  result.estimatedTokens += 16
  for (let i = 0; i < 4; i++) result.responseBytes = Buffer.byteLength(JSON.stringify(result) + "\n")
  return result
}
export function fitsResponse(value, counter, limits) {
  const measured = measureResponse(value, counter)
  return measured.responseBytes <= limits.bytes && measured.estimatedTokens <= limits.tokens ? measured : null
}
