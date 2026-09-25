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
`rpcUrl`, `eventRegistry`, `definitionRegistry`, and
`commitmentRegistry` are required. The evaluator checks all three registry
event records, maps commitment digests to the blocks of their registry events,
and reads the cutoff block timestamp. If any mapping is unavailable, it
returns `UNAVAILABLE` and does not settle a root. It archives the fetched
inputs and derived mapping under the output directory for offline replay.

`verify` recomputes the root and the sorted eligibility, rejection, and proof
outputs from the archived inputs. Without `--rpc` it compares with the
manifest root. With both `--rpc` and `--contract` it also checks the claim
contract's `RootPosted` event; for a live-origin manifest it rechecks the
registry mappings. The contract's snapshots are private, so the event is the
public read surface. The on-chain manifest digest encoding is not yet pinned
by the design spec and is not compared.

`progress` requires an explicit `pendingSource` parameter or
`--pending <source>`. The only supported pending input today is the labeled
synthetic fixture marker. Without a pending source, or for an undefined live
pending-feed format, it returns `UNAVAILABLE`. Its output is always
provisional and cannot be used as a claim proof.

The Alcor attestation is a trusted statement that its World verification
passed. Mizar verifies the statement's signature and event-key binding; it
does not independently re-run World ID verification.
