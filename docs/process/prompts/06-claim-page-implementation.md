# Claim page implementation

Sanitized implementation prompt. The [shared constraints](../README.md#shared-constraints-from-the-prompts) apply.

## Task

Build a static page under Mizar `web/` with TypeScript, Vite and viem. Follow the Pages section of `docs/design/spec.md` and the contract ABI.

Ask for a recipient address and obtain a purpose-02 signature through the app link. Its body contains the 32-byte chain ID, 20-byte claim-contract address and 20-byte recipient. Read the app callback fields `sig`, `k`, `a` and `st`; show eligibility for that event-key address from `eligible.json` and the corresponding proof file. Submit `claim(snapshotId, eventKeyAddress, proof, recipient, appSignature)` from an injected wallet, which need not be the event key.

Never obtain the recipient from the page URL. Preserve state in `localStorage` because the app callback may open another tab. Display the complete recipient address in groups of four. Put event, chain, contract and published-output settings in a small configuration file with clearly fake examples.

## Acceptance criteria

From `web/`, dependency installation, `pnpm build` and `pnpm test` succeed. Unit tests must verify:

- Exact purpose-02 link-body bytes against the shared golden vector.
- Callback parsing and rejection of mismatched `st`.
- Contract call encoding against the golden vector and recovery of the expected event-key signer.

The subsequent review rounds refine this flow: the claim page must learn the key from the purpose-02 callback, never a purpose-01 request, and must consume the actual evaluator output shapes.
