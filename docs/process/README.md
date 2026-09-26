# Development prompts and planning artifacts

The maintainer made the design decisions recorded in [docs/design/decisions.md](../design/decisions.md). AI coding agents implemented each component under [docs/design/spec.md](../design/spec.md), and a separate AI agent reviewed each branch before integration. The team retained responsibility for the rule, design, scope and integration decisions.

This archive contains edited, sanitized versions of the instructions used during development. It is not a verbatim transcript or a complete conversation history. Eighteen source texts were supplied: fifteen implementation, review and correction briefs are represented below; three planning briefs are summarized in the next section. Local setup details, identities, account information and unpublished source references have been removed. Repeated constraints are consolidated here. No code from the pre-existing reference implementation is reproduced.

The numbering follows development phases and the known revision order within each component. Components were developed in parallel, and the source copies do not preserve original send times, so the numbers do not assert a precise chronology across components. Earlier instructions that were superseded are labeled explicitly. The specification remains the implementation authority.

These documents preserve requested checks, not proof that every requested check ran or passed. Observed local results and their limits are recorded in the [submission README](../../README.md#observed-local-results). No new build or runtime verification was performed when preparing this archive.

## Planning record

The three planning briefs describe these successive stages:

1. **Initial component plan.** Build the claim contract, evaluator and Alcor human-check service from the shared specification. Use the same app-signature bytes, event-key address derivation, Merkle leaf encoding and golden vectors across all components. Resolve specification ambiguities explicitly. After contract and evaluator review, add the claim page and a local end-to-end rehearsal.
2. **Specification alignment and follow-up review.** The contract was already integrated. The evaluator needed the exact manifest-byte digest and the refined signer-attribution rule from decision D11. Alcor needed a new review of the overlapping-challenge correction. Keep the app, service and contract signing formats consistent, and report each review against its exact revision before integration.
3. **Integration and submission plan.** Review the evaluator's strengthened chain verification, then update the E2E rehearsal to consume the evaluator result and verify it again. Continue claim-page and submission-documentation work. Keep local package installation isolated from any enclosing pnpm workspace. Retain the distinction between fixture checks and a future live demonstration.

The planning briefs also called for review of the full affected component after corrections, rather than treating a small diff as sufficient evidence of correctness. Integration followed a separate review; the implementing AI agent did not supply its own review verdict.

## Shared constraints from the prompts

- Read the specification, design decisions and `docs/design/test-vectors/app-signature-v1.json` before implementation or review. Identify the exact source revision being assessed.
- Use fixtures, mocks and local chains for automated checks. Do not operate real devices, deploy to live networks, send live transactions, or change Cloudflare or World Developer Portal configuration.
- Use deterministic public test keys only for synthetic fixtures. Keep credentials and personal information out of source, logs and reports.
- Preserve the distinction between new code and logic derived from the pre-existing evidence-layer reference. Mark ported logic and disclose reused definitions.
- Keep implementation changes within the assigned component. Reviews are read-only; experiments that alter behavior belong in disposable copies. Integration is a separate decision.
- Report actual commands, exit codes and test counts at the exact revision. Distinguish findings demonstrated by execution from findings based on source inspection. State what remains unverified.
- Use small, change-focused commits with no generated attribution or co-author lines. These prompts do not authorize deployment or publication of any unfinished live service.

## Prompt-to-component map

| Prompt | Component or artifact | Relationship to the code |
| --- | --- | --- |
| [01 — Claim contract implementation](prompts/01-claim-contract-implementation.md) | Mizar `contracts/` | Initial contract, EAS integration, tests and preparation scripts |
| [02 — Evaluator implementation](prompts/02-evaluator-implementation.md) | Mizar `evaluator/` | Evidence checks, rule, fixtures and CLI |
| [03 — Alcor implementation](prompts/03-alcor-implementation.md) | Alcor `worker/` and `web/` | Human-check service and join page |
| [04 — Evaluator specification alignment](prompts/04-evaluator-spec-alignment.md) | Mizar `evaluator/` | Manifest digest and D11 refinements |
| [05 — Alcor follow-up review](prompts/05-alcor-review.md) | Alcor `7909844` | Exact-challenge correction and whole-component review |
| [06 — Claim page implementation](prompts/06-claim-page-implementation.md) | Mizar `web/` | App callback, recipient authorization and claim submission |
| [07 — Initial local claim rehearsal](prompts/07-initial-e2e-implementation.md) | Mizar `e2e/` | Initial direct-tree rehearsal, later replaced by evaluator output |
| [08 — Evaluator review](prompts/08-evaluator-review.md) | Mizar `0fdef7d` | Evidence, credentials, outputs and tamper checks |
| [09 — Initial claim-page review](prompts/09-claim-page-review.md) | Mizar `593329b` | Signing, callback and data-shape review |
| [10 — Claim-page follow-up review](prompts/10-claim-page-follow-up-review.md) | Mizar `68cd65e` | Purpose-02 flow and evaluator-output compatibility |
| [11 — Evaluator-backed E2E review](prompts/11-e2e-review.md) | Mizar `c9c7f1d` | Real evaluator output through local claim and MockEAS |
| [12 — Evaluator follow-up review](prompts/12-evaluator-follow-up-review.md) | Mizar `eae54bc` | Verifier-selected chain context and commitment completeness |
| [13 — Submission documentation](prompts/13-submission-documentation.md) | Mizar `README.md`, `docs/demo/` | Submission explanation, disclosure and video plan |
| [14 — Submission review](prompts/14-submission-review.md) | Mizar `b0f432e` | Factual claims, reproduction and public-information checks |
| [15 — Submission corrections](prompts/15-submission-corrections.md) | Mizar `README.md`, `docs/demo/` | Provenance, reproduction and AI-review wording corrections |

The supplied set contains no standalone contract-review prompt or first Alcor-review prompt. This archive does not reconstruct missing instructions. It also does not claim that prompt existence alone proves a review outcome. The app-side typed signing work is described in the [pre-existing-work disclosure](../../README.md#pre-existing-work-and-hackathon-contributions); its source publication is pending.
