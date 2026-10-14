---
name: address-pr-feedback
description: Address feedback on a TARS lane pull request and publish an author response for re-review.
---

# Address PR Feedback

Work in the assigned TARS lane and involve its reviewer before publishing code
changes to the pull request.

1. Read every unresolved review thread on the existing pull request. For each
   comment, record whether it calls for a code change or a response only, and
   briefly explain the disposition. A requested change may be declined when it
   is outside the PR's scope or is not appropriate; do not silently ignore it.
   Ask the user when the choice has meaningful scope or product consequences
   that cannot be resolved from the PR context.
2. Reply in the original thread for comments that will not result in a code
   change. Explain the decision clearly. Verify that each reply is visible. If
   a reply fails, report the failure as a blocker and do not claim the feedback
   is complete.
3. If any accepted feedback calls for code changes, make and verify them, commit
   them, then publish an `implementation-response` with `created_by: author`,
   `reopen: true`, and the immutable `head_commit`. Do not reply to comments
   addressed by these code changes yet; first submit the commit through the
   TARS reviewer handoff. If all feedback is response only or declined, finish
   after replying to those threads; do not create an empty commit or handoff.
4. When TARS wakes you after reviewer feedback, address the requested review
   changes, verify and commit them, and publish the next `implementation-response`
   for the same workflow. Continue the reviewer loop until the reviewer
   approves. Do not push or post code-change replies while review changes are
   still requested or the review is blocked.
5. After reviewer approval, push the approved branch so the existing PR is
   updated. Then reply in the original PR threads for all comments addressed
   by the code changes, referencing the resulting commit. Verify the replies
   are visible. Report any push or GitHub reply failure as a blocker. Do not
   create a second pull request.

Keep a checklist of the original threads and their disposition across reviewer
rounds so each comment is handled exactly once. Reviewer handoffs are for
reviewing immutable commits; do not treat a reviewer verdict as a response to
the original GitHub threads.

This is an explicit follow-up workflow. If an earlier coordinator message said the
approved handoff was complete or said not to create another handoff, that
instruction applied only to the then-current push/PR task. When the user or
coordinator later asks you to address feedback on that existing pull request,
use this skill and publish the reopen response; do not stop because of the
earlier terminal-task wording.
