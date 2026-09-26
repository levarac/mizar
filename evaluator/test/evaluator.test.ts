import { describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
import { insideArchive, loadEnvelopes } from "../src/io.js";

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
  it("fails on Observation bytes that differ from the committed digest", () => {
    const [corrupt] = structuredClone(pages);
    const bytes = Buffer.from(corrupt.observations[0].signedObservation, "base64");
    bytes[bytes.length - 1] ^= 1;
    corrupt.observations[0].signedObservation = bytes.toString("base64");
    expect(() => verifyEvidence([corrupt], params.eventId, params.snapshot.cutoffBlock, anchors))
      .toThrow("Observation digest mismatch against commitment");
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

describe("trusted-params guard", () => {
  it("treats every spelling of a path inside the archive as inside", async () => {
    const archive = mkdtempSync(join(tmpdir(), "mizar-guard-test-"));
    try {
      expect(await insideArchive(join(archive, "..params.json"), archive)).toBe(true);
      expect(await insideArchive(join(archive, "inputs", "params.json"), archive)).toBe(true);
      expect(await insideArchive(join(archive, "..", "params.json"), archive)).toBe(false);
      expect(await insideArchive(archive + "-sibling/params.json", archive)).toBe(false);
      // An uppercase scheme is a relative local path to the reader, so it is to the guard too.
      expect(await insideArchive("HTTPS://../..params.json", archive, archive)).toBe(true);
      expect(await insideArchive("HTTPS://../inputs/params.json", archive, join(archive, "inputs"))).toBe(true);
    } finally { rmSync(archive, { recursive: true, force: true }); }
    const base = "https://host.example/a/";
    for (const url of ["https://host.example/%61/inputs/params.json", "https://host.example/A/params.json",
      "https://HOST.example:443/a/params.json", "https://host.example/published/params.json"])
      expect(await insideArchive(url, base)).toBe(true);
    expect(await insideArchive("https://other.example/a/params.json", base)).toBe(false);
    expect(await insideArchive("/tmp/params.json", base)).toBe(false);
    expect(await insideArchive("https://host.example/a/params.json", "/tmp/archive")).toBe(false);
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
  }, 120_000);
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
  }, 120_000);
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
      // A missing or garbled output file is the snapshot's fault, never UNAVAILABLE.
      const rejectedPath = join(out, "rejected.json"), rejectedBytes = readFileSync(rejectedPath);
      rmSync(rejectedPath);
      const noRejected = run("verify", "--manifest", manifestPath);
      expect(noRejected.status).toBe(1);
      expect(noRejected.stdout).toContain('"fault":"threshold_miscalculation"');
      writeFileSync(rejectedPath, "network timeout");
      const garbled = run("verify", "--manifest", manifestPath);
      expect(garbled.status).toBe(1);
      expect(garbled.stdout).toContain("threshold output unreadable: rejected.json");
      rmSync(rejectedPath);
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      manifest.root = manifest.root.slice(0, -1) + (manifest.root.endsWith("0") ? "1" : "0");
      writeFileSync(manifestPath, JSON.stringify(manifest));
      const badRoot = run("verify", "--manifest", manifestPath);
      expect(badRoot.status).toBe(1);
      expect(badRoot.stdout).toContain('"fault":"root_mismatch"');
      writeFileSync(rejectedPath, rejectedBytes);
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
      // A re-sealed change to committed Observation bytes is fatal, not a dropped observation.
      const envelopePath = join(out, "inputs/envelopes.json");
      const archived = JSON.parse(readFileSync(envelopePath, "utf8")) as Envelope[];
      const observation = Buffer.from(archived[0].observations[0].signedObservation, "base64");
      observation[observation.length - 1] ^= 1;
      archived[0].observations[0].signedObservation = observation.toString("base64");
      const envelopeBytes = Buffer.from(JSON.stringify(archived, null, 2) + "\n");
      writeFileSync(envelopePath, envelopeBytes);
      manifest.inputs.envelopes.sha256 = hex(sha(envelopeBytes));
      writeFileSync(manifestPath, JSON.stringify(manifest));
      const corrupted = run("verify", "--manifest", manifestPath);
      expect(corrupted.status).toBe(1);
      expect(corrupted.stdout).toContain('"fault":"invalid_signature"');
      expect(corrupted.stdout).toContain("Observation digest mismatch against commitment");
    } finally { rmSync(out, { recursive: true, force: true }); }
  }, 120_000);
  const checkRpc = async (liveOnly: boolean, rangeOnly = false) => {
    const out = mkdtempSync(join(tmpdir(), "mizar-rpc-test-"));
    const contract = "0x00000000000000000000000000000000000000c1";
    const registries = { eventRegistry: "0x00000000000000000000000000000000000000e1",
      definitionRegistry: "0x00000000000000000000000000000000000000d1",
      commitmentRegistry: "0x00000000000000000000000000000000000000a1" };
    const [page] = pages, admission = page.admission, anchor = page.commitments[0].anchor;
    const abi = AbiCoder.defaultAbiCoder(), word = (value: string | number) => zeroPadValue(toBeHex(value), 32);
    const cutoff = params.snapshot.cutoffBlock, rangeCap = rangeOnly ? 10 : 1_500;
    const registrationBlock = rangeOnly ? 80 : 10;
    let head = rangeOnly ? 110 : 5_000, getLogsCalls = 0;
    let posted = { root: "", manifestDigest: "", cutoffBlock: cutoff };
    let postedLogPresent = true, anchorBlock = anchors[anchor.commitmentDigest];
    let extraCommitment = false, junkCommitment = false, extraDefinition = false, rpcDown = false;
    let commitmentPresent = true, foreignRecorder = false;
    const requestedFroms: number[] = [];
    const log = (address: string, block: number, topics: string[], data: string) => ({
      address, blockNumber: toBeHex(block), blockHash: "0x" + "11".repeat(32),
      transactionHash: "0x" + "22".repeat(32), transactionIndex: "0x0", logIndex: "0x0", removed: false, topics, data });
    // Offline JSON-RPC stub: the three registry events, the cutoff block and one RootPosted log.
    const logsFor = (topic0: string) => {
      if (topic0 === id("EventRegistered(bytes32,address,address,bytes32,uint64)"))
        return [log(registries.eventRegistry, registrationBlock, [topic0, "0x" + page.context,
          zeroPadValue("0x" + admission.anchorRegistration.registrar, 32),
          zeroPadValue("0x" + admission.anchorRegistration.operator, 32)],
        abi.encode(["bytes32", "uint64"], ["0x" + admission.anchorRegistration.keySetDigest,
          admission.anchorRegistration.registeredAt]))];
      if (topic0 === id("EventDefinitionAnchored(bytes32,uint64,bytes32,bytes32,uint64,uint64,uint64)")) {
        const d = admission.definitionAnchor;
        const definition = (sequence: number, digest: string, previous: string, block: number) =>
          log(registries.definitionRegistry, block, [topic0, "0x" + page.context, word(sequence), "0x" + digest],
            abi.encode(["bytes32", "uint64", "uint64", "uint64"], ["0x" + previous, d.validFrom, d.validUntil, d.anchoredAt]));
        return [definition(d.sequence, d.definitionDigest, d.previousDefinitionDigest, rangeOnly ? 85 : 20),
          ...(extraDefinition ? [definition(d.sequence + 1, "cd".repeat(32), d.definitionDigest, 30)] : [])];
      }
      if (topic0 === id("ObservationCommitmentRecorded(bytes32,uint64,bytes32,bytes32,address,uint64)")) {
        const commitment = (sequence: number, digest: string, previous: string, block: number,
          recorder = "0x" + admission.anchorRegistration.operator) =>
          log(registries.commitmentRegistry, block, [topic0, "0x" + page.context, word(sequence), "0x" + digest],
            abi.encode(["bytes32", "address", "uint64"], ["0x" + previous, recorder, anchor.committedAt]));
        return [...(commitmentPresent ? [commitment(anchor.sequence, anchor.commitmentDigest,
          anchor.previousCommitmentDigest, anchorBlock,
          foreignRecorder ? "0x" + "99".repeat(20) : "0x" + admission.anchorRegistration.operator)] : []),
          ...(extraCommitment ? [commitment(2, "ab".repeat(32), anchor.commitmentDigest, cutoff - 5)] : []),
          ...(junkCommitment ? [commitment(2, "ef".repeat(32), anchor.commitmentDigest, cutoff - 4,
            "0x" + "99".repeat(20))] : [])];
      }
      return !postedLogPresent ? [] : [log(contract, cutoff + 5, [topic0, word(params.snapshot.id)],
        abi.encode(["bytes32", "bytes32", "uint64"], [posted.root, posted.manifestDigest, posted.cutoffBlock]))];
    };
    // Like public RPCs, the stub rejects wide getLogs ranges, so the reader must page.
    const getLogs = (filter: { fromBlock: string; toBlock: string; topics: string[] }) => {
      const from = Number(filter.fromBlock), to = filter.toBlock === "latest" ? head : Number(filter.toBlock);
      getLogsCalls++;
      requestedFroms.push(from);
      if (rpcDown) return { error: { code: -32603, message: "internal error at https://rpc.example/secret-test-token" } };
      if (to - from + 1 > rangeCap) return { error: { code: -32005, message: "block range too large" } };
      return { result: logsFor(filter.topics[0]).filter(l => Number(l.blockNumber) >= from && Number(l.blockNumber) <= to) };
    };
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", chunk => { body += chunk; });
      req.on("end", () => {
        const request = JSON.parse(body);
        const answer = (r: { id: number; method: string; params: any[] }) => ({ jsonrpc: "2.0", id: r.id,
          ...(r.method === "eth_getLogs" ? getLogs(r.params[0]) : { result:
            r.method === "eth_chainId" ? toBeHex(params.chainId)
            : r.method === "eth_blockNumber" ? toBeHex(head)
            : r.method === "eth_getBlockByNumber" ? {
              number: r.params[0], hash: "0x" + "33".repeat(32), parentHash: "0x" + "44".repeat(32),
              timestamp: toBeHex(params.snapshot.cutoffTimestamp), nonce: "0x0000000000000000",
              difficulty: "0x0", gasLimit: "0x1c9c380", gasUsed: "0x0", baseFeePerGas: "0x1",
              miner: "0x" + "00".repeat(20), extraData: "0x", transactions: [] } : null }) });
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(Array.isArray(request) ? request.map(answer) : answer(request)));
      });
    });
    await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
    const rpc = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const liveEvidence = join(out, "live-envelopes.json");
    writeFileSync(liveEvidence, JSON.stringify(page));
    const fetchStub = join(out, "fetch-stub.mjs");
    writeFileSync(fetchStub, `import { readFileSync } from "node:fs";
const original = globalThis.fetch;
globalThis.fetch = (url, init) => String(url).startsWith("https://evidence.example/")
  ? Promise.resolve(new Response(readFileSync(${JSON.stringify(liveEvidence)}), { status: 200 }))
  : original(url, init);
`);
    // Async spawn: spawnSync would block the stub server in this process.
    const run = (...args: string[]) => new Promise<{ status: number | null; stdout: string; stderr: string }>(done => {
      const child = spawn("pnpm", ["mizar", ...args],
        { cwd: root, env: { ...process.env, MIZAR_TEST_RPC: rpc,
          NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import=${JSON.stringify(fetchStub)}` } });
      let stdout = "", stderr = "";
      child.stdout.on("data", chunk => { stdout += chunk; });
      child.stderr.on("data", chunk => { stderr += chunk; });
      child.on("close", status => done({ status, stdout, stderr }));
    });
    const fixtures = join(root, "test/fixtures");
    const published = { ...params, ...registries, evidenceSource: join(fixtures, "envelopes.json"),
      credentialsSource: join(fixtures, "credentials.json"), anchorBlocksSource: join(fixtures, "anchor-blocks.json"),
      pendingSource: undefined };
    const trustedParams = join(out, "published-params.json");
    writeFileSync(trustedParams, JSON.stringify(published));
    // Evaluate as the poster would, with possibly altered parameters, and post that result.
    const evaluateAs = async (name: string, changes: Record<string, unknown> = {}) => {
      const file = join(out, name + "-params.json"), dir = join(out, name);
      writeFileSync(file, JSON.stringify({ ...published, ...changes }));
      const evaluated = await run("evaluate", "--params", file, "--out", dir);
      expect(evaluated.status).toBe(0);
      const receipt = JSON.parse(evaluated.stdout.trim().split("\n").at(-1)!);
      posted = { root: receipt.root, manifestDigest: receipt.manifestDigest, cutoffBlock: cutoff };
      return { manifest: join(dir, "manifest.json"), receipt };
    };
    const trust = (overrides: Record<string, string>) => Object.entries({ "trusted-params": trustedParams,
      "chain-id": String(params.chainId), "event-registry": registries.eventRegistry,
      "definition-registry": registries.definitionRegistry, "commitment-registry": registries.commitmentRegistry,
      ...overrides }).flatMap(([k, v]) => ["--" + k, v]);
    const verifyOnChain = (manifest: string, overrides: Record<string, string> = {}) =>
      run("verify", "--manifest", manifest, "--rpc", rpc, "--contract", contract, ...trust(overrides));
    const expectFail = async (manifest: string, reason?: string, overrides: Record<string, string> = {}) => {
      const failed = await verifyOnChain(manifest, overrides);
      expect(failed.stdout).toContain('"fault":"root_mismatch"');
      expect(failed.status).toBe(1);
      if (reason) expect(failed.stdout).toContain(reason);
    };
    const expectUnavailable = async (manifest: string, reason: string, overrides: Record<string, string> = {}) => {
      const result = await verifyOnChain(manifest, overrides);
      expect(result.stdout).toContain('"result":"UNAVAILABLE"');
      expect(result.status).toBe(2);
      expect(result.stdout).toContain(reason);
    };
    try {
      if (rangeOnly) {
        const liveParams = join(out, "range-params.json");
        const live = { ...published, registrationBlock,
          evidenceSource: `https://evidence.example/v1/events/${page.context}/verification`,
          anchorBlocksSource: undefined };
        writeFileSync(liveParams, JSON.stringify(live));
        writeFileSync(trustedParams, JSON.stringify(live));
        const limits = { "min-log-span": "10", "max-log-calls": "200" };
        const evaluateLimited = (name: string, ...extra: string[]) => run("evaluate", "--params", liveParams,
          "--out", join(out, name), "--rpc", "env:MIZAR_TEST_RPC",
          "--min-log-span", "10", "--max-log-calls", "200", ...extra);
        const receiptOf = (result: { stdout: string }) => JSON.parse(result.stdout.trim().split("\n").at(-1)!);

        const evaluated = await evaluateLimited("limited");
        expect(evaluated.stdout, evaluated.stderr).toContain('"result":"EVALUATED"');
        expect(evaluated.status).toBe(0);
        const evaluationCalls = getLogsCalls;
        expect(evaluationCalls).toBeGreaterThan(3);
        expect(Math.min(...requestedFroms)).toBe(registrationBlock);
        const evaluatedReceipt = receiptOf(evaluated), manifest = join(out, "limited/manifest.json");
        expect(evaluatedReceipt.root).toBe("0x4e663e1d45553efdf5247a720b30f569a340fe2e7c4294501d04608160230fe9");
        posted = { root: evaluatedReceipt.root, manifestDigest: evaluatedReceipt.manifestDigest, cutoffBlock: cutoff };
        getLogsCalls = 0; requestedFroms.length = 0;
        const verified = await verifyOnChain(manifest, limits);
        expect(verified.stdout, verified.stderr).toContain('"result":"PASS"');
        expect(verified.status).toBe(0);
        expect(Math.min(...requestedFroms)).toBe(registrationBlock);
        const verificationCalls = getLogsCalls;

        // The budget is shared across registry reads and RootPosted, including rejected ranges.
        getLogsCalls = 0;
        const capped = await evaluateLimited("capped", "--max-log-calls", String(evaluationCalls - 1));
        expect(capped.status).toBe(2);
        expect(capped.stdout).toContain('"result":"UNAVAILABLE"');
        expect(capped.stdout).toContain(`more than ${evaluationCalls - 1} eth_getLogs calls`);
        expect(getLogsCalls).toBe(evaluationCalls - 1);
        expect(existsSync(join(out, "capped/manifest.json"))).toBe(false);
        getLogsCalls = 0;
        await expectUnavailable(manifest, `more than ${verificationCalls - 1} eth_getLogs calls`,
          { ...limits, "max-log-calls": String(verificationCalls - 1) });
        expect(getLogsCalls).toBe(verificationCalls - 1);
        await expectUnavailable(manifest, "RPC unavailable", { "max-log-calls": "200" });
        expect((await evaluateLimited("default-span", "--min-log-span", "100")).stdout)
          .toContain('"result":"UNAVAILABLE"');

        // Explicit bounds win, and verify never takes the default from the archive.
        await expectUnavailable(manifest, "event registration unavailable", { ...limits, "from-block": "81" });
        expect((await evaluateLimited("late-bound", "--from-block", "81")).stdout)
          .toContain("event registration unavailable");
        writeFileSync(trustedParams, JSON.stringify({ ...live, registrationBlock: 0 }));
        requestedFroms.length = 0;
        expect((await verifyOnChain(manifest, limits)).status).toBe(0);
        expect(requestedFroms[0]).toBe(0);
        writeFileSync(trustedParams, JSON.stringify({ ...live, registrationBlock: 81 }));
        await expectUnavailable(manifest, "event registration unavailable", limits);
        expect((await verifyOnChain(manifest, { ...limits, "from-block": "80" })).status).toBe(0);
        writeFileSync(liveParams, JSON.stringify({ ...live, registrationBlock: undefined }));
        requestedFroms.length = 0;
        expect((await evaluateLimited("fallback-bound")).status).toBe(0);
        expect(requestedFroms[0]).toBe(0);
        writeFileSync(liveParams, JSON.stringify({ ...live, registrationBlock: -1 }));
        expect((await evaluateLimited("invalid-bound")).stdout).toContain('"result":"UNAVAILABLE"');
        writeFileSync(liveParams, JSON.stringify(live));
        writeFileSync(trustedParams, JSON.stringify({ ...live, registrationBlock: "80" }));
        await expectUnavailable(manifest, "registrationBlock", limits);

        for (const [flag, value] of [["--min-log-span", "0"], ["--min-log-span", "1.5"],
          ["--max-log-calls", "-1"], ["--max-log-calls", "invalid"],
          ["--max-log-calls", "9007199254740992"]]) {
          getLogsCalls = 0;
          const invalid = await evaluateLimited("invalid-limit", flag, value);
          expect(invalid.status).toBe(2);
          expect(invalid.stdout).toContain('"result":"UNAVAILABLE"');
          expect(getLogsCalls).toBe(0);
        }
        // Transport settings cannot change the fixture output bytes or manifest digest.
        for (const extra of [[], ["--min-log-span", "10", "--max-log-calls", "200"]]) {
          const fixtureRun = await run("evaluate", "--params", "test/fixtures/params.json",
            "--out", join(out, "fixture"), ...extra);
          expect(fixtureRun.status).toBe(0);
          expect(receiptOf(fixtureRun).root).toBe("0x4e663e1d45553efdf5247a720b30f569a340fe2e7c4294501d04608160230fe9");
          expect(receiptOf(fixtureRun).manifestDigest)
            .toBe("0x1f61fff1d38a9944ad53b6562423d5b9b33f59e067dece272b58087c1077351a");
        }
        return;
      }
      if (liveOnly) {
        const liveParams = join(out, "live-params.json"), liveOut = join(out, "live");
        writeFileSync(liveParams, JSON.stringify({ ...published,
          evidenceSource: `https://evidence.example/v1/events/${page.context}/verification`,
          anchorBlocksSource: undefined, snapshot: { id: 1, cutoffBlock: cutoff } }));
        const evaluateLive = (...extra: string[]) => run("evaluate", "--params", liveParams,
          "--out", liveOut, "--rpc", "env:MIZAR_TEST_RPC", "--from-block", "10", ...extra);
        requestedFroms.length = 0;
        const live = await evaluateLive();
        expect(live.stdout, live.stderr).toContain('"result":"EVALUATED"');
        expect(live.status).toBe(0);
        expect(JSON.parse(readFileSync(join(liveOut, "inputs/anchor-blocks.json"), "utf8"))).toEqual(anchors);
        expect(requestedFroms.length).toBeGreaterThan(3);
        expect(requestedFroms.every(from => from >= 10)).toBe(true);
        const liveManifest = JSON.parse(readFileSync(join(liveOut, "manifest.json"), "utf8"));
        expect(liveManifest.parameters.snapshot.cutoffTimestamp).toBe(params.snapshot.cutoffTimestamp);
        expect(JSON.stringify(liveManifest)).not.toContain(rpc);
        expect(liveManifest.parameters.rpcUrl).toBeUndefined();
        expect(liveManifest.trust.anchorBlockMapping).toContain("ObservationCommitmentRecorded");
        const legacyParams = join(out, "legacy-rpc-params.json");
        writeFileSync(legacyParams, JSON.stringify({ ...published, rpcUrl: rpc }));
        const legacyOut = join(out, "legacy-rpc");
        expect((await run("evaluate", "--params", legacyParams, "--out", legacyOut)).status).toBe(0);
        for (const file of ["manifest.json", "inputs/params.json"])
          expect(readFileSync(join(legacyOut, file), "utf8")).not.toContain(rpc);
        expect((await run("verify", "--manifest", join(legacyOut, "manifest.json"))).status).toBe(0);
        expect((await evaluateLive("--from-block", "-1")).status).toBe(2);
        expect((await evaluateLive("--from-block", "15")).stdout).toContain("event registration unavailable");
        expect((await evaluateLive("--rpc", "env:MIZAR_MISSING_RPC")).stdout).toContain('"result":"UNAVAILABLE"');
        for (const foreign of [false, true]) {
          commitmentPresent = foreign;
          foreignRecorder = foreign;
          const missing = await evaluateLive();
          expect(missing.status).toBe(2);
          expect(missing.stdout).toContain('"result":"UNAVAILABLE"');
          expect(missing.stdout).toContain("commitment anchor not backed by registry event");
        }
        commitmentPresent = true; foreignRecorder = false;
        junkCommitment = true;
        expect((await evaluateLive()).status).toBe(0);
        junkCommitment = false;
        anchorBlock = cutoff + 1;
        const afterCutoff = await evaluateLive();
        expect(afterCutoff.status).toBe(0);
        expect(afterCutoff.stdout).toContain('"eligible":0');
        anchorBlock = anchors[anchor.commitmentDigest];
        rpcDown = true;
        const failure = await evaluateLive();
        expect(failure.stdout).toContain('"result":"UNAVAILABLE"');
        expect(failure.stdout).not.toContain("secret-test-token");
        expect(failure.stderr).not.toContain("secret-test-token");
        rpcDown = false;
        head = 2_000_000;
        expect((await evaluateLive()).stdout).toContain("more than 500 eth_getLogs calls");
        head = 5_000;
        const honest = await evaluateAs("environment-rpc");
        expect((await run("verify", "--manifest", honest.manifest, "--rpc", "env:MIZAR_TEST_RPC",
          "--contract", contract, ...trust({}))).stdout).toContain('"result":"PASS"');
        return;
      }

      // Without verifier-supplied trust anchors an on-chain check never passes.
      const plain = join(out, "plain");
      expect((await run("evaluate", "--params", "test/fixtures/params.json", "--out", plain)).status).toBe(0);
      const unbacked = await run("verify", "--manifest", join(plain, "manifest.json"), "--rpc", rpc, "--contract", contract);
      expect(unbacked.status).toBe(2);
      expect(unbacked.stdout).toContain('"result":"UNAVAILABLE"');
      expect(unbacked.stdout).toContain("--trusted-params");

      const honest = await evaluateAs("honest");
      const pass = await verifyOnChain(honest.manifest);
      expect(pass.stdout).toContain('"result":"PASS"');
      expect(pass.status).toBe(0);

      await expectUnavailable(honest.manifest, "trusted parameters name another chain ID than --chain-id",
        { "chain-id": "1" });
      const otherChainParams = join(out, "other-chain-params.json");
      writeFileSync(otherChainParams, JSON.stringify({ ...published, chainId: 1 }));
      await expectUnavailable(honest.manifest, "RPC chain ID 11155111 is not the trusted chain ID 1",
        { "chain-id": "1", "trusted-params": otherChainParams });
      // The archive's own params file is poster-written and never accepted as trusted.
      await expectUnavailable(honest.manifest, "--trusted-params is inside the archive",
        { "trusted-params": join(out, "honest", "inputs", "params.json") });
      const dotted = join(out, "honest", "..params.json");
      writeFileSync(dotted, readFileSync(trustedParams));
      await expectUnavailable(honest.manifest, "--trusted-params is inside the archive", { "trusted-params": dotted });
      const publishedSha = hex(sha(readFileSync(trustedParams)));
      expect((await verifyOnChain(honest.manifest, { "trusted-params-sha256": publishedSha })).stdout)
        .toContain('"result":"PASS"');
      await expectUnavailable(honest.manifest, "do not match --trusted-params-sha256",
        { "trusted-params-sha256": "00".repeat(32) });
      const nullEntry = join(out, "null-entry-credentials.json");
      writeFileSync(nullEntry, JSON.stringify({ ...credentials, credentials: [...credentials.credentials, null] }));
      await expectUnavailable(honest.manifest, "trusted credential list unavailable", { "credentials-source": nullEntry });
      await expectFail(honest.manifest, "different commitmentRegistry",
        { "commitment-registry": "0x00000000000000000000000000000000000000a2" });
      await expectUnavailable(honest.manifest, "trusted credential list unavailable",
        { "credentials-source": join(out, "absent.json") });
      const flip = (value: string) => value.slice(0, -1) + (parseInt(value.slice(-1), 16) ^ 1).toString(16);
      const good = { ...posted };
      for (const [change, reason] of [
        [{ manifestDigest: flip(good.manifestDigest) }, "manifest_digest_mismatch"],
        [{ cutoffBlock: cutoff + 1 }, "cutoff_block_mismatch"],
        [{ root: flip(good.root) }, undefined],
      ] as const) {
        posted = Object.assign({ ...good }, change);
        await expectFail(honest.manifest, reason);
      }
      posted = good;
      // The sidecar says block 90; the registry anchored the commitment after the cutoff.
      anchorBlock = cutoff + 1;
      await expectFail(honest.manifest, "archived anchor block mapping differs from chain");
      anchorBlock = anchors[anchor.commitmentDigest];
      extraCommitment = true;
      await expectFail(honest.manifest, "commitment anchored before cutoff missing from evidence");
      extraCommitment = false;
      // A newer definition anchored by the cutoff would make the archived admission stale.
      extraDefinition = true;
      await expectFail(honest.manifest, "latest definition anchor differs from chain");
      extraDefinition = false;
      // Recorders other than the registered operator cannot make the snapshot look incomplete.
      junkCommitment = true;
      expect((await verifyOnChain(honest.manifest)).stdout).toContain('"result":"PASS"');
      junkCommitment = false;
      // A non-range RPC error is not retried by splitting ranges.
      rpcDown = true;
      getLogsCalls = 0;
      await expectUnavailable(honest.manifest, "RPC unavailable");
      expect(getLogsCalls).toBe(1);
      rpcDown = false;
      await expectUnavailable(honest.manifest, "event registration unavailable", { "from-block": "15" });
      head = 2_000_000;
      await expectUnavailable(honest.manifest, "more than 500 eth_getLogs calls");
      head = 5_000;
      postedLogPresent = false;
      await expectUnavailable(honest.manifest, "RootPosted event unavailable");
      postedLogPresent = true;

      // m1: the poster drops a verified participant's credential from its input.
      const list = structuredClone(credentials);
      list.credentials = list.credentials.filter(c => c.eventKeyAddress !== credentials.credentials[0].eventKeyAddress);
      const reduced = join(out, "reduced-credentials.json");
      writeFileSync(reduced, JSON.stringify(list));
      const m1 = await evaluateAs("m1", { credentialsSource: reduced });
      expect(m1.receipt.root).not.toBe(honest.receipt.root);
      await expectFail(m1.manifest, "credential verified before cutoff missing from inputs");
      // Deleting an output file from a tampered archive must not turn FAIL into UNAVAILABLE.
      rmSync(join(out, "m1", "rejected.json"));
      await expectFail(m1.manifest, "credential verified before cutoff missing from inputs");
      // m2: the poster pins its own attestation key; m4: the poster lowers the thresholds.
      const m2 = await evaluateAs("m2", { credentialsPublicKey: "0x" + "11".repeat(32) });
      await expectFail(m2.manifest, "different credentialsPublicKey");
      const m4 = await evaluateAs("m4", { minPartners: 1, minWindowsPerPartner: 1 });
      await expectFail(m4.manifest, "different minPartners");
    } finally {
      server.close();
      rmSync(out, { recursive: true, force: true });
    }
  };
  it("configures RPC log ranges and budgets with trusted registration bounds", () => checkRpc(false, true), 240_000);
  it("maps live anchors using registered operator events and private RPC input", () => checkRpc(true), 240_000);
  it("checks RootPosted, registries and trusted parameters against a fixture JSON-RPC stub",
    () => checkRpc(false), 600_000);
});
