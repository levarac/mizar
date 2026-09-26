# Claim-page follow-up review

Sanitized read-only review prompt for Mizar revision `68cd65e`. The [shared constraints](../README.md#shared-constraints-from-the-prompts) and the [initial review checklist](09-claim-page-review.md) apply. Review the whole component after confirming the exact revision.

## Prior findings to verify

The earlier page used a purpose-01 app request to learn the event key, but that purpose returns to the human-check page. It also disagreed with the evaluator's eligibility-file shape and proof filenames.

The corrected flow must ask for a recipient first, open only a purpose-02 request, then accept the callback only when `st` matches, the address derived from `k` equals `a`, and signature recovery equals `a`. Load eligibility for that key afterward. The claim page must never open a purpose-01 request or obtain the recipient from its own URL.

Consume the actual evaluator output formats:

- `eligible.json` contains `addresses` and `explanations`.
- `proofs/<lowercase-address>.json` contains `address`, `root` and `proof`.

Compare checked-in page fixtures with real evaluator output or compare the files byte for byte against the published evaluator fixtures.

## Additional regression checks

Confirm a test covers exact claim-link construction; callback key and signature are checked locally; a zero-address recipient is rejected; app cancellation is visible; stale claim state is cleared when the key changes; and the proof root matches the configured root.

Rerun dependency installation, tests and the static build. Independently recompute the shared golden-vector digest and signer. If an enclosing pnpm workspace captures installation, use `--ignore-workspace` and confirm dependencies are installed in the component directory without changing unrelated files.

Report every corrected finding and any regression with exact-revision evidence, command exits, test counts and remaining limits. Fixtures and mocks only; no live transactions or real-device automation.
