import { describe, expect, it, vi } from "vitest";
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { StandardMerkleTree } from "@openzeppelin/merkle-tree";
import { ed25519 } from "@noble/curves/ed25519.js";
import { AbiCoder, getBytes, id, recoverAddress, toBeHex, zeroPadValue } from "ethers";
import { appDigest, appMessage, eventKeyAddress, fromHex, hex, sha } from "../src/codec.js";
import { verifyEvidence, type Envelope } from "../src/evidence.js";
import { deriveRelations, evaluateRule, verifyCredentials, type CredentialList, type Parameters } from "../src/evaluate.js";
import { loadEnvelopes } from "../src/io.js";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const fixture = <T>(name: string): T =>
  JSON.parse(readFileSync(join(root, "test/fixtures", name), "utf8")) as T;
const params = fixture<Parameters>("params.json");
const credentials = fixture<CredentialList>("credentials.json");
const pages = fixture<Envelope[]>("envelopes.json");
const anchors = fixture<Record<string, number>>("anchor-blocks.json");
const evidence = verifyEvidence(pages, params.eventId, params.snapshot.cutoffBlock, anchors);
const address = (index: number) => credentials.credentials[index].eventKeyAddress.toLowerCase();
const participantPasses = (result: ReturnType<typeof evaluateRule>, index: number) =>
  result.eligible.some(x => x.address.toLowerCase() === address(index));

describe("golden app signatures", () => {
  const vector = JSON.parse(readFileSync(resolve(root, "../docs/design/test-vectors/app-signature-v1.json"), "utf8"));
  it("matches both exact messages, digests, signer and address", () => {
    expect(eventKeyAddress(fromHex(vector.eventKeyCompressed))).toBe(vector.eventKeyAddress);
    const event = fromHex(vector.eventId);
    const claimBody = Buffer.concat([
      getBytes(zeroPadValue(toBeHex(vector.claim.chainId), 32)),
      fromHex(vector.claim.claimContract),
      fromHex(vector.claim.recipient),
    ]);
    expect("0x" + hex(appMessage(2, event, claimBody))).toBe(vector.claim.message);
    expect("0x" + hex(appDigest(2, event, claimBody))).toBe(vector.claim.digest);
    expect(recoverAddress(vector.claim.digest, vector.claim.signature)).toBe(vector.eventKeyAddress);
    const challenge = fromHex(vector.humanCheckBinding.challenge);
    expect("0x" + hex(appMessage(1, event, challenge))).toBe(vector.humanCheckBinding.message);
    expect("0x" + hex(appDigest(1, event, challenge))).toBe(vector.humanCheckBinding.digest);
    expect(recoverAddress(vector.humanCheckBinding.digest, vector.humanCheckBinding.signature))
      .toBe(vector.eventKeyAddress);
  });
});

describe("fixture evidence and evaluation", () => {
  it("verifies real COSE and inclusion, then drops the tampered signature", () => {
    expect(evidence.observations).toHaveLength(14);
    expect(evidence.invalid).toHaveLength(1);
    expect(evidence.invalid[0].reason).toBe("invalid_signature");
    expect(evidence.commitmentDigests).toHaveLength(1);
    expect(evidence.anchorRange).toEqual({ first: 90, last: 90 });
  });
  it("matches all three pitch counterfactual columns", () => {
    const full = evaluateRule(params, evidence, credentials);
    const noGate = evaluateRule(params, evidence, credentials, { humanGate: false });
    const noEncounter = evaluateRule(params, evidence, credentials, { encounterRequirement: false });
    for (const result of [full, noGate, noEncounter])
      for (const index of [0, 1, 2]) expect(participantPasses(result, index)).toBe(true);
    expect([3, 4, 5].filter(i => participantPasses(full, i))).toHaveLength(1);
    expect([3, 4, 5].filter(i => participantPasses(noGate, i))).toHaveLength(3);
    expect([3, 4, 5].filter(i => participantPasses(noEncounter, i))).toHaveLength(1);
    expect(participantPasses(full, 6)).toBe(false);
    expect(participantPasses(noGate, 6)).toBe(false);
    expect(participantPasses(noEncounter, 6)).toBe(true);
    expect(full.rejected.find(x => x.address.toLowerCase() === address(6))?.reason).toBe("too_few_partners");
    expect(full.rpidConflicts).toHaveLength(1);
    expect(full.rpidConflicts[0].keys).toHaveLength(2);
  });
  it("counts distinct windows per partner and is independent of retries", () => {
    const repeated = deriveRelations([...evidence.observations, evidence.observations[0]]);
    expect([...repeated.pairs].map(([key, windows]) => [key, [...windows].sort()]))
      .toEqual([...deriveRelations(evidence.observations).pairs].map(([key, windows]) => [key, [...windows].sort()]));
    const stricter = evaluateRule({ ...params, minWindowsPerPartner: 3 }, evidence, credentials);
    expect(stricter.eligible).toHaveLength(0);
    expect(stricter.rejected.find(x => x.address.toLowerCase() === address(0))?.reason).toBe("too_few_windows");
  });
  it("fails closed if the trusted block map is absent", () => {
    expect(() => verifyEvidence(pages, params.eventId, params.snapshot.cutoffBlock, {}))
      .toThrow("missing trusted anchor block mapping");
  });
  it("checks the commitment chain on a single page", () => {
    const [original] = structuredClone(pages);
    const broken = structuredClone(original);
    broken.commitments.push(structuredClone(original.commitments[0]));
    expect(() => verifyEvidence([broken], params.eventId, params.snapshot.cutoffBlock, anchors))
      .toThrow("commitment anchor chain mismatch");
    const late = structuredClone(original);
    late.commitments[0].anchor.sequence = 2;
    late.commitments[0].anchor.previousCommitmentDigest = "11".repeat(32);
    expect(() => verifyEvidence([late], params.eventId, params.snapshot.cutoffBlock, anchors))
      .toThrow("commitment anchor chain mismatch");
  });
  it("reassembles inner observation continuation before checking the commitment", () => {
    const [original] = structuredClone(pages);
    const first = structuredClone(original), second = structuredClone(original);
    first.commitments[0].inclusions = original.commitments[0].inclusions.slice(0, 7);
    first.observations = original.observations.slice(0, 7);
    first.commitments[0].nextObservationCursor = "6";
    second.commitments[0].inclusions = original.commitments[0].inclusions.slice(7);
    second.observations = original.observations.slice(7);
    second.commitments[0].observationCursor = "6";
    expect(verifyEvidence([first, second], params.eventId, params.snapshot.cutoffBlock, anchors).inputDigests)
      .toEqual(evidence.inputDigests);
    expect(() => verifyEvidence([first], params.eventId, params.snapshot.cutoffBlock, anchors))
      .toThrow("incomplete envelope pagination");
  });
  it("follows the verification-envelope API's inner continuation with fixture responses", async () => {
    const [original] = structuredClone(pages);
    const first = structuredClone(original), second = structuredClone(original);
    first.commitments[0].inclusions = original.commitments[0].inclusions.slice(0, 7);
    first.observations = original.observations.slice(0, 7);
    first.commitments[0].nextObservationCursor = "6";
    second.commitments[0].inclusions = original.commitments[0].inclusions.slice(7);
    second.observations = original.observations.slice(7);
    second.commitments[0].observationCursor = "6";
    const requested: string[] = [];
    vi.stubGlobal("fetch", async (url: URL) => {
      requested.push(String(url));
      return new Response(JSON.stringify(requested.length === 1 ? first : second),
        { status: 200, headers: { "content-type": "application/json" } });
    });
    try {
      const url = `https://fixture.invalid/v1/events/${params.eventId.slice(2)}/verification`;
      const loaded = await loadEnvelopes(url, root, params.eventId);
      expect(loaded).toHaveLength(2);
      expect(requested[1]).toContain("observationCursor=6");
      expect(verifyEvidence(loaded, params.eventId, params.snapshot.cutoffBlock, anchors).inputDigests)
        .toEqual(evidence.inputDigests);
    } finally { vi.unstubAllGlobals(); }
  });
});

describe("Alcor credentials", () => {
  // Exact public fixture emitted by alcor worker at commit 448ab64.
  const producer = fixture<{ testAttestationSeed: string; response: CredentialList }>("alcor-signed-credentials-v1.json");
  const producerParams: Parameters = { ...params, eventId: producer.response.eventId,
    credentialsPublicKey: producer.response.credentials[0].attestation.publicKey,
    snapshot: { ...params.snapshot, cutoffTimestamp: Date.parse("2026-09-26T00:00:00.000Z") / 1000 } };
  it("verifies the pinned Ed25519 key, attestation and app binding", () => {
    const result = verifyCredentials(credentials, params);
    expect(result.accepted.size).toBe(5);
    expect(result.invalid.map(x => x.reason)).toEqual(["duplicate_nullifier_or_key", "duplicate_nullifier_or_key"]);
  });
  it("consumes the exact independently produced Alcor fixture", () => {
    const result = verifyCredentials(producer.response, producerParams);
    expect(result.accepted.size).toBe(1);
    expect(result.invalid).toEqual([]);
  });
  it("rejects producer fixture signature and public-key tampering", () => {
    const signature = structuredClone(producer.response);
    signature.credentials[0].attestation.signature = "0x" + "00".repeat(64);
    expect(verifyCredentials(signature, producerParams).invalid[0].reason).toBe("invalid_attestation_signature");
    const key = structuredClone(producer.response);
    key.credentials[0].attestation.publicKey = "0x" + "00".repeat(32);
    expect(verifyCredentials(key, producerParams).invalid[0].reason).toBe("attestation_public_key_mismatch");
  });
  it("rejects a producer app-signature change even when attestation is re-signed", () => {
    const list = structuredClone(producer.response);
    const entry = list.credentials[0];
    entry.appSignature = "0x" + "00" + entry.appSignature.slice(4);
    const { attestation: _old, ...unsigned } = entry;
    const canonical = (value: unknown): string => {
      if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
      if (value && typeof value === "object")
        return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
          .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
      return JSON.stringify(value);
    };
    entry.attestation.signature = "0x" + hex(ed25519.sign(
      Buffer.from("alcor/credential/v1\0" + canonical(unsigned)), fromHex(producer.testAttestationSeed, 32)));
    const result = verifyCredentials(list, producerParams);
    expect(result.accepted.size).toBe(0);
    expect(result.invalid[0].reason).not.toBe("invalid_attestation_signature");
  });
  it.each([
    ["attestation signature", (entry: any) => { entry.attestation.signature = entry.attestation.signature.slice(0, -2) + "00"; }],
    ["app signature", (entry: any) => { entry.appSignature = entry.appSignature.slice(0, -2) + "00"; }],
    ["public key", (entry: any) => { entry.attestation.publicKey = "0x" + "00".repeat(32); }],
  ])("rejects a flipped %s", (_, mutate) => {
    const list = structuredClone(credentials);
    mutate(list.credentials[0]);
    const result = verifyCredentials(list, params);
    expect(result.accepted.has(address(0))).toBe(false);
    expect(result.invalid.some(x => x.address.toLowerCase() === address(0))).toBe(true);
  });
});

describe("OpenZeppelin address-only tree", () => {
  it("matches the shared three-address root and all proof bytes", () => {
    const vector = fixture<{ addresses: string[]; root: string; proofs: Record<string, string[]> }>("merkle-3-address.json");
    const tree = StandardMerkleTree.of(vector.addresses.map(x => [x]), ["address"], { sortLeaves: true });
    expect(tree.root).toBe("0xadad4040c18fafa3fd40fa142d1697b736f0c0b95050ba66ad302f0d2373d8a2");
    expect(tree.root).toBe(vector.root);
    for (const [i, address] of vector.addresses.entries()) {
      expect(tree.getProof(i)).toEqual(vector.proofs[address]);
      expect(StandardMerkleTree.verify(vector.root, ["address"], [address], vector.proofs[address])).toBe(true);
    }
  });
});

describe("CLI receipt", () => {
  it("uses an explicit synthetic pending feed and refuses missing live feed", () => {
    const run = (file: string) => spawnSync("pnpm",
      ["mizar", "progress", "--params", file, "--key", credentials.credentials[0].eventKeyAddress],
      { cwd: root, encoding: "utf8", timeout: 30_000 });
    const fixtureProgress = run("test/fixtures/params.json");
    expect(fixtureProgress.status).toBe(0);
    expect(fixtureProgress.stdout).toContain('"source":"synthetic-pending-fixture"');
    expect(fixtureProgress.stdout).toContain('"reached":true');
    const out = mkdtempSync(join(tmpdir(), "mizar-progress-test-"));
    try {
      const noFeed = join(out, "params.json");
      const { pendingSource: _omitted, ...withoutPending } = params;
      writeFileSync(noFeed, JSON.stringify(withoutPending));
      const unavailable = run(noFeed);
      expect(unavailable.status).toBe(2);
      expect(unavailable.stdout).toContain('"result":"UNAVAILABLE"');
    } finally { rmSync(out, { recursive: true, force: true }); }
  }, 30_000);
  it("returns UNAVAILABLE before fetching live evidence without registry mapping", () => {
    const out = mkdtempSync(join(tmpdir(), "mizar-live-test-"));
    try {
      const file = join(out, "params.json");
      writeFileSync(file, JSON.stringify({ ...params,
        evidenceSource: `https://fixture.invalid/v1/events/${params.eventId.slice(2)}/verification`,
        rpcUrl: undefined, commitmentRegistry: undefined }));
      const result = spawnSync("pnpm",
        ["mizar", "evaluate", "--params", file, "--out", join(out, "result")],
        { cwd: root, encoding: "utf8", timeout: 30_000 });
      expect(result.status).toBe(2);
      expect(result.stdout).toContain('"result":"UNAVAILABLE"');
      expect(result.stdout).toContain("all three registry addresses");
    } finally { rmSync(out, { recursive: true, force: true }); }
  }, 30_000);
  it("writes four output classes, passes, and fails on one-bit input/root changes", () => {
    const out = mkdtempSync(join(tmpdir(), "mizar-eval-test-"));
    const run = (...args: string[]) => spawnSync("pnpm", ["mizar", ...args], {
      cwd: root, encoding: "utf8", timeout: 30_000,
    });
    try {
      const evaluated = run("evaluate", "--params", "test/fixtures/params.json", "--out", out);
      expect(evaluated.status).toBe(0);
      expect(readFileSync(join(out, "eligible.json"), "utf8")).toContain("addresses");
      expect(readFileSync(join(out, "rejected.json"), "utf8")).toContain("invalidObservations");
      expect(readFileSync(join(out, "proofs", credentials.credentials[0].eventKeyAddress.toLowerCase() + ".json"), "utf8"))
        .toContain("proof");
      const manifestPath = join(out, "manifest.json");
      const evaluatedReceipt = JSON.parse(evaluated.stdout.trim().split("\n").at(-1)!);
      expect(evaluatedReceipt.manifestDigest).toBe("0x" + hex(sha(readFileSync(manifestPath))));
      expect(evaluatedReceipt.root).toBe("0x4e663e1d45553efdf5247a720b30f569a340fe2e7c4294501d04608160230fe9");
      expect(evaluatedReceipt.manifestDigest).toBe("0x1f61fff1d38a9944ad53b6562423d5b9b33f59e067dece272b58087c1077351a");
      expect(run("verify", "--manifest", manifestPath).stdout).toContain('"result":"PASS"');
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      manifest.root = manifest.root.slice(0, -1) + (manifest.root.endsWith("0") ? "1" : "0");
      writeFileSync(manifestPath, JSON.stringify(manifest));
      const badRoot = run("verify", "--manifest", manifestPath);
      expect(badRoot.status).toBe(1);
      expect(badRoot.stdout).toContain('"fault":"root_mismatch"');
      manifest.root = evaluateRule(params, evidence, credentials).root;
      writeFileSync(manifestPath, JSON.stringify(manifest));
      const inputPath = join(out, "inputs/credentials.json");
      const input = readFileSync(inputPath);
      // Flip one bit of the first hex digit after `"signature": "0x`.
      const at = input.indexOf(Buffer.from('"signature": "0x')) + 16;
      input[at] = (parseInt(String.fromCharCode(input[at]), 16) ^ 1).toString(16).charCodeAt(0);
      writeFileSync(inputPath, input);
      const badInput = run("verify", "--manifest", manifestPath);
      expect(badInput.status).toBe(1);
      expect(badInput.stdout).toContain('"fault":"invalid_signature"');
      // Re-seal the input digest so verify reaches the signature check itself.
      manifest.inputs.credentials.sha256 = hex(sha(input));
      writeFileSync(manifestPath, JSON.stringify(manifest));
      const resealed = run("verify", "--manifest", manifestPath);
      expect(resealed.status).toBe(1);
      expect(resealed.stdout).toContain('"fault":"invalid_signature"');
      expect(resealed.stdout).toContain("verification failures differ from the manifest");
    } finally { rmSync(out, { recursive: true, force: true }); }
  }, 30_000);
  it("checks RootPosted and registry anchors against a fixture JSON-RPC stub", async () => {
    const out = mkdtempSync(join(tmpdir(), "mizar-rpc-test-"));
    const contract = "0x00000000000000000000000000000000000000c1";
    const registries = { eventRegistry: "0x00000000000000000000000000000000000000e1",
      definitionRegistry: "0x00000000000000000000000000000000000000d1",
      commitmentRegistry: "0x00000000000000000000000000000000000000a1" };
    const [page] = pages, admission = page.admission, anchor = page.commitments[0].anchor;
    const abi = AbiCoder.defaultAbiCoder(), word = (value: string | number) => zeroPadValue(toBeHex(value), 32);
    const cutoff = params.snapshot.cutoffBlock;
    let posted = { root: "", manifestDigest: "", cutoffBlock: cutoff };
    let postedLogPresent = true, anchorBlock = anchors[anchor.commitmentDigest], extraCommitment = false;
    const log = (address: string, block: number, topics: string[], data: string) => ({
      address, blockNumber: toBeHex(block), blockHash: "0x" + "11".repeat(32),
      transactionHash: "0x" + "22".repeat(32), transactionIndex: "0x0", logIndex: "0x0", removed: false, topics, data });
    // Offline JSON-RPC stub: serves the three registry events, the cutoff block and one RootPosted log.
    const logsFor = (topic0: string) => {
      if (topic0 === id("EventRegistered(bytes32,address,address,bytes32,uint64)"))
        return [log(registries.eventRegistry, 10, [topic0, "0x" + page.context,
          zeroPadValue("0x" + admission.anchorRegistration.registrar, 32),
          zeroPadValue("0x" + admission.anchorRegistration.operator, 32)],
        abi.encode(["bytes32", "uint64"], ["0x" + admission.anchorRegistration.keySetDigest,
          admission.anchorRegistration.registeredAt]))];
      if (topic0 === id("EventDefinitionAnchored(bytes32,uint64,bytes32,bytes32,uint64,uint64,uint64)")) {
        const d = admission.definitionAnchor;
        return [log(registries.definitionRegistry, 20, [topic0, "0x" + page.context, word(d.sequence),
          "0x" + d.definitionDigest], abi.encode(["bytes32", "uint64", "uint64", "uint64"],
          ["0x" + d.previousDefinitionDigest, d.validFrom, d.validUntil, d.anchoredAt]))];
      }
      if (topic0 === id("ObservationCommitmentRecorded(bytes32,uint64,bytes32,bytes32,address,uint64)")) {
        const commitment = (sequence: number, digest: string, previous: string, block: number) =>
          log(registries.commitmentRegistry, block, [topic0, "0x" + page.context, word(sequence), "0x" + digest],
            abi.encode(["bytes32", "address", "uint64"], ["0x" + previous,
              "0x" + admission.anchorRegistration.operator, anchor.committedAt]));
        return [commitment(anchor.sequence, anchor.commitmentDigest, anchor.previousCommitmentDigest, anchorBlock),
          ...(extraCommitment ? [commitment(2, "ab".repeat(32), anchor.commitmentDigest, cutoff - 5)] : [])];
      }
      return !postedLogPresent ? [] : [log(contract, cutoff + 5, [topic0, word(params.snapshot.id)],
        abi.encode(["bytes32", "bytes32", "uint64"], [posted.root, posted.manifestDigest, posted.cutoffBlock]))];
    };
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", chunk => { body += chunk; });
      req.on("end", () => {
        const request = JSON.parse(body);
        const answer = (r: { id: number; method: string; params: any[] }) => ({ jsonrpc: "2.0", id: r.id,
          result: r.method === "eth_chainId" ? toBeHex(params.chainId)
            : r.method === "eth_blockNumber" ? toBeHex(cutoff + 10)
            : r.method === "eth_getBlockByNumber" ? {
              number: r.params[0], hash: "0x" + "33".repeat(32), parentHash: "0x" + "44".repeat(32),
              timestamp: toBeHex(params.snapshot.cutoffTimestamp), nonce: "0x0000000000000000",
              difficulty: "0x0", gasLimit: "0x1c9c380", gasUsed: "0x0", baseFeePerGas: "0x1",
              miner: "0x" + "00".repeat(20), extraData: "0x", transactions: [] }
            : r.method === "eth_getLogs" ? logsFor(r.params[0].topics[0]) : null });
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(Array.isArray(request) ? request.map(answer) : answer(request)));
      });
    });
    await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
    const rpc = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    // Async spawn: spawnSync would block the stub server in this process.
    const run = (...args: string[]) => new Promise<{ status: number | null; stdout: string }>(done => {
      const child = spawn("pnpm", ["mizar", ...args], { cwd: root });
      let stdout = "";
      child.stdout.on("data", chunk => { stdout += chunk; });
      child.on("close", status => done({ status, stdout }));
    });
    try {
      // Registry-less parameters leave the anchor sidecar unchecked: never PASS.
      const plain = join(out, "plain");
      expect((await run("evaluate", "--params", "test/fixtures/params.json", "--out", plain)).status).toBe(0);
      const unbacked = await run("verify", "--manifest", join(plain, "manifest.json"), "--rpc", rpc, "--contract", contract);
      expect(unbacked.status).toBe(2);
      expect(unbacked.stdout).toContain('"result":"UNAVAILABLE"');
      expect(unbacked.stdout).toContain("--commitment-registry");

      const paramsFile = join(out, "params.json");
      const fixtures = join(root, "test/fixtures");
      writeFileSync(paramsFile, JSON.stringify({ ...params, ...registries,
        evidenceSource: join(fixtures, "envelopes.json"), credentialsSource: join(fixtures, "credentials.json"),
        anchorBlocksSource: join(fixtures, "anchor-blocks.json"), pendingSource: undefined }));
      const result = join(out, "registry");
      const evaluated = await run("evaluate", "--params", paramsFile, "--out", result);
      expect(evaluated.status).toBe(0);
      const receipt = JSON.parse(evaluated.stdout.trim().split("\n").at(-1)!);
      const trust = (overrides: Record<string, string> = {}) => Object.entries({ "chain-id": String(params.chainId),
        "event-registry": registries.eventRegistry, "definition-registry": registries.definitionRegistry,
        "commitment-registry": registries.commitmentRegistry, ...overrides }).flatMap(([k, v]) => ["--" + k, v]);
      const verifyOnChain = (overrides: Record<string, string> = {}) => run("verify", "--manifest",
        join(result, "manifest.json"), "--rpc", rpc, "--contract", contract, ...trust(overrides));
      const good = { root: receipt.root, manifestDigest: receipt.manifestDigest, cutoffBlock: cutoff };
      posted = good;
      const pass = await verifyOnChain();
      expect(pass.stdout).toContain('"result":"PASS"');
      expect(pass.status).toBe(0);
      const wrongChain = await verifyOnChain({ "chain-id": "1" });
      expect(wrongChain.status).toBe(2);
      expect(wrongChain.stdout).toContain("is not the trusted chain ID 1");
      // A poster-chosen registry in the params cannot replace the verifier's own.
      const otherRegistry = await verifyOnChain({ "commitment-registry": "0x00000000000000000000000000000000000000a2" });
      expect(otherRegistry.status).toBe(1);
      expect(otherRegistry.stdout).toContain('"fault":"root_mismatch"');
      expect(otherRegistry.stdout).toContain("different commitmentRegistry");
      const flip = (value: string) => value.slice(0, -1) + (parseInt(value.slice(-1), 16) ^ 1).toString(16);
      for (const [change, reason] of [
        [{ manifestDigest: flip(receipt.manifestDigest) }, "manifest_digest_mismatch"],
        [{ cutoffBlock: cutoff + 1 }, "cutoff_block_mismatch"],
        [{ root: flip(receipt.root) }, undefined],
      ] as const) {
        posted = Object.assign({ ...good }, change);
        const failed = await verifyOnChain();
        expect(failed.status).toBe(1);
        expect(failed.stdout).toContain('"fault":"root_mismatch"');
        if (reason) expect(failed.stdout).toContain(reason);
      }
      posted = good;
      // The sidecar says block 90; the registry anchored the commitment after the cutoff.
      anchorBlock = cutoff + 1;
      const moved = await verifyOnChain();
      expect(moved.status).toBe(1);
      expect(moved.stdout).toContain('"fault":"root_mismatch"');
      expect(moved.stdout).toContain("archived anchor block mapping differs from chain");
      anchorBlock = anchors[anchor.commitmentDigest];
      extraCommitment = true;
      const omitted = await verifyOnChain();
      expect(omitted.status).toBe(1);
      expect(omitted.stdout).toContain('"fault":"root_mismatch"');
      expect(omitted.stdout).toContain("commitment anchored before cutoff missing from evidence");
      extraCommitment = false;
      postedLogPresent = false;
      const missing = await verifyOnChain();
      expect(missing.status).toBe(2);
      expect(missing.stdout).toContain('"result":"UNAVAILABLE"');
      expect(missing.stdout).toContain("RootPosted event unavailable");
    } finally {
      server.close();
      rmSync(out, { recursive: true, force: true });
    }
  }, 120_000);
});
