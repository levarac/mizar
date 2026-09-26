# Claim page deployment

The fixed destination is **https://levarac-mizar-claim.levarac.workers.dev/**,
served by the static-assets Worker `levarac-mizar-claim` in the Levarac account.
This uses Workers, not Cloudflare Pages. No server code, D1 database or Worker
secrets are needed. The callback returns to the root URL with its fragment.

## Public event configuration

Edit [`public/claim-config.json`](public/claim-config.json). Vite imports this
same file into the page and copies it to `/claim-config.json`. The page also
shows its values under **Event and claim details**.

- Network: Sepolia, chain ID `11155111`.
- Browser RPC: `https://ethereum-sepolia-rpc.publicnode.com`, the keyless
  [PublicNode Sepolia endpoint](https://ethereum.publicnode.com/?sepolia).
  Never substitute a private RPC URL or read a secrets file into the build.
- Event: `0xccb8770a524f4145e04b3c97d8ffe2f7301ce65b4041d80e419bafdd803b2ee1`.
- Event code: `parallax-sepolia-20260926-demo`.
- Event window: `2026-09-26T05:30Z` through `2026-09-27T15:00Z`.
- World ID action: `mizar-ccb8770a`, configured separately for the join service;
  the claim page does not call World ID.

The supplied Sepolia claim contract is
`0xC54b23Ce524ea22D41A65c2EfceEc5e483f2F0fC`. Three explicit placeholders remain
until the first root is posted: `expectedRoot`, `snapshotId`, and `eligibleJsonUrl`. Set
`snapshotId` to a JSON integer (zero is valid if that is the posted ID), and
`eligibleJsonUrl` to `/snapshots/<snapshotId>/eligible.json`.

Both `pnpm build` and `wrangler deploy --dry-run` intentionally fail while any
placeholder remains. Wrangler's custom build invokes the same validation before
an upload. There is no production build option to skip this validation. Tests
and type checking can run before live values exist. Existing callback and
evaluator fixtures retain their original event IDs.

## Snapshot assets

Copy the reviewed evaluator output into `public/snapshots/<snapshotId>/`:

```text
public/snapshots/<snapshotId>/
  manifest.json
  eligible.json
  proofs/
    <lowercase-event-key-address>.json
```

These are served on the same origin, so no CORS configuration is required.
For example, snapshot 1 uses `/snapshots/1/eligible.json` and
`/snapshots/1/proofs/<lowercase-event-key-address>.json`. Preserve prior snapshot
directories when adding a later one; do not overwrite a published snapshot.
Only place intentionally public files in `public/`, since everything there is
uploaded. Keep private evidence, credentials and environment files out of it.

The build pins the exact claim contract and requires a manifest with the
configured event, root and Sepolia chain ID. It checks `outputDigests.eligible`
against the SHA-256 digest of `JSON.stringify` applied to the parsed eligible
file, matching the evaluator's format. It also validates the address, root and
Merkle membership of every listed key's proof. Every published proof JSON,
including those in retained snapshots, must be listed in its own snapshot's
eligible file. It does not query Sepolia or establish that the manifest
digest and root were posted. Independently compare the contract's event,
`RootPosted` snapshot ID, root and manifest digest before preparing a release.
Full public recomputation also needs the evaluator's archived inputs; see the
[evaluator instructions](../evaluator/README.md).

Missing asset paths return HTTP 404, including missing proofs; they do not fall
back to HTML. The root callback needs no SPA fallback. Configuration and assets
are defined using Cloudflare's [static asset configuration](https://developers.cloudflare.com/workers/static-assets/binding/)
and [custom builds](https://developers.cloudflare.com/workers/wrangler/custom-builds/).
The [`_headers`](public/_headers) rules add `X-Content-Type-Options: nosniff`
and `Content-Security-Policy: frame-ancestors 'none'` to static responses.
Configuration and snapshot responses use `Cache-Control: no-cache` so returning
browsers revalidate them. See [Cloudflare static asset headers](https://developers.cloudflare.com/workers/static-assets/headers/).

## Local validation

From this directory, with Node.js 22+ and pnpm:

```sh
pnpm install --frozen-lockfile
pnpm test
pnpm typecheck
pnpm build
WRANGLER_SEND_METRICS=false pnpm deploy:dry-run
```

The last two commands require complete configuration and snapshot assets. For
development before those values exist, use a separate temporary copy with
explicitly synthetic configuration and evaluator fixtures. Never publish that
copy. There is no connection between a successful synthetic rehearsal and a
live Sepolia deployment.

After validation, `pnpm exec wrangler dev --local` serves the same static assets
locally. Check the root page, expand event details, enter a recipient, and check
`/claim-config.json`, the eligible list, a proof, and a missing proof (404).

## Maintainer release and smoke checks

Only the maintainer executes the upload after reviewing the completed values
and local results. From `web/`, load the Levarac token inside the same zsh
subshell with tracing disabled and scope credentials to the command:

Set `SECRETS_FILE` to your own untracked file defining `CLOUDFLARE_API_TOKEN_LEVARAC`.

```zsh
(
  set +x
  set +v
  source "$SECRETS_FILE" >/dev/null 2>&1 || exit 1
  if [[ -z "${CLOUDFLARE_API_TOKEN_LEVARAC:-}" ]]; then
    printf '%s\n' UNSET
    exit 1
  fi
  printf '%s\n' SET
  CLOUDFLARE_API_TOKEN="$CLOUDFLARE_API_TOKEN_LEVARAC" \
    CLOUDFLARE_ACCOUNT_ID=3b81daf46f27d8d61d46559407b8a607 \
    WRANGLER_SEND_METRICS=false pnpm exec wrangler deploy
)
```

Record the returned deployed version and confirm the exact fixed URL. Open it
on a phone and expand **Event and claim details**; compare all eight values with
the approved configuration. Confirm that `/claim-config.json` returns that same
configuration, `/snapshots/<snapshotId>/eligible.json` returns JSON, a listed
key's proof returns JSON with the expected root, and a nonexistent proof returns
404. Enter the recipient and complete the app callback and wallet claim on the
maintainer's phone. Page loading and JSON delivery alone do not verify a claim.

## Read-only participation rule

`public/claim-config.json` also defines `paramsUrl` (an explicit HTTPS URL) and
`paramsSha256` (64 hexadecimal characters). The rule card hashes the exact
response bytes with SHA-256 before parsing or displaying N, B and the human-check
issuer. Missing configuration, a failed fetch, an invalid document or a digest
mismatch shows a visible verification error without fallback values. The event
ID must match the claim page configuration. This card does not change claim
validation or submission.

Optional `slotSeconds`, `eventStart` and `eventEnd` describe the event definition
for reference. `slotSeconds` must be a positive integer; the two timestamps must
be supplied together in UTC (`YYYY-MM-DDTHH:mm:ssZ`), with end after start. Absent
fields are omitted. The card labels these separately from verified parameters,
and displays both UTC and the browser's local timezone.

## Fixture preview

```sh
pnpm --ignore-workspace run build:preview
pnpm --ignore-workspace run preview
```

The preview listens on `0.0.0.0:4173` with a fixed port. It builds into
`web/dist/preview`, independently of the strict deployment
build. It uses the existing evaluator fixtures and a byte-for-byte copy of the
published parameters. Timing reference data comes from the event configuration.
The visible `Preview: fixture data` bar contains the state selector; a state can
also be selected with `?state=recipient`.

Available states: `unconfigured`, `params-unverified`, `idle`, `lookup`,
`not-eligible`, `recipient`, `signature`, `ready`, `submitting`, `submitted`,
`claimed`, `already-claimed`, `error`.

Preview actions only change the displayed state. The transaction link is a
non-navigating fixture. The preview does not initialize the live claim module,
connect a wallet, request a signature or submit a transaction. Normal builds
exclude the preview module and state controls stay hidden.

The live page reports a returned transaction hash as **submitted**, with a
Sepolia explorer link. It does not infer confirmation from submission; the
confirmed **claimed** view is available for fixture previews only. The strict
production build still requires a complete real configuration and snapshot.

Inter is self-hosted as WOFF2 under `public/fonts/`; its SIL Open Font License is
included alongside the font. No font CDN is used.
