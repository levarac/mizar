# Implementation spec (hackathon build)

This spec turns decisions D5–D10 in [decisions.md](decisions.md) into interfaces. Where it conflicts with decisions.md, decisions.md explains why and this file says what to build. Parameter values marked *demo* may change.

## Components

| Component | Repository path | Language | Role |
|---|---|---|---|
| Claim contract | `mizar/contracts/` | Solidity 0.8.28, Foundry | stores posted roots, verifies claims, issues EAS attestations |
| Evaluator | `mizar/evaluator/` | TypeScript, Node 22 | reads public evidence, applies the rule, builds roots and manifests, verifies them |
| Human-check service | `alcor/worker/` | TypeScript, Cloudflare Worker | issues challenges, verifies World ID, records credentialed event keys |
| Pages | `alcor/web/`, `mizar/web/` | static HTML + TypeScript | join-time check page, claim page |

The app-side signing entry point is built in the existing app on a separate branch. Its request format is fixed below, because the contract and the pages depend on it.

## Shared formats

**Event ID.** The 32-byte registry event ID, the same value as an observation's `context`. The demo event is `0x996ab4d7cd0785199b715e6ff004f41ef740ead3b3363602ce1cb14b812d1f94`, valid 2026-09-25 09:00 to 2026-09-27 09:00 JST.

**Event key address.** Take the observer's 33-byte compressed secp256k1 key, decompress it, then compute `keccak256(uncompressed[1..65])[12..32]`.

**App signature.** The app signs `digest = SHA256(M)`, where M is built as follows.

- Byte layout: `M = 0xFF ‖ "beid/event-key-sign/v1" ‖ 0x00 ‖ purpose ‖ eventId ‖ body`.
- Encoding: all integers are big-endian, all fields are fixed-length, and there are no length prefixes.
- Purpose `0x01` (human-check binding): `body = challenge` (32 bytes, issued by the human-check service).
- Purpose `0x02` (claim): `body = chainId (uint256) ‖ claimContract (address) ‖ recipient (address)`.
- Signature: 65 bytes, `r ‖ s ‖ v` with v = 27 or 28, low-S.
- In Solidity this equals `sha256(abi.encodePacked(bytes1(0xff), "beid/event-key-sign/v1", bytes1(0x00), uint8(purpose), eventId, ...body))`.

**Evaluation parameters** (fixed and published before a snapshot is taken):

```json
{ "evaluatorVersion": "mizar-eval/1", "eventId": "0x…", "chainId": 11155111,
  "minPartners": 2, "minWindowsPerPartner": 2, "credentialsSource": "<alcor list URL>",
  "snapshot": { "id": 1, "cutoffBlock": 0 } }
```

*Demo* values: `minPartners` N = 2; `minWindowsPerPartner` B = 2, with B = 1 kept as a fallback.

**Credential list** (published by the human-check service): one entry per credentialed event key. Each entry holds:

- `eventKey`: 33-byte hex
- `eventKeyAddress`
- `nullifierHash`
- `verifiedAt`
- `challenge`
- `appSignature`: the purpose `0x01` signature
- `proofDigest`: sha256 of the World proof bundle
- `attestation`: the service's own signature over the entry

The list carries no wallets. Only the first-verified key per nullifier counts (first by `verifiedAt`), so the list only grows.

## Evaluation rule (evaluator)

Input: the verification-envelope pages for the event, restricted to observations whose commitment is anchored at or before `cutoffBlock`, plus the credential list as of that block's timestamp.

1. Verify each observation's signature, context equality with the event ID, and Merkle inclusion. Drop and count the failures by reason.
2. Derive reciprocal relations exactly as the evidence layer's mutual derivation does: group by (eventId, definitionDigest, enin), dedupe by observation digest, union the observed RPIDs per reporter RPID, and keep A–B only when each heard the other in the same enin.
3. Map each reporter RPID to the event key that signed it as its own subject. Drop any RPID that more than one key claims as its own. Record every drop.
4. Collapse relations to key pairs, keeping the set of distinct enins for each pair.
5. A key is eligible when it is credentialed and has at least N distinct credentialed partner keys, each with at least B distinct enins. There is no iterative removal.
6. Leaves: the OpenZeppelin standard Merkle tree over `[address eventKeyAddress]`, sorted by address. The root is the tree root.

Output directory:

- `manifest.json`: the parameters, the digests of all inputs (observation digests, credential list digest, anchor range), the evaluator version and the root
- `eligible.json`: the sorted addresses plus a per-key explanation (partners and windows)
- `rejected.json`: each non-eligible credentialed key with a reason code (`too_few_partners`, `too_few_windows`, `rpid_conflict`, `not_credentialed`)
- `proofs/<address>.json`: the Merkle proof for each eligible key

CLI:

- `mizar evaluate --params p.json --out dir/`
- `mizar verify --manifest <path|url> [--rpc <url> --contract <addr>]` prints a receipt: `{"result":"PASS"}`, `{"result":"FAIL","fault":"root_mismatch|invalid_signature|threshold_miscalculation"}`, or `{"result":"UNAVAILABLE","reason":…}`. It recomputes from the inputs and compares the result with the on-chain root for that snapshot.
- `mizar progress --params p.json --key <addr>` reads not-yet-anchored evidence and prints provisional progress. It is never used for claims.

Evidence and the rule are reimplemented in this repository from the public specification of the evidence layer. Any logic ported from the pre-existing reference code is marked in the file header as ported.

## Claim contract

```solidity
constructor(IEAS eas, bytes32 schemaUid, bytes32 eventId, address poster)
function postRoot(uint64 snapshotId, bytes32 root, bytes32 manifestDigest, uint64 cutoffBlock) external; // onlyPoster, snapshotId strictly increasing
function claim(uint64 snapshotId, address eventKeyAddress, bytes32[] calldata proof,
               address recipient, bytes calldata appSignature) external returns (bytes32 uid);
event RootPosted(uint64 indexed snapshotId, bytes32 root, bytes32 manifestDigest, uint64 cutoffBlock);
event Claimed(address indexed eventKeyAddress, address indexed recipient, uint64 snapshotId, bytes32 uid);
```

`claim` performs these steps in order:

1. Require that the snapshot root exists.
2. Verify the proof for the leaf of `eventKeyAddress` against that root.
3. Rebuild the purpose `0x02` digest with `block.chainid` and `address(this)`, and require that `ECDSA.recover(digest, appSignature) == eventKeyAddress`.
4. Require `!spent[eventKeyAddress]`, then mark it spent. The contract is per event, so this is the `(eventId, eventKeyAddress)` spent mark.
5. Call `eas.attest` with the fixed schema:
   - `recipient`
   - `revocable: false`
   - `expirationTime: 0`
   - `refUID: 0`
   - `value: 0`
   - `data: abi.encode(eventId, eventKeyAddress, snapshotId, manifestDigest)`

EAS schema, registered once with no resolver and `revocable = false`: `bytes32 eventId, address eventKey, uint64 snapshotId, bytes32 manifestDigest`.

Sepolia EAS `0xC2679fBD37d54388Ce493F1DB75320D236e1815e`; SchemaRegistry `0x0a7E2Ff54e76B8E6659aedc9103FB21c038050D0` (re-read the bytecode before deploying).

For the hackathon build, `poster` is a deployer-set address. Deriving it from the event's registered authority is the follow-up recorded in D7.

Tests (Foundry):

- a valid claim issues an attestation to the recipient
- a wrong recipient in the signature, a wrong chain or contract, a bad proof, a second claim, an unknown snapshot, and a non-poster `postRoot` each revert
- a high-S signature reverts
- a golden vector shared with the evaluator and the app codec produces the same digest

## Human-check service

- `POST /challenge {eventId}` returns `{challenge, expiresAt}`. The challenge is random, single-use and valid for 10 minutes.
- `POST /bind {eventId, eventKey, challenge, appSignature}` verifies the purpose `0x01` signature and returns `{signal}`. The signal is `hashToField(keccak256(eventId ‖ eventKeyAddress ‖ challenge))`, following IDKit's signal rules.
- `POST /verify {eventId, eventKey, idkitResult}` forwards the IDKit result to World's verify endpoint for this app's `rp_id` and action `mizar-<eventId prefix>`. It checks the signal, enforces one key per nullifier, stores the credential entry and signs it.
- `GET /credentials?eventId=` returns the published credential list, including proof digests.

Configuration comes from environment bindings: `WORLD_APP_ID`, `WORLD_RP_ID`, `WORLD_ACTION`, `WORLD_ENV=staging|production`, a signing key for attestations, and D1 storage. The World Developer Portal registration is done by a maintainer. Until then, tests use recorded fixtures and the staging simulator.

## Pages

- **Join-time check page**, on the human-check service's origin:
  1. Get a challenge.
  2. Open the app link `beid://event-key-sign?v=1&p=01&e=<eventId>&b=<challenge>&st=<state>`.
  3. Receive the callback fragment (`sig`, `k`, `a`, `st`).
  4. `/bind`.
  5. IDKit.
  6. `/verify`.

  Keep state in `localStorage`, because the callback may open a new tab.
- **Claim page**, on Mizar's origin:
  1. Show progress and eligibility for the key address returned by the app.
  2. Ask for a recipient.
  3. Open `…&p=02&b=<chainId‖contract‖recipient>`.
  4. Receive the signature.
  5. Submit `claim` from any wallet.

  Never read `recipient` from the page's own URL.

## Out of scope

The items listed at the end of decisions.md are out of scope.
