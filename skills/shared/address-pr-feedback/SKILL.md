---
name: address-pr-feedback
description: Address feedback on a TARS lane pull request and publish an author response for re-review.
---

# Address PR Feedback

Work in the assigned lane. Apply and verify the feedback, commit the result, then publish an `implementation-response` with `created_by: author` and `reopen: true` so TARS asks the reviewer to re-review the existing pull request.

This is an explicit follow-up workflow. If an earlier coordinator message said the
approved handoff was complete or said not to create another handoff, that
instruction applied only to the then-current push/PR task. When the user or
coordinator later asks you to address feedback on that existing pull request,
use this skill and publish the reopen response; do not stop because of the
earlier terminal-task wording.
