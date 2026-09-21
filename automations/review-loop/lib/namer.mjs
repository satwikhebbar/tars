const DIRECTIVE = "TARS_LANE_PREFLIGHT="

/** Selects a lane name and planning path using an LLM suggestion only when it validates. */
export async function chooseLanePreflight(issue, runNamer, { onFallback } = {}) {
  try {
    return parsePreflightDirective(await runNamer(namerPrompt(issue)))
  } catch (error) {
    onFallback?.(error)
    return fallbackLanePreflight(issue)
  }
}

/** Accepts one exact, machine-readable directive and ignores all other output. */
export function parsePreflightDirective(output) {
  const directives = output
    .split(/\r?\n/)
    // OpenCode may render the machine-readable line as Markdown and escape
    // underscores. Those escapes are presentation-only, so normalize them
    // before applying the exact directive and JSON validation.
    .map((line) => line.replaceAll("\\_", "_"))
    .filter((line) => line.trim().startsWith(DIRECTIVE))
    .map((line) => extractDirectiveJson(line.trim().slice(DIRECTIVE.length)))
  if (directives.length !== 1) throw new Error("Expected exactly one TARS_LANE_PREFLIGHT directive.")
  const value = JSON.parse(directives[0])
  if (
    !value ||
    typeof value.branch !== "string" ||
    typeof value.worktree_name !== "string" ||
    !["required", "not_required"].includes(value.planning) ||
    !isSafeBranch(value.branch) ||
    !isSafeWorktreeName(value.worktree_name)
  ) {
    throw new Error("Preflight returned invalid lane settings.")
  }
  return { branch: value.branch, worktreeName: value.worktree_name, planning: value.planning }
}

function extractDirectiveJson(value) {
  const start = value.indexOf("{")
  if (start < 0) throw new Error("Preflight directive is missing its JSON object.")
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = start; index < value.length; index += 1) {
    const character = value[index]
    if (inString) {
      if (escaped) escaped = false
      else if (character === "\\") escaped = true
      else if (character === '"') inString = false
      continue
    }
    if (character === '"') inString = true
    else if (character === "{") depth += 1
    else if (character === "}" && --depth === 0) return value.slice(start, index + 1)
  }
  throw new Error("Preflight directive has incomplete JSON.")
}

export function fallbackLanePreflight(issue) {
  const slug = slugify(issue.title) || "work"
  const worktreeName = `issue-${issue.number}-${slug}`
  // A malformed or unavailable LLM preflight must take the safer review path.
  return { branch: `issue/${issue.number}-${slug}`, worktreeName, planning: "required" }
}

export function namerPrompt(issue) {
  return `You classify and name one git lane. Do not use tools, commands, files, or network access. A plan is required for a feature, enhancement, cross-cutting/risky change, or when issue text leaves material design choices open. It is not required only for a clearly bounded, low-risk fix. Do not explain your answer. Return exactly one line and nothing else:\nTARS_LANE_PREFLIGHT={"branch":"issue/${issue.number}-short-kebab-summary","worktree_name":"issue-${issue.number}-short-kebab-summary","planning":"required"}\n\nGitHub issue #${issue.number}\nTitle: ${issue.title}\nLabels: ${(issue.labels ?? []).join(", ") || "none"}\nBody:\n${issue.body || "(none)"}`
}

function isSafeBranch(branch) {
  return /^(?!.*(?:\.\.|\/\/|@\{|[~^:?*\\[\s]))[a-z0-9][a-z0-9._/-]*[a-z0-9]$/.test(branch)
}

function isSafeWorktreeName(name) {
  return /^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(name)
}

function slugify(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
}
