# Try page

A static overview page for the ETHGlobal Tokyo 2026 submission, served at
<https://levarac-try.levarac.workers.dev>. It links to the live pieces
(Beid TestFlight, Alcor join page, Sepolia contract, EAS schema), explains the
rule and embeds the [evaluation graph replay](../../docs/demo/graph/) at `/graph/`.
No trackers, analytics or third-party scripts; Inter is self-hosted from
`web/public/fonts` with its OFL licence.

## Build

`node build.mjs` writes `dist/` from `public/`, `web/public/fonts` and
`docs/demo/graph/dist`. When the graph replay has not been built yet it runs
`docs/demo/graph/build.mjs`, which needs the evaluator and graph dependencies:

```sh
(cd evaluator && pnpm install --frozen-lockfile --ignore-workspace)
(cd docs/demo/graph && pnpm install --frozen-lockfile --ignore-workspace)
node site/try/build.mjs
```

Preview `dist/` with any static server, for example
`npx wrangler dev` from `site/try/`.

## Deploy

`wrangler deploy` from `site/try/` runs the build and uploads `dist/` as the
`levarac-try` static assets on the Levarac Cloudflare account.

## Content

Every claim on the page follows the repository README on `main`. Status that
can change (claim page, snapshots, live claims) is linked, not restated. When
the demo video URL exists, replace the "Video coming soon" card in
`public/index.html` with a link.
