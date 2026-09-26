# Demo parameters

The event-level baseline is [`params-0xccb8770a.json`](params-0xccb8770a.json).
Its SHA-256, covering the exact UTF-8 file bytes including the final newline, is:

```text
1d216f7c0d1e6d5006c019c1a218c82421bf3f1e17065aae1981d058dbd01f08
```

This file fixes the demo event, Sepolia chain, N=2/B=2 rule, Alcor signing public
key, public input locations, and registry addresses. The thresholds are Mizar
parameters from the [specification](../design/spec.md#shared-formats), not fields
derived from the registered event definition. No RPC credential is included.

**This baseline is not a complete `--trusted-params` file.** It intentionally has
no `snapshot`: no final snapshot ID or cutoff is published here, and no rehearsal
values are presented as a release. Each snapshot needs its own complete file and
digest before evaluation and root posting. There are no CLI flags that supply
missing trusted snapshot fields.

## What the verifier checks

The [CLI](../../evaluator/src/cli.ts) hashes the **entire supplied file**, not a
selected subset of JSON fields. Formatting, URLs, optional fields, and snapshot
values all affect `--trusted-params-sha256`. Do not reformat a pinned file.

After the digest check, the CLI compares `evaluatorVersion`, `eventId`, `chainId`,
`minPartners`, `minWindowsPerPartner`, `credentialsPublicKey`, `snapshot.id`, and
`snapshot.cutoffBlock` with the archive. Missing required fields yield
`UNAVAILABLE`; changed rule fields yield `FAIL`. A wrong supplied digest also
yields `UNAVAILABLE`, never `PASS`.

The [Parameters type](../../evaluator/src/evaluate.ts) includes
`snapshot.cutoffTimestamp` too. Live evaluation derives it from the selected RPC
block; live verification checks the archived timestamp against that block.
Registry addresses and credential completeness are checked using the verifier's
explicit trusted flags and credential source. File-location separation alone
does not establish trustworthy provenance.

## Publish each snapshot's complete parameters

Use this path pattern, without overwriting a published snapshot:

```text
docs/demo/snapshots/0xccb8770a/<snapshotId>/params.json
docs/demo/snapshots/0xccb8770a/<snapshotId>/README.md
```

Before evaluating a publishable snapshot, independently review the baseline,
choose an unused increasing snapshot ID, and read the cutoff block and timestamp
from Sepolia. Confirm the public evidence API serves all commitments through the
cutoff and terminates cleanly. Preserve all baseline fields and add the snapshot
object. From the repository root:

```sh
node --input-type=module - '<SNAPSHOT_ID>' '<CUTOFF_BLOCK>' '<CUTOFF_TIMESTAMP>' <<'JS'
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
const [id, cutoffBlock, cutoffTimestamp] = process.argv.slice(2).map(Number);
if (![id, cutoffBlock, cutoffTimestamp].every(Number.isSafeInteger) ||
    id < 0 || cutoffBlock < 1 || cutoffTimestamp < 1) {
  throw new Error('Supply the reviewed numeric snapshot ID, cutoff block and timestamp');
}
const baseline = JSON.parse(readFileSync('docs/demo/params-0xccb8770a.json', 'utf8'));
const directory = `docs/demo/snapshots/0xccb8770a/${id}`;
mkdirSync(directory, { recursive: true });
writeFileSync(`${directory}/params.json`, JSON.stringify({
  ...baseline, snapshot: { id, cutoffBlock, cutoffTimestamp }
}, null, 2) + '\n', { flag: 'wx' });
JS
shasum -a 256 'docs/demo/snapshots/0xccb8770a/<SNAPSHOT_ID>/params.json'
```

The complete file must equal the baseline plus **only** `snapshot.id`,
`snapshot.cutoffBlock`, and `snapshot.cutoffTimestamp`. From the repository root,
this check prints `true` and exits 0 only when that relation holds:

```sh
jq -e --slurpfile baseline docs/demo/params-0xccb8770a.json 'del(.snapshot) == $baseline[0] and (.snapshot | keys == ["cutoffBlock", "cutoffTimestamp", "id"])' 'docs/demo/snapshots/0xccb8770a/<SNAPSHOT_ID>/params.json'
```

Record that complete file's own digest and this baseline's digest in the adjacent
README. Review and merge the parameters before evaluating the publishable
snapshot and before `postRoot`. Pin the full commit containing those exact bytes:

```text
https://raw.githubusercontent.com/levarac/mizar/<PARAMS_COMMIT>/docs/demo/snapshots/0xccb8770a/<snapshotId>/params.json
```

Use the same reviewed bytes for evaluation. Never substitute the baseline digest
for the complete file's digest. Any change to the rule, cutoff, or snapshot ID
requires a newly reviewed file and digest; do not copy trusted parameters out of
the snapshot archive. The verifier must obtain the agreed commit and digest
independently of that archive, rather than trusting whichever values its poster
supplies. A mutable branch URL is not a commit pin.

## Verify a posted snapshot

A verifier passes the complete per-snapshot file or its pinned URL to
`verify --rpc --trusted-params` and that file's own exact-byte digest to
`--trusted-params-sha256`. From `evaluator/`, after the matching root is posted:

```sh
SEPOLIA_RPC_URL=https://ethereum-sepolia-rpc.publicnode.com pnpm mizar verify \
  --manifest '<MANIFEST_PATH_OR_URL>' --rpc env:SEPOLIA_RPC_URL \
  --contract 0xC54b23Ce524ea22D41A65c2EfceEc5e483f2F0fC \
  --trusted-params '<INDEPENDENT_COMPLETE_PARAMS_PATH_OR_PINNED_URL>' \
  --trusted-params-sha256 '<COMPLETE_PARAMS_SHA256>' \
  --chain-id 11155111 --from-block 11783962 --min-log-span 10 --max-log-calls 500 \
  --event-registry 0x1284a559Ce2e4Ba7551a87A4fB66F34dcF9b0170 \
  --definition-registry 0x1f2Eb14790f1108a3E54D8EB3f65B89ad08Ec400 \
  --commitment-registry 0x3F2DF5669Ce59705e974fe44dD73CC32f57Ed1C9 \
  --credentials-source 'https://alcor-human-check.levarac.workers.dev/credentials?eventId=0xccb8770a524f4145e04b3c97d8ffe2f7301ce65b4041d80e419bafdd803b2ee1'
```

The trusted file must be outside the local archive; for a remote manifest its
origin must differ from the trusted-parameters URL. Require `PASS` and exit 0.
Missing `RootPosted` evidence cannot produce a successful chain verification.
See the [evaluator README](../../evaluator/README.md) for archive and RPC checks.
