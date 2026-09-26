# Alcor human-check service and join page

Sanitized implementation prompt. The [shared constraints](../README.md#shared-constraints-from-the-prompts) apply.

## Task

Build the human-check service under Alcor `worker/` using TypeScript, a Cloudflare Worker, local D1 through Wrangler or Miniflare, and Vitest. Build the static join page under `web/` with TypeScript and a pinned IDKit 4 dependency.

Verify the purpose-01 app signature with viem. Bind the World proof to the event key and challenge, forward IDKit results to World's v4 verify endpoint through an injectable client, and enforce one key per nullifier with the first successful verification winning. Sign each published credential using a service key supplied through an environment binding. Implement the credential-list endpoint.

Consult the World IDKit and verification documentation for the precise request/response shapes and record references in `worker/README.md`. Preserve the shared app-signature byte layout and golden vector.

## Acceptance criteria

- Cover every endpoint and success, invalid proof, wrong signal, duplicate nullifier and expired challenge cases with a mocked World client.
- Generate app signatures from labeled deterministic test keys.
- Dependency installation and `pnpm test` succeed from `worker/`; `pnpm wrangler dev --local` starts locally; `pnpm build` succeeds from `web/`.
- Leave World application, relying-party and action configuration as environment bindings with obviously fake examples. Document the exact setup steps for a maintainer without performing Portal registration or deployment.

## Historical clarification

The initial brief allowed Ed25519 or secp256k1 for the service signature. The shared specification settled on Ed25519 with defined canonical bytes. The initial brief also described the mock responses as recorded-shape fixtures; that describes their format, not captured live World proofs.

## Delivery evidence

Report the exact source revision, commands and actual results, unconfigured live dependencies, and any mismatch with the specification. Local mocks do not establish successful live World verification.
