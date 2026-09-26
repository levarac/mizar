# Submission documentation corrections

Sanitized correction prompt following review of Mizar revision `b0f432e`. The [shared constraints](../README.md#shared-constraints-from-the-prompts) apply. Change the README and demo script, not evaluator code.

## Required corrections

- Disclose that `evaluator/src/evaluate.ts` function `deriveRelations` reimplements the pre-existing mutual-pair definition: both reporters list one another's rotating identifier in the same event, definition and time window. Keep that origin distinct from the new identifier-conflict filter, per-key-pair window accumulation, N/B threshold, credential requirement and snapshot outputs.
- Name the pre-existing protocol reference implementation by role as the origin of the ported files and relation definition. Do not publish unpublished source revision identifiers.
- Explain that the specifications and decisions directing AI implementation are in `docs/design/`; team members set the rule, design and scope, and each branch was reviewed by a separate AI agent before integration.
- Add a concrete source-checkout example for the inspected evaluator revision `eae54bc`, with `c9c7f1d` as the E2E example.
- Tell readers to add `--ignore-workspace` to the Alcor package install when an enclosing pnpm workspace interferes.
- Limit the pinned-source claim to the component table, or pin all affected links explicitly.
- Specify in the demo narration that the pending deployment is the Sepolia deployment of the claim contract, alongside pending live configuration.

## Verification and report

Run `git diff --check` and English, public-information and link-target validation. The correction brief did not require rerunning builds or tests because this round changed documentation only. Report the exact resulting revision and commands actually run.
