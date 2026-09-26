# Evaluator follow-up review

Sanitized read-only review prompt for Mizar revision `eae54bc`. The [shared constraints](../README.md#shared-constraints-from-the-prompts) apply. Confirm the requested revision before assessing the corrections.

## Prior findings and required corrections

An earlier review found that chain verification could accept trust context from poster-written parameters, and that commitment-chain continuity and completeness were not checked on every evidence path.

Adversarially verify these corrections:

1. Chain verification requires the verifier's independently chosen `--chain-id`, `--event-registry`, `--definition-registry` and `--commitment-registry`, in addition to `--rpc` and `--contract`. Missing context or an RPC chain mismatch returns `UNAVAILABLE`.
2. Parameters naming another chain or registry fail with `root_mismatch`. Event admission, commitment-to-block mapping and cutoff timestamp are checked against the specified registries.
3. A commitment anchored at or before the cutoff but absent from the input causes failure.
4. Commitment sequence starts at one and previous-digest continuity is checked even for a single evidence page.
5. Credential JSON keys are sorted by code point. Missing anchor mapping yields an `UNAVAILABLE` receipt. Altering a credential signature and updating surrounding digests still fails as `invalid_signature`.

Try to construct a false `PASS` with and without chain verification. Make mutations only in disposable copies. Check deterministic roots, manifest digests, identifier ownership/conflicts, credential binding and shared signature bytes against the specification.

## Commands and expected fixture behavior

Install dependencies inside `evaluator/`; isolate an enclosing pnpm workspace only if necessary. Run `pnpm test`, `pnpm typecheck`, fixture evaluation and offline verification. The implementation report to be checked claimed 20 passing tests. Verify that bit changes fail; do not treat the prior report as evidence of the current run. Use mocked RPC data, not a live RPC.

## Historical terminology correction

One sentence in the original follow-up brief used the obsolete term “k-core” for eligibility. The authoritative specification uses a credential requirement and a per-partner N/B threshold without iterative removal. This annotation makes the inconsistency explicit; it does not change the historical brief into evidence that a different algorithm was implemented.

Report exact-revision findings, executed commands, exit codes, counts and all unverified paths.
