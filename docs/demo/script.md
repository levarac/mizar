# Mizar demo video script

**Target length:** 3 minutes 30 seconds. **Video: TBD.** This is a recording plan, not a record of a completed live demo.

Show the same event, snapshot and event key throughout the evidence-to-claim sequence. Keep a visible label on each shot: **design walkthrough**, **synthetic fixture / local Anvil**, or **live Sepolia**. Use the live label only after that exact operation has succeeded and its result can be shown.

## Shot list and narration

| Time | Shot | Narration |
| --- | --- | --- |
| 0:00–0:20 | Title, then the README architecture diagram. Highlight the existing attendee app and evidence layer, followed by the new evaluator, Alcor and claim contract. | “Mizar makes an event participation rule publicly checkable. An event key qualifies through mutual observations with credentialed partners across multiple time windows. This checks a published rule; it does not prove physical location or prevent collusion.” |
| 0:20–0:55 | Alcor join page: event ID, challenge, typed app-signing request, World ID step and resulting credential. Show the credential's event-key address and signature, with no secrets. Until a real join works, use a labeled design walkthrough and the public signed credential fixture. | “At join time, Alcor binds an event key to a World ID check. The app signs a typed challenge. Alcor checks the proof and publishes a signed credential, accepting one key per nullifier for the event. Mizar trusts Alcor for the human check and independently verifies the credential signature and key binding.” |
| 0:55–1:25 | Observation explanation: two reporters, their reciprocal rotating identifiers and matching time windows. Show the published observation/commitment fixture and inclusion proof. Label synthetic data throughout. | “The existing attendee app signs observations, and an operator anchors commitments to the evidence on Sepolia. A pair counts when each reports the other in the same event, definition and time window. Mizar checks signatures and inclusion, and discards identifiers claimed by multiple keys. These example observations are synthetic.” |
| 1:25–2:00 | Terminal: the fixture evaluate command below. Open `eligible.json` and one proof, then `manifest.json`. Highlight N = 2, B = 2, the snapshot cutoff, root and manifest digest. | “For this fixture, each eligible key needs two credentialed partners and at least two mutual windows with each. Partners are not removed iteratively. The evaluator publishes the eligible set, rejection reasons, proofs and a manifest. Anyone with these inputs can recompute the result.” |
| 2:00–2:40 | Claim-page design: enter a recipient, show the typed authorization fields and the expected app callback. Then show the local E2E runner's actual claim and MockEAS checks. Keep the page walkthrough and automated runner visibly separate. | “The recipient is chosen before signing. The app authorization binds the event key to this recipient, chain and claim contract. The contract checks the Merkle proof and signature, allows one claim per key, and calls EAS. This local rehearsal uses Anvil and MockEAS. It also confirms that a duplicate claim and a changed recipient are rejected.” |
| 2:40–3:15 | Run offline verify; show its actual receipt. Show the local runner's separate `RootPosted` comparison. End on the live verifier requirements in the evaluator README. | “Offline verification recomputes the archived result. PASS here means the fixture is internally consistent. A live chain check also needs independently selected registry addresses, checks the anchor records and cutoff, and compares the posted root and manifest digest. A membership proof alone does not establish that the poster evaluated honestly.” |
| 3:15–3:30 | End card: public Mizar and Alcor repository names, MIT, pending live deployment/video status, brief AI disclosure. | “The claim contract and live configuration are still pending in this snapshot. The code is MIT licensed. The team directed and reviewed AI-assisted development, with independent AI checkers per branch. Mizar's contribution is a reproducible interpretation of shared evidence.” |

## Commands and files to have ready

Use the source revisions and setup instructions in the [README](../../README.md#local-build-and-verification). Start each command block from the relevant source checkout's root. These commands use fixtures and a local chain.

Evaluation and public replay:

```sh
cd evaluator
pnpm mizar evaluate --params test/fixtures/params.json --out /tmp/mizar-readme-out-latest
pnpm mizar verify --manifest /tmp/mizar-readme-out-latest/manifest.json
```

Local claim rehearsal, from the E2E branch checkout:

```sh
cd e2e
pnpm e2e
```

Prepare these views before recording:

- Alcor `web/main.ts` and the join page, with `worker/test/fixtures/signed-credentials-v1.json` as the explicitly synthetic credential fallback.
- Evaluator `test/fixtures/params.json`, `envelopes.json` and `credentials.json` to identify the input set.
- The freshly generated `manifest.json`, `eligible.json`, `rejected.json` and one `proofs/<address>.json` file.
- Claim page `web/src/config.ts`, showing that example configuration is not a deployed service.
- The E2E log's actual attestation, duplicate-claim, wrong-recipient, golden-vector, offline-verification and root-event checks.

Do not show an invented PASS receipt, transaction, deployed address or completed World check. If an operation returns `FAIL` or `UNAVAILABLE`, show the actual result and explain the missing or invalid input. A successful build cannot replace a successful app callback.

## Recording handoff

The recording still needs a human operator. No real-device operation or recording was performed to prepare this script. The sequence above can be recorded as an honest fixture/design demo without claiming live operation.

If a live demo becomes available, replace the relevant shots only after confirming the World configuration, app callback, published snapshot, Sepolia claim contract, schema UID and actual claim result. Replace the fixture narration with what was observed, and keep unverified steps labeled. The live verifier's trusted registry flags are documented in the evaluator README. A live chain ID or an EAS-shaped test output alone is insufficient.

Before publishing the video, remove personal information, credentials, private URLs and unrelated terminal history from the recording. Keep event keys, roots and transaction identifiers visible only when they are intended public demo artifacts. Add the final public video URL to the README's **Video: TBD** placeholder. Record the duration and the source revisions used so the video can be matched to the submission.
