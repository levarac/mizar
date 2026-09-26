# Submission documentation review

Sanitized read-only review prompt for Mizar revision `b0f432e`. The [shared constraints](../README.md#shared-constraints-from-the-prompts) apply. Review `README.md` and `docs/demo/script.md` at the specified revision.

## Checklist

1. Verify every factual statement against its cited source revision: Mizar main `b755abc`, evaluator `eae54bc`, E2E `c9c7f1d`, and Alcor `b016899`. Identify anything described as complete that is unfinished, unresolved links, or moving references incorrectly described as pinned.
2. Check the completeness of pre-existing-work disclosure: initial commits, ported files and the existing app/protocol work. Do not infer that repository creation during the event makes every underlying algorithm new.
3. Check public-document hygiene: English text, no confidential values, personal identifiers or internal coordination details. Use role descriptions for unpublished repositories unless naming is expressly authorized.
4. Keep video, deployed addresses, schema UID, live World verification, real-device flow and live claim clearly pending where unverified.
5. Reproduce the documented local commands from a clean source copy. Run package installs, tests and builds as documented; if an enclosing pnpm workspace captures installation, try `--ignore-workspace` and report the missing instruction. Run contract build and tests without live broadcasts.
6. Check that the proposed video shots are feasible with the available artifacts and do not imply an unbuilt live flow.

## Report

Return the exact revision and either a clean verdict or findings with severity, file/line, the concrete issue and proposed wording. Include actual command exits and what could not be verified. A request to run checks is not itself evidence that they passed.
