---
description: Continue a TARS lane in OpenCode Build mode
agent: build
# Without this, older OpenCode releases can run Build as a child task and
# return the primary session to tars-plan after the command completes.
subtask: false
tars-owned: true
---

$ARGUMENTS
