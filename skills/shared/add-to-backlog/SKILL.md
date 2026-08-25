---
name: add-to-backlog
description: Capture a new backlog item as a GitHub issue for the current repository.
---

# Add to Backlog

Read the repository issue conventions, create a concise GitHub issue containing the problem, desired outcome, and acceptance criteria, and report its URL.

## Markdown bodies

For a multiline issue body, write actual Markdown to a temporary file and pass it with `gh issue create --body-file <path>` or `gh issue edit --body-file <path>`. Use ordinary `--body` only for a short single-paragraph body. This preserves headings, paragraphs, and lists in GitHub.
