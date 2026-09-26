# Mizar claim contract

Foundry project for the event-specific claim contract in `../docs/design/spec.md`.

## Build and test

```sh
cd contracts
forge build
forge test -vv
```

The Sepolia fork test calls `vm.skip` when `SEPOLIA_RPC_URL` is unset. To run it, set that variable to a Sepolia RPC URL and run `forge test -vv`. The fork test registers the exact schema and makes an attestation only in Foundry's local fork; it does not broadcast either transaction.

`test/fixtures/merkle-3-address.json` is a copy of the evaluator's deterministic fixture generated with `@openzeppelin/merkle-tree` 1.0.8. The claim test uses its exact root and all three proofs, signing with public deterministic test keys derived from the fixture labels `A`, `B`, and `C`.

The eligible leaf uses OpenZeppelin StandardMerkleTree's single-address encoding: `keccak256(bytes.concat(keccak256(abi.encode(eventKeyAddress))))`. Each event key can claim once across all snapshots. The root and manifest are recorded by `RootPosted`; only the configured poster can post roots.

## Dependencies

The following MIT-licensed upstream Solidity files are vendored unchanged, so a fresh checkout builds without a dependency download:

- OpenZeppelin Contracts `v5.4.0`, commit `c64a1edb67b6e3f4a15cca8909c9482ad33a02b0`: `ECDSA.sol`, `Hashes.sol`, `MerkleProof.sol` under `src/vendor/openzeppelin/utils/cryptography/`.
- Ethereum Attestation Service contracts `v1.4.0`, commit `d223e17208aa110dd5ec694d77324a2321d93201`: `IEAS.sol`, `ISchemaRegistry.sol`, `ISemver.sol`, `Common.sol`, `resolver/ISchemaResolver.sol` under `src/vendor/eas/`.

## Sepolia deployment

MizarClaim was deployed on Sepolia (chain ID `11155111`) from source commit [5302c488817804ec49588b0fdbcdb4dbbcaaf51a](https://github.com/levarac/mizar/commit/5302c488817804ec49588b0fdbcdb4dbbcaaf51a).

| Item | Deployment record |
| --- | --- |
| MizarClaim | [0xC54b23Ce524ea22D41A65c2EfceEc5e483f2F0fC](https://sepolia.etherscan.io/address/0xC54b23Ce524ea22D41A65c2EfceEc5e483f2F0fC) |
| Deployment transaction | [0x07fb7bb34a975de97b17ed5f044aff5450273e35b9c41eadbf1686e0f12c4324](https://sepolia.etherscan.io/tx/0x07fb7bb34a975de97b17ed5f044aff5450273e35b9c41eadbf1686e0f12c4324) |
| Deployment block | [11784009](https://sepolia.etherscan.io/block/11784009) |
| Source verification | [Sourcify](https://repo.sourcify.dev/11155111/0xC54b23Ce524ea22D41A65c2EfceEc5e483f2F0fC): `exact_match` for creation and runtime bytecode |
| EAS schema UID | `0x858edbfff167feaa82c4bb29f3ce4a62ed06024ccdd8377f4f0b26619ccd65d3` |
| Schema registration transaction | [0xfcf78e48a623790e3d285dca2187acdd6bc99581308978d1c5d6054324c3b30b](https://sepolia.etherscan.io/tx/0xfcf78e48a623790e3d285dca2187acdd6bc99581308978d1c5d6054324c3b30b) |
| Schema resolver / revocability | No resolver (`0x0000000000000000000000000000000000000000`); non-revocable |
| Event ID | `0xccb8770a524f4145e04b3c97d8ffe2f7301ce65b4041d80e419bafdd803b2ee1` |
| Root poster / event registrar | [0xdf6986bbadd189309d52d437851c10e47ca02e20](https://sepolia.etherscan.io/address/0xdf6986bbadd189309d52d437851c10e47ca02e20) |
| Event registration transaction | [0x72b70349f03dc5bf004c52c0b9c524643209e0ea7625bdfa7716dd07bbe69f4b](https://sepolia.etherscan.io/tx/0x72b70349f03dc5bf004c52c0b9c524643209e0ea7625bdfa7716dd07bbe69f4b) |

The schema is `bytes32 eventId, address eventKey, uint64 snapshotId, bytes32 manifestDigest`. The constructor's poster was set to the event registrar; the contract does not derive or update that address from the event registry. Contract deployment and schema registration do not establish a posted eligibility root, a successful claim, or a working live join-to-claim flow.

## Deployment commands

The scripts below are the deployment entry points. This documentation update records the deployment above and did not broadcast either script.

Set all values in the shell environment. Do not put signing keys in files or pass a key as a command-line argument. Confirm the Sepolia EAS and SchemaRegistry addresses have code and match the intended deployments before broadcasting.

```sh
cd contracts
export SEPOLIA_RPC_URL='<Sepolia RPC URL>'
export DEPLOYER_PRIVATE_KEY='<deployer private key>'
export SCHEMA_REGISTRY_ADDRESS='0x0a7E2Ff54e76B8E6659aedc9103FB21c038050D0'
forge script script/RegisterSchema.s.sol:RegisterSchema --rpc-url "$SEPOLIA_RPC_URL" --broadcast
```

Read the `Registered` event in the broadcast receipt to obtain the schema UID. The schema is `bytes32 eventId, address eventKey, uint64 snapshotId, bytes32 manifestDigest`, with no resolver and `revocable = false`.

```sh
cd contracts
export SEPOLIA_RPC_URL='<Sepolia RPC URL>'
export DEPLOYER_PRIVATE_KEY='<deployer private key>'
export EAS_ADDRESS='0xC2679fBD37d54388Ce493F1DB75320D236e1815e'
export SCHEMA_UID='<UID from Registered event>'
export EVENT_ID='<32-byte registry event ID>'
export POSTER_ADDRESS='<poster address>'
forge script script/Deploy.s.sol:Deploy --rpc-url "$SEPOLIA_RPC_URL" --broadcast
```

`postRoot` is a separate call by `POSTER_ADDRESS`; these scripts neither post a root nor issue a claim. Clear `DEPLOYER_PRIVATE_KEY` from the environment after use.
