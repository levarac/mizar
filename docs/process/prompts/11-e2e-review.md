# Evaluator-backed E2E review

Sanitized read-only review prompt for Mizar revision `c9c7f1d`. The [shared constraints](../README.md#shared-constraints-from-the-prompts) apply. Focus on `e2e/` and its component boundaries.

## Task

Verify the replacement of the initial direct-tree rehearsal with the real evaluator CLI. The run must evaluate fixture evidence and credentials, post the resulting root on local Anvil, perform a claim and inspect MockEAS output.

The root, manifest digest and cutoff block must come from the evaluator output and parameters. The digest is SHA-256 of the exact manifest bytes. Use an eligible fixture key's public deterministic signing key and matching proof for the purpose-02 claim. Keep the shared golden vector as a separate byte-for-byte codec check because its event key is not in the evaluator's eligible set.

Read `RootPosted` from the local chain in the script. A fixture run without real evidence registries cannot establish complete live chain verification.

## Commands and assertions

- In `contracts/`, run `forge build` and `forge test`.
- Install evaluator and E2E dependencies, then run `pnpm e2e` from `e2e/`. Confirm dependencies remain local to the component.
- Confirm the tree is produced by the real CLI, not rebuilt independently inside the runner.
- Confirm the attestation recipient and `abi.encode(eventId, eventKeyAddress, snapshotId, manifestDigest)`, with `revocable = false` and zero expiration.
- Require the second claim to fail specifically with `AlreadyClaimed`, not just any revert. Submit the valid claim from a wallet different from the event key.
- Compare golden-vector bytes with the checked-in vector, not the runner's own generated expectation.
- Introduce one deliberate fault in a disposable copy, such as changing the signed recipient, and confirm a non-zero exit.
- Review Anvil cleanup on success and failure, port handling, deterministic address assumptions, absence of live-network access and use of public test keys only.

## Report

Report the exact revision, findings with concrete failure cases and evidence, command exits, counts and unverified behavior. This review permits a local Anvil rehearsal only; it does not authorize a live deployment or claim.
