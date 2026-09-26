# Evaluator specification alignment

Sanitized follow-up implementation prompt. The [shared constraints](../README.md#shared-constraints-from-the-prompts) apply.

## Task

Finish the evaluator against the updated specification, including two changes not yet reflected in the earlier implementation:

1. `manifestDigest` is SHA-256 of the exact published `manifest.json` bytes. Verification with chain context compares the root, manifest digest and cutoff block from the claim contract's `RootPosted` event.
2. Under decision D11, an observation counts for a credentialed event key only when its signature recovers that key. An unmatched signer is `not_credentialed`. Emit `delegation_unsupported` only for an explicit, unverifiable claim of signing on behalf of another key; do not infer it from missing data.

Keep the shared app-signature golden vector and Alcor credential fixture passing. Do not claim to rebuild the committed bundle digest from missing bundle bytes.

## Acceptance criteria

From `evaluator/`, require dependency installation, `pnpm test` and `pnpm typecheck` to succeed. Evaluate the checked-in fixture into an output directory and check `manifest.json`, `eligible.json`, `rejected.json` and `proofs/`. Offline verification must return `PASS`; a one-bit input change must return `FAIL` with the appropriate fault. The pitch counterfactual test must still pass.

Report the exact revision, commands, exit codes and counts. Use fixtures only and identify any newly ported reference logic.

## Later refinement

The [follow-up verification review](12-evaluator-follow-up-review.md) adds the requirement that chain and registry identifiers come from the verifier independently of the poster's parameters. The chain-context description above, which in the original brief named only `--rpc` and `--contract`, is historical and is not a complete current chain-verification command.
