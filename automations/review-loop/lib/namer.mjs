const DIRECTIVE = "TARS_LANE_NAME="

/** Selects safe branch and worktree names, using an LLM suggestion only when it validates. */
export async function chooseLaneName(issue, runNamer) {
  try {
    return parseNameDirective(await runNamer(namerPrompt(issue)))
  } catch {
    return fallbackLaneName(issue)
  }
}

/** Accepts one exact, machine-readable directive and ignores all other output. */
export function parseNameDirective(output) {
  const directives = output
    .split(/\r?\n/)
    .filter((line) => line.startsWith(DIRECTIVE))
    .map((line) => line.slice(DIRECTIVE.length))
  if (directives.length !== 1) throw new Error("Expected exactly one TARS_LANE_NAME directive.")
  const value = JSON.parse(directives[0])
  if (
    !value ||
    typeof value.branch !== "string" ||
    typeof value.worktree_name !== "string" ||
    !isSafeBranch(value.branch) ||
    !isSafeWorktreeName(value.worktree_name)
  ) {
    throw new Error("Namer returned invalid lane names.")
  }
  return { branch: value.branch, worktreeName: value.worktree_name }
}

export function fallbackLaneName(issue) {
  const slug = slugify(issue.title) || "work"
  const worktreeName = `issue-${issue.number}-${slug}`
  return { branch: `issue/${issue.number}-${slug}`, worktreeName }
}

export function namerPrompt(issue) {
  return `You name one git branch and one AoE worktree for a coding task. Do not use tools, commands, files, or network access. Do not explain your answer. Return exactly one line and nothing else:\nTARS_LANE_NAME={"branch":"issue/${issue.number}-short-kebab-summary","worktree_name":"issue-${issue.number}-short-kebab-summary"}\n\nGitHub issue #${issue.number}\nTitle: ${issue.title}\nLabels: ${(issue.labels ?? []).join(", ") || "none"}\nBody:\n${issue.body || "(none)"}`
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
