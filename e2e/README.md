# End-to-end fixture run

`pnpm e2e` runs the whole fixture pipeline on a local anvil chain: evaluate,
post a root, claim, and check the attestation.

## Requirements

- Node.js >= 20 and pnpm
- Foundry (`forge`, `anvil`) on `PATH`

## Run

```sh
pnpm install
pnpm e2e
```

`E2E_ANVIL_PORT` overrides the anvil port (by default a free port is picked).

## What the script does

1. `forge build` in `../contracts`, then reads the `MizarClaim` and `MockEAS`
   artifacts from `contracts/out/`.
2. `pnpm mizar evaluate --params test/fixtures/params.json --out <tmpdir>` in
   `../evaluator`, the real evaluator CLI, on the checked-in fixture inputs.
3. Starts `anvil --chain-id 11155111` (the fixture's `params.chainId`) and mines
   past the fixture cutoff block, because the on-chain check reads the
   `RootPosted` log from `cutoffBlock` onward.
4. Deploys `MockEAS` from a separate account, then deploys `MizarClaim` as
   anvil account 0's first transaction so it lands at
   `0x5FbDB2315678afecb367f032d93F642f64180aa3`, the `claimContract` in the
   golden vector (`docs/design/test-vectors/app-signature-v1.json`).
5. Posts the evaluator's root with `postRoot` from a poster account:
   `snapshotId` and `cutoffBlock` come from the fixture params and
   `manifestDigest` is `SHA256` of the exact `manifest.json` bytes the CLI wrote.
6. Claims for one eligible event key using `proofs/<address>.json` and a
   purpose `0x02` signature made with that key's deterministic fixture key
   (`SHA256("Mizar public deterministic TEST KEY: " + label)`, see
   `evaluator/test/fixtures/generate.ts`), submitted by an unrelated wallet.
7. Asserts:
   - `MockEAS` recorded exactly one attestation to the recipient with
     `data = abi.encode(eventId, eventKeyAddress, snapshotId, manifestDigest)`;
   - a second claim for the same event key reverts `AlreadyClaimed`, mined;
   - a claim with a different recipient reverts `InvalidSigner`, mined;
   - the signing codec reproduces the golden vector's digest and signature
     byte for byte (the golden key is not in the evaluator's eligible set, so
     it cannot claim against the evaluator root);
   - `mizar verify --manifest <out>/manifest.json` (offline) prints
     `{"result":"PASS"}`;
   - the `RootPosted` log on anvil carries the manifest root, the `SHA256` of
     the `manifest.json` bytes, and the params cutoff block. The evaluator's
     `verify --rpc` check is `UNAVAILABLE` for fixture params (no registry
     addresses), so the script performs the same log comparison itself.

Everything runs against the local chain only; no Sepolia or other live
network is touched.
