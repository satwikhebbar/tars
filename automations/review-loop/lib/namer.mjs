const DIRECTIVE = "TARS_LANE_PREFLIGHT="

/** Selects a lane name and planning path using an LLM suggestion only when it validates. */
export async function chooseLanePreflight(issue, runNamer) {
  try {
    return parsePreflightDirective(await runNamer(namerPrompt(issue)))
  } catch {
    return fallbackLanePreflight(issue)
  }
}

/** Accepts one exact, machine-readable directive and ignores all other output. */
export function parsePreflightDirective(output) {
  const directives = output
    .split(/\r?\n/)
    .filter((line) => line.startsWith(DIRECTIVE))
    .map((line) => line.slice(DIRECTIVE.length))
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
