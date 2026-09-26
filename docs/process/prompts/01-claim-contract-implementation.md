# Claim contract implementation

Sanitized implementation prompt. The [shared constraints](../README.md#shared-constraints-from-the-prompts) apply.

## Task

Build the claim contract under `contracts/` according to the Claim contract section of `docs/design/spec.md`. Use Foundry, Solidity 0.8.28, OpenZeppelin MerkleProof and ECDSA, and pinned EAS interfaces. Read the design decisions and shared app-signature golden vector first.

Implement snapshot posting, event-key Merkle membership, purpose-02 recipient authorization, one claim per event key across snapshots, and EAS attestation issuance with the specified schema and data. Preserve the external interface in the specification.

## Acceptance criteria

- `forge build` and `forge test -vv` succeed from `contracts/`.
- Cover every Foundry case listed in the specification, including the shared golden vector, wrong recipient, wrong chain or contract, invalid proof, duplicate claim, unknown snapshot, non-poster posting and high-S signature rejection.
- Use MockEAS for unit tests. Provide an optional Sepolia EAS fork test that skips when `SEPOLIA_RPC_URL` is absent; this is a local fork, not a broadcast.
- For the golden vector, make the contract-under-test address agree with the vector, or construct an additional explicitly labeled test vector for its deterministic address.
- Provide `script/Deploy.s.sol` and `script/RegisterSchema.s.sol` without running them. Document their invocation and environment-based configuration in `contracts/README.md`; do not write signing material into files.

## Delivery evidence

Report the exact revision, build/test commands, exit codes, test counts, contract interface, remaining work and any specification ambiguity. Disclose any logic ported from the pre-existing evidence-layer reference.
