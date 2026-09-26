# Evaluator review

Sanitized read-only review prompt for Mizar revision `0fdef7d`. The [shared constraints](../README.md#shared-constraints-from-the-prompts) apply.

## Task and cross-component checks

Confirm the exact reviewed revision and compare the whole evaluator with the specification, decision D11 and shared app-signature vector. Check that the evaluator's three-address Merkle fixture is byte-identical to the contract fixture, and that its Alcor signed-credential fixture matches the published producer fixture at Alcor revision `448ab64`. Check that the `RootPosted` event signature matches the contract.

## Commands and adversarial checks

From `evaluator/`, run `pnpm install --frozen-lockfile`, `pnpm test` and `pnpm typecheck`. Evaluate `test/fixtures/params.json` into a temporary output directory and run offline verification. Independently recompute the SHA-256 of the exact manifest bytes and the Merkle root from eligible addresses, using the published encoding.

Design tamper checks rather than repeating only the implementation's own tests: flip a root bit, alter a credential signature, and change an input in a way that affects eligibility. Confirm the appropriate failure results and fault codes.

Review these properties:

- Reciprocity uses the same event, definition and time window, with observation-digest deduplication.
- Rotating identifiers map to their signing keys; identifiers claimed by multiple keys are discarded.
- Key pairs accumulate distinct time windows; eligibility requires N credentialed partners, each with B windows, without iterative removal.
- The snapshot cutoff uses an anchor-to-block mapping and missing required live context produces `UNAVAILABLE`.
- Observation signatures and inclusion proofs are verified; Alcor's expected public key is pinned, its signature and app binding are checked, and the first verified key per nullifier wins.
- Rejection reasons and all four output classes match the specification. Provisional progress cannot authorize a claim.
- The manifest digest hashes the exact published bytes. Chain verification compares the root, digest and cutoff with `RootPosted`.
- Missing bundle bytes are not treated as proof of signing on behalf of another key. Ported logic is identified.

## Report

Report the exact revision, a clean verdict or severity-ranked findings, file/line and concrete failure scenarios. Distinguish executed evidence from source reasoning. Include commands, exit codes, counts and unverified paths. Use fixtures and mocks only, with no live RPC or transactions.
