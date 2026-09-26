# Alcor follow-up review

Sanitized read-only review prompt for Alcor revision `7909844`. The [shared constraints](../README.md#shared-constraints-from-the-prompts) apply. Review the whole component against the shared specification, not only the last diff.

## Prior finding to verify

At `742b15e`, verification selected the latest challenge by event ID and event key. Binding challenge A and then challenge B for one key could invalidate an otherwise valid proof for A. The correction requires the exact challenge in the verification request, selects the exact bound row, checks expiry and consumption before and after World verification, and sends the saved challenge from the page.

Confirm that the regression test fails against the earlier selection logic and succeeds with the correction. Keep any experimental changes in a disposable source copy.

## Commands and checks

- In `worker/`: install dependencies, run `pnpm test` and `pnpm typecheck`, apply the D1 migration with `pnpm wrangler d1 migrations apply alcor-human-check-local --local`, and start then stop `pnpm wrangler dev --local` after readiness.
- In `web/`: install dependencies and run `pnpm build`. Keep runtime state and logs in a writable temporary directory.
- Check the single-use, ten-minute challenge lifetime and atomic consumption.
- Check `signal = keccak256(eventId || eventKeyAddress || challenge)` and IDKit's signal hashing; do not apply that hashing twice.
- Check one key per nullifier, first-verified ordering, event-key address derivation, purpose-01 signature recovery and low-S enforcement.
- Check Ed25519 signed bytes: `alcor/credential/v1`, a NUL byte, and recursively sorted-key JSON without `attestation`.
- Check persistent page state, callback parsing, and absence of credentials or personal information in committed files.

## Report

Identify the exact revision and any remote-tip movement. Return a clean verdict or severity-ranked findings with file/line, failure scenario, executed evidence versus source reasoning, commands, exit codes, counts and remaining unverified behavior. Do not contact the live World API or change cloud configuration.
