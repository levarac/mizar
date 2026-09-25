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

## Deployment commands (not run)

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
