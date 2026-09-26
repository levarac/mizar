# Mizar evaluator

Node 22+, pnpm, TypeScript. All checked-in private keys are derived from public
labels and are **test vectors only**.

```sh
cd evaluator
pnpm install
pnpm test
pnpm typecheck
pnpm mizar evaluate --params test/fixtures/params.json --out /tmp/mizar-out
pnpm mizar verify --manifest /tmp/mizar-out/manifest.json
pnpm mizar progress --params test/fixtures/params.json --key <event-key-address>
```

The fixture generator is `pnpm fixtures`. It writes signed COSE observations,
a signed commitment and inclusion receipts, a pinned-key Alcor credential
list, and a synthetic pending-feed marker. It also writes
`test/fixtures/merkle-3-address.json` for the contract's address-only leaf
check. The separate `alcor-signed-credentials-v1.json` is the exact public
producer fixture from Alcor commit `448ab64`.

## Parameters and inputs

`evidenceSource` is a local JSON file containing verification-envelope pages,
or an HTTPS URL ending in `/v1/events/<event-id>/verification`. HTTPS fetching
follows both commitment and observation cursors and uses GET only.
`credentialsSource` is the Alcor `{eventId,credentials}` JSON. The Ed25519
`credentialsPublicKey` is pinned in the parameters; the key supplied in each
credential is checked against it. The evaluator verifies the Alcor signature,
the purpose-01 event-key signature, and the key-to-address mapping.

Local fixture runs set `anchorBlocksSource` to a digest-to-block JSON map and
`snapshot.cutoffTimestamp` to a fixture time. For an HTTPS evidence source,
`eventRegistry`, `definitionRegistry`, `commitmentRegistry`, and an RPC endpoint
are required. Pass the endpoint with `--rpc env:SEPOLIA_RPC_URL`, using a
command-scoped environment variable, so it never appears in command arguments
or the archive. An existing `rpcUrl` parameter is still accepted but is removed
from archived parameters. RPC failure messages omit provider details that could
contain credentials. The evaluator checks all three registry
event records, maps commitment digests to the blocks of their registry events,
and reads the cutoff block timestamp. If any mapping is unavailable, it
returns `UNAVAILABLE` and does not settle a root. It archives the fetched
inputs and derived mapping under the output directory for offline replay.

```sh
pnpm mizar evaluate --params live-params.json --out /tmp/mizar-live \
  --rpc env:SEPOLIA_RPC_URL --from-block <earliest-registry-deployment-block>
```

`--from-block` applies to registration, definition and commitment log reads.
Choose a lower bound that includes all relevant events from all three registries.
Only commitments recorded by the event's registered operator can supply the
mapping. A missing matching event remains `UNAVAILABLE`; timestamps and sequence
numbers are never used to estimate a block. Commitments after the cutoff are
mapped but excluded from that snapshot's eligibility calculation. The archived
mapping is checked again by an independent `verify --rpc` run.

`verify` recomputes the root and the sorted eligibility, rejection, and proof
outputs from the archived inputs. Observation bytes that do not hash to their
committed digest make the archive invalid (`invalid_signature`). Without
`--rpc` it compares with the manifest root only; every input, including the
parameters, the anchor-to-block sidecar and the credential list, is then taken
from the archive as the poster wrote it. With `--rpc` and `--contract` it checks
the snapshot against sources the verifier chooses:

```sh
pnpm mizar verify --manifest dir/manifest.json --rpc env:SEPOLIA_RPC_URL --contract <claim> \
  --trusted-params <published params.json> [--trusted-params-sha256 <hex>] \
  --chain-id 11155111 [--from-block <n>] \
  --event-registry <addr> --definition-registry <addr> --commitment-registry <addr> \
  [--credentials-source <Alcor list URL or file>]
```

The parameters file inside the archive is written by the poster, so every
trust anchor comes from these flags instead. This repository does not pin the
evidence layer's Sepolia registry addresses, so without the flags an on-chain
verify returns `UNAVAILABLE`.

- `inputs/params.json` in the archive is written by the poster and is never a
  trust anchor. `--trusted-params` must be the parameters file published before
  the snapshot, obtained from outside the archive. A path inside the manifest's
  directory, or any URL on a remote manifest's origin, is refused with
  `UNAVAILABLE`. This guard only catches the mistake; a copy of the poster's
  file kept elsewhere passes it. **Pending:** where the
  organizer publishes these parameters, and a poster-independent digest to pin
  them, are not decided yet. Until then `--trusted-params-sha256` lets the
  verifier check its copy against a digest obtained out of band; a mismatch is
  `UNAVAILABLE`, because it means the verifier's own copy is wrong.
- The trusted parameters' `chainId` must equal `--chain-id`, or the result is
  `UNAVAILABLE`. Their
  `evaluatorVersion`, `eventId`, `chainId`, `minPartners`,
  `minWindowsPerPartner`, `credentialsPublicKey`, `snapshot.id` and
  `snapshot.cutoffBlock` must equal the archived parameters; a difference is a
  `FAIL`, a missing field is `UNAVAILABLE`.
- Registry addresses in the archived parameters are cross-checked against the
  registry flags; a difference is a `FAIL`. An RPC serving another chain is
  `UNAVAILABLE`.
- The credential list is re-read from `--credentials-source`, or from the
  trusted parameters' `credentialsSource`. Every entry that verifies and was
  verified by the cutoff must be in the archived list; an omission is a `FAIL`,
  an unreachable list is `UNAVAILABLE`. The list only grows, so later entries
  are ignored.
- Commitment logs count only when their recorder is the operator registered for
  the event. This assumes the registry records each event's commitments from
  that operator alone; logs from any other recorder are ignored.
- The event registration must match, and the admission must carry the latest
  definition anchored by the cutoff. Every commitment is mapped to its registry
  block, every commitment anchored at or before the cutoff must be in the
  inputs, and the cutoff block timestamp must match.
- Finally the claim contract's `RootPosted` event must match the root, the
  cutoff block, and the SHA-256 of the exact written manifest bytes. The
  contract's snapshots are private, so the event is the public read surface.

Log reads start at `--from-block` (default 0). Use the commitment registry's
deployment block. A later block, such as the event's registration block, is
safe only if the registry refuses commitments recorded before registration;
otherwise it can hide an omitted commitment. A range the RPC rejects as too wide or too large
is split in half down to 100 blocks; any other RPC error, or more than 500
`eth_getLogs` calls, is `UNAVAILABLE`. Only failures of sources the verifier
chose (the manifest fetch, the RPC, the trusted parameters and credential list)
are `UNAVAILABLE`. Archive content is the poster's responsibility: a missing or
unparsable input or output file is a `FAIL`, and output files are read only
after the root and on-chain checks. The automated suite uses a local JSON-RPC
stub, including live evaluation without a supplied mapping, missing or foreign
commitments, cutoff exclusion, range splitting and the call cap.
The live evaluation path has been tested only against that JSON-RPC stub.
No live Sepolia evaluation has been run yet because the operator's evidence
endpoint was unavailable.

Future work: the credential omission check trusts whatever list the verifier
fetches. A list head signed by Alcor (entry count plus digest per cutoff) would
let an archive prove completeness on its own.

The public verification-envelope API currently returns `bundle: null`. It
cannot expose bundled delegation certificates or support recomputation of the
bundle digest. Under design decision D11, Mizar verifies each signed
Observation's inclusion in the signed and anchored commitment root, and
requires the Observation's own signer key for its event-key mapping. It does
not claim to verify delegated provenance from these pages.

`progress` requires an explicit `pendingSource` parameter or
`--pending <source>`. The only supported pending input today is the labeled
synthetic fixture marker. Without a pending source, or for an undefined live
pending-feed format, it returns `UNAVAILABLE`. Its output is always
provisional and cannot be used as a claim proof.

The Alcor attestation is a trusted statement that its World verification
passed. Mizar verifies the statement's signature and event-key binding; it
does not independently re-run World ID verification.
