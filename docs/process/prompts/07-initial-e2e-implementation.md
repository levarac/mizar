# Initial local claim rehearsal

Sanitized implementation prompt. The [shared constraints](../README.md#shared-constraints-from-the-prompts) apply.

**Historical instruction:** this first version deliberately built a Merkle tree directly because the evaluator was not integrated yet. It was superseded by the evaluator-backed flow described in [the E2E review](11-e2e-review.md). It is not the current E2E design.

## Task

Add an `e2e/` package with `pnpm e2e`. Start a local Anvil chain and deploy MockEAS and the claim contract with a configured root poster. Place the claim contract at the address required by the shared app-signature golden vector.

Build a standard Merkle tree containing the golden vector's event-key address and two other public test addresses, using the leaf encoding in the specification. Post the root, submit the golden vector's claim, and assert:

- An attestation is issued to the expected recipient with the expected data.
- A second claim for the same event key reverts.
- A claim with a changed recipient reverts.

Document the temporary direct-tree step and the planned replacement with evaluator output. Keep contract-address assumptions explicit; all accounts and values must be local test fixtures.

## Acceptance criteria

From `e2e/`, dependency installation and `pnpm e2e` exit successfully and print the three assertions. From `contracts/`, `forge test` still passes. Report the exact revision, command results and fixture-only limitations. No Sepolia or mainnet transaction is authorized.
