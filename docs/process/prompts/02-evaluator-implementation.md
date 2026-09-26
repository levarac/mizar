# Evaluator implementation

Sanitized implementation prompt. The [shared constraints](../README.md#shared-constraints-from-the-prompts) apply.

## Task

Build `evaluator/` in TypeScript with Node.js 22+, pnpm and Vitest according to the Evaluation rule section of `docs/design/spec.md`.

Implement observation-v1 COSE_Sign1 ES256K parsing and verification, Merkle inclusion checks, mutual-relation derivation, rotating-identifier ownership with conflict removal, the per-counterpart rule, and an OpenZeppelin standard Merkle tree over event-key addresses. Produce the manifest, eligible list, rejection list and proof files. Provide `evaluate`, `verify` and provisional `progress` CLI commands.

Implement a read adapter for the published verification-envelope format. Test it with fixtures. Follow the pre-existing protocol definition where required, and identify ported logic in file headers.

## Fixtures and acceptance criteria

Create a deterministic generator under `evaluator/test/fixtures` that signs actual observation objects with clearly labeled synthetic keys and produces verification-envelope-shaped inputs and credentials. Use the cases in `docs/design/pitch-scenario.md`:

- Three honest participants, A, B and C, observe one another across two time windows and qualify.
- One simulated adversary uses three keys with one nullifier and observes A, B and its own keys; at most one of those keys qualifies.
- A credentialed participant with no encounters is rejected with `too_few_partners`.
- A rotating identifier claimed by multiple keys is discarded.
- A tampered observation is rejected with an explicit reason.

Test the three counterfactuals from the pitch: no distinct-human requirement, no encounter requirement, and the full rule. Assert the expected table rather than deriving the expected answer from the implementation being tested.

From `evaluator/`, require dependency installation and `pnpm test` to succeed. Run `pnpm mizar evaluate --params test/fixtures/params.json --out <output-directory>` and check all four output classes. Run `pnpm mizar verify --manifest <output-directory>/manifest.json` and expect `PASS`. A one-bit input change must produce `FAIL` with the appropriate fault.

## Delivery evidence

Report the exact revision, commands, exit codes, counts and unresolved limitations. Keep the contract, app-signature and Alcor credential formats consistent with the shared specification.
