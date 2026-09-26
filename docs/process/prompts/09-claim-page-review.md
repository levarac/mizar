# Initial claim-page review

Sanitized read-only review prompt for Mizar revision `593329b`. The [shared constraints](../README.md#shared-constraints-from-the-prompts) apply.

## Task

Review `web/` against the shared specification and app-signature golden vector. Confirm the target revision and the contract ABI:

```text
claim(uint64 snapshotId, address eventKeyAddress, bytes32[] proof,
      address recipient, bytes appSignature)
```

The purpose-02 body is `chainId || claimContract || recipient` with the specified fixed widths. The signature is 65-byte `r || s || v` with low-S. Callback fields are `sig`, `k`, `a` and `st`.

## Acceptance and review checklist

- The page shows eligibility for the event key returned by the app, asks for a recipient and never takes that recipient from a URL.
- It requests a purpose-02 signature and permits submission from any wallet. Page state survives the app callback in `localStorage`.
- In `web/`, dependency installation, `pnpm test` and `pnpm build` succeed; run a separate typecheck if available.
- Independently recompute the golden-vector digest and signer. Verify that the tests compare against the vector, not against the same implementation used to construct the actual value.
- Check callback parsing and state mismatch, recipient validation, recipient/signature/call consistency, chain and contract settings, and calldata encoding.
- Check eligibility and proof loading, the relationship between callback key and proof address, missing-proof and wrong-chain behavior, and safe handling of externally supplied text in the DOM.
- Check that browser storage contains no private signing material and that no confidential information is committed.

## Report

Report the revision, verdict, severity, file/line, concrete failure scenarios and evidence type. Include command results and unverified behavior. Do not send transactions or operate real devices.
