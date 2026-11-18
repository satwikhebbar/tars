# Code Review

Find defects by understanding how the change behaves in the application. Rely on the author’s verification, including any pre-commit checks, for routine test results. Inspect test coverage and realism, and run a focused check when it can resolve a specific uncertainty.

Work through these steps before deciding the outcome.

1. **Establish the intended behavior independently.** Read the requested commit and relevant surrounding code. Verify the author’s summary against what the implementation actually does. Organize the review around the behavior that changed.
2. **Identify the invariants.** State what must hold on success, failure, skipped work, retries, and across multi-step operations. For validation changes, check the full set of valid and invalid state combinations.
3. **Trace real inputs through the changed path.** Start at actual callers. Follow what they supply, how the data changes, and what reaches storage or the user. Verify that test fixtures match the inputs available at that boundary.
4. **Compare shared contracts.** Inspect other producers, consumers, and implementations of the changed data or behavior. Check that production and in-memory stores, renderers and evaluators, or helpers and their production orchestration agree wherever they share a contract.
5. **Review tests for false confidence.** Look for injected information unavailable in production, mocks that bypass the changed boundary, assertions that miss the failure, and totals that omit earlier work.
6. **Check neighboring cases when reviewing a fix.** Verify the reported case, then inspect other cases governed by the same rule to see whether the fix holds across them.

In the handoff, name the paths and invariants you examined, explain how the observed behavior supports the outcome, and record any material uncertainty. Report test results as verification details.
