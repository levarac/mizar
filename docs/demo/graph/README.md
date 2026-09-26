# Evaluation graph replay

A static, self-contained presentation of recorded event-key observations. No
backend, CDN, wallet, RPC client or live updates. The page uses local Inter
font assets from `web/public/fonts` (OFL license included in the build).

From the repository root, with the evaluator dependencies installed:

```sh
cd evaluator
pnpm install --ignore-workspace
cd ../docs/demo/graph
pnpm install --ignore-workspace
node build.mjs
node serve.mjs
```

Open `http://127.0.0.1:4178`. The build writes `dist/`, including the comparison
`graph.json`, a `default-graph.json`, scripts, styles and fonts. Any static HTTP
server can serve this directory. No deployment is part of this workflow.
Use **Load graph.json** to inspect another local export, or replace
`dist/graph.json`. Play, Pause, Step, Reset and the slot slider replay the
exported frames. Select a node to see its full event-key address.

## Export recorded data

Run from `evaluator/`:

```sh
node_modules/.bin/tsx src/cli.ts graph \
  --params test/fixtures/comparison/params.json --out /tmp/comparison-graph
node_modules/.bin/tsx src/cli.ts graph \
  --params test/fixtures/params.json --out /tmp/default-graph
node_modules/.bin/tsx src/cli.ts graph \
  --snapshot /path/to/evaluation-output --out /tmp/snapshot-graph
```

Choose a new or empty output directory. Each command writes **only graph.json**.
The snapshot form reads the fixed local `inputs/params.json`,
`inputs/envelopes.json`, `inputs/credentials.json`, `inputs/anchor-blocks.json`,
`eligible.json` and `rejected.json`. It recomputes and compares the latter two
files before export. Remote source hints retained inside archived parameters
are ignored; no URL is fetched. The params form rejects remote sources. Both
forms reject RPC settings and unsupported flags.

`graph.json` is explicitly **NON-CANONICAL**. It contains no root, manifest,
proof, signatures or credential secrets. It is not a verification receipt and
is not consumed by canonical evaluation or verification. A recorded snapshot
is not independently checked against a chain. Provenance is declared, not
independently established. Do not treat a PASS chip as proof of physical presence.

The exporter calls `verifyEvidence`, `verifyCredentials`, `deriveRelations`
and `evaluateRule`; the browser does not implement the rule. All credentials
are fixed at the snapshot cutoff. Each replay frame evaluates the verified
observation prefix through that window index, including the evaluator's RPID
conflict filtering. Relations and status can therefore change when later
conflicting observations arrive. Empty windows between the first and last
observations are retained. Export is bounded to 4,096 slots. The displayed
300-second window length is the protocol's documented default, not a timestamp
inferred from fixture window indices. No wall-clock event time is invented.

Nodes contain event-key address, credential eligibility, rejection reason,
partner counts and one of: `passed`, `credentialed_not_passed`,
`excluded_duplicate`, `not_credentialed`, `no_qualifying_partner`. An accepted
key with no mutual relations is shown as a walk-in/drive-by. A key with raw
mutual relations but insufficient credentialed partners (such as Mallory's
first phone) is credentialed but not passed. Duplicate rejection is shown only
for keys that have no accepted credential. Dashed edges connect keys without
two accepted credentials and do not contribute to partner counts.

The default demo is explicitly recorded synthetic data: three honest
attendees pass; Mallory has one credentialed key that fails and two keys with
no credential; the walk-in has a credential and no partners. Before all
windows have arrived, unfinished credentialed nodes display PENDING.

## Browser verification and clip

Google Chrome and ffmpeg must be installed locally. Browser tests use a
separate, ephemeral Chrome profile, with no account login or existing tabs.

```sh
node_modules/.bin/playwright test
node capture.mjs /private/tmp/graph-viz-out
```

Capture runs the actual Play control and takes three 1920×1080 stills from
slots 0, 1 and 2. ffmpeg holds those frames for 6.5, 6.5 and 8 seconds to make
`p5-graph-replay.mp4`: 21 seconds, 30 fps, H.264, silent. This is a discrete
slot replay; there are no interpolated encounters. The directory also contains
`p5-graph-replay-closing.png`, the three `p5-still-*.png` files, a mobile
screenshot and capture metadata. Video and screenshots are never committed.

Evaluator regression coverage includes exact comparison of every output file
and evaluate/verify CLI receipt with main commit
`a07469bd3692751a9738d166800fc4d841cf9794`. That commit must be available in the
local Git history when running the test (fetch it in a shallow checkout).
The default fixture root remains
`0x4e663e1d45553efdf5247a720b30f569a340fe2e7c4294501d04608160230fe9`;
manifest digest remains
`0x1f61fff1d38a9944ad53b6562423d5b9b33f59e067dece272b58087c1077351a`.
