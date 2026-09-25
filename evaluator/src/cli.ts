import { readFile, mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { JsonRpcProvider, id } from "ethers";
import { StandardMerkleTree } from "@openzeppelin/merkle-tree";
import { evaluateRule, type CredentialList, type Parameters } from "./evaluate.js";
import { verifyEvidence, type Envelope } from "./evidence.js";
import { digestBytes, loadEnvelopes, readSource, writeJson } from "./io.js";

type Args = Record<string, string>;
function argsOf(input: string[]): Args {
  const args: Args = {};
  for (let i = 0; i < input.length; i += 2) {
    if (!input[i].startsWith("--") || input[i + 1] === undefined) throw new Error("expected --option value");
    args[input[i].slice(2)] = input[i + 1];
  }
  return args;
}
async function inputs(paramsFile: string) {
  const paramsPath = resolve(paramsFile), base = dirname(paramsPath);
  const paramsBytes = await readFile(paramsPath);
  const params = JSON.parse(paramsBytes.toString()) as Parameters;
  const pages = await loadEnvelopes(params.evidenceSource, base, params.eventId);
  const evidenceBytes = Buffer.from(JSON.stringify(pages, null, 2) + "\n");
  const credentialBytes = await readSource(params.credentialsSource, base);
  const anchorBytes = await readSource(params.anchorBlocksSource, base);
  return { params, paramsBytes, evidenceBytes, credentialBytes, anchorBytes,
    pages, credentials: JSON.parse(credentialBytes.toString()) as CredentialList,
    anchorBlocks: JSON.parse(anchorBytes.toString()) as Record<string, number> };
}
function resultFor(i: Awaited<ReturnType<typeof inputs>>) {
  const evidence = verifyEvidence(i.pages, i.params.eventId, i.params.snapshot.cutoffBlock, i.anchorBlocks);
  return { evidence, evaluation: evaluateRule(i.params, evidence, i.credentials) };
}
async function evaluate(paramsFile: string, out: string) {
  const i = await inputs(paramsFile), { evidence, evaluation } = resultFor(i);
  const dir = resolve(out);
  await mkdir(join(dir, "inputs"), { recursive: true });
  await Promise.all([
    writeFile(join(dir, "inputs/params.json"), i.paramsBytes),
    writeFile(join(dir, "inputs/envelopes.json"), i.evidenceBytes),
    writeFile(join(dir, "inputs/credentials.json"), i.credentialBytes),
    writeFile(join(dir, "inputs/anchor-blocks.json"), i.anchorBytes),
  ]);
  const eligible = { addresses: evaluation.eligible.map(x => x.address), explanations: evaluation.eligible };
  const rejected = { keys: evaluation.rejected, rpidConflicts: evaluation.rpidConflicts,
    invalidObservations: evaluation.invalidObservations, invalidCredentials: evaluation.invalidCredentials };
  await writeJson(join(dir, "eligible.json"), eligible);
  await writeJson(join(dir, "rejected.json"), rejected);
  for (const [address, proof] of Object.entries(evaluation.proofs))
    await writeJson(join(dir, "proofs", address.toLowerCase() + ".json"),
      { address, root: evaluation.root, proof });
  const manifest = {
    evaluatorVersion: i.params.evaluatorVersion, parameters: i.params,
    inputs: {
      params: { path: "inputs/params.json", sha256: digestBytes(i.paramsBytes) },
      envelopes: { path: "inputs/envelopes.json", sha256: digestBytes(i.evidenceBytes) },
      credentials: { path: "inputs/credentials.json", sha256: digestBytes(i.credentialBytes) },
      anchorBlocks: { path: "inputs/anchor-blocks.json", sha256: digestBytes(i.anchorBytes) },
      observationDigests: evidence.inputDigests, credentialListDigest: evaluation.credentialDigest,
      commitmentDigests: evidence.commitmentDigests, anchorRange: evidence.anchorRange,
    },
    root: evaluation.root,
    outputDigests: { eligible: digestBytes(Buffer.from(JSON.stringify(eligible))),
      rejected: digestBytes(Buffer.from(JSON.stringify(rejected))) },
    trust: { credentialsPublicKey: i.params.credentialsPublicKey,
      anchorBlockMapping: "supplied sidecar; compare against chain before settlement" },
  };
  await writeJson(join(dir, "manifest.json"), manifest);
  console.log(JSON.stringify({ result: "EVALUATED", root: evaluation.root,
    eligible: evaluation.eligible.length, rejected: evaluation.rejected.length,
    invalidObservations: evaluation.invalidObservations.length, out: dir }));
}
async function verify(manifestPath: string, rpc?: string, contract?: string) {
  const path = resolve(manifestPath), dir = dirname(path);
  let manifest: any;
  try { manifest = JSON.parse((await readFile(path)).toString()); }
  catch (error) { console.log(JSON.stringify({ result: "UNAVAILABLE", reason: String(error) })); return 2; }
  try {
    const readInput = async (name: string) => {
      const descriptor = manifest.inputs[name];
      if (!/^inputs\/[a-z-]+\.json$/.test(descriptor.path)) throw new Error("unsafe manifest input path");
      const b = await readFile(join(dir, descriptor.path));
      if (digestBytes(b) !== descriptor.sha256) throw new Error(`input digest mismatch: ${name}`);
      return b;
    };
    const [paramsBytes, evidenceBytes, credentialBytes, anchorBytes] = await Promise.all(
      ["params", "envelopes", "credentials", "anchorBlocks"].map(readInput));
    const params = JSON.parse(paramsBytes.toString()) as Parameters;
    if (JSON.stringify(params) !== JSON.stringify(manifest.parameters))
      throw new Error("parameters altered");
    const evidence = verifyEvidence(JSON.parse(evidenceBytes.toString()) as Envelope[],
      params.eventId, params.snapshot.cutoffBlock, JSON.parse(anchorBytes.toString()));
    const evaluation = evaluateRule(params, evidence, JSON.parse(credentialBytes.toString()));
    if (evaluation.root.toLowerCase() !== String(manifest.root).toLowerCase()) {
      console.log(JSON.stringify({ result: "FAIL", fault: "root_mismatch" })); return 1;
    }
    if (JSON.stringify(evidence.inputDigests) !== JSON.stringify(manifest.inputs.observationDigests) ||
        JSON.stringify(evidence.commitmentDigests) !== JSON.stringify(manifest.inputs.commitmentDigests) ||
        evaluation.credentialDigest !== manifest.inputs.credentialListDigest ||
        JSON.stringify(evidence.anchorRange) !== JSON.stringify(manifest.inputs.anchorRange))
      throw new Error("manifest input summary mismatch");
    const eligible = { addresses: evaluation.eligible.map(x => x.address), explanations: evaluation.eligible };
    const rejected = { keys: evaluation.rejected, rpidConflicts: evaluation.rpidConflicts,
      invalidObservations: evaluation.invalidObservations, invalidCredentials: evaluation.invalidCredentials };
    if (digestBytes(Buffer.from(JSON.stringify(eligible))) !== manifest.outputDigests.eligible ||
        digestBytes(Buffer.from(JSON.stringify(rejected))) !== manifest.outputDigests.rejected)
      throw new Error("threshold output mismatch");
    const savedEligible = JSON.parse((await readFile(join(dir, "eligible.json"))).toString());
    const savedRejected = JSON.parse((await readFile(join(dir, "rejected.json"))).toString());
    if (JSON.stringify(savedEligible) !== JSON.stringify(eligible) ||
        JSON.stringify(savedRejected) !== JSON.stringify(rejected))
      throw new Error("threshold output mismatch");
    for (const [address, proof] of Object.entries(evaluation.proofs)) {
      const saved = JSON.parse((await readFile(join(dir, "proofs", address.toLowerCase() + ".json"))).toString());
      if (JSON.stringify(saved.proof) !== JSON.stringify(proof) ||
          !StandardMerkleTree.verify(evaluation.root, ["address"], [address], saved.proof))
        throw new Error("proof mismatch");
    }
    if (rpc || contract) {
      if (!rpc || !contract) throw new Error("both --rpc and --contract required");
      const provider = new JsonRpcProvider(rpc, params.chainId);
      const data = id("roots(uint64)").slice(0, 10) +
        BigInt(params.snapshot.id).toString(16).padStart(64, "0");
      const result = await provider.call({ to: contract, data });
      if (result.length < 66) throw new Error("contract roots(uint64) unavailable");
      if (result.slice(0, 66).toLowerCase() !== evaluation.root.toLowerCase()) {
        console.log(JSON.stringify({ result: "FAIL", fault: "root_mismatch" })); return 1;
      }
    }
    console.log(JSON.stringify({ result: "PASS" })); return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const fault = /signature|digest mismatch|bundle mismatch|Merkle inclusion|COSE|anchor|CBOR/i.test(message)
      ? "invalid_signature" : "threshold_miscalculation";
    console.log(JSON.stringify({ result: "FAIL", fault, reason: message })); return 1;
  }
}
async function progress(paramsFile: string, key: string) {
  const i = await inputs(paramsFile), { evaluation } = resultFor(i);
  const address = key.toLowerCase();
  const eligible = evaluation.eligible.find(x => x.address.toLowerCase() === address);
  const rejected = evaluation.rejected.find(x => x.address.toLowerCase() === address);
  if (!eligible && !rejected) throw new Error("unknown event key");
  console.log(JSON.stringify({ provisional: true, key, reached: !!eligible,
    partners: eligible?.partners ?? [], reason: rejected?.reason ?? null }));
}
async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const a = argsOf(rest);
  if (command === "evaluate" && a.params && a.out) await evaluate(a.params, a.out);
  else if (command === "verify" && a.manifest) process.exitCode = await verify(a.manifest, a.rpc, a.contract);
  else if (command === "progress" && a.params && a.key) await progress(a.params, a.key);
  else throw new Error("usage: mizar evaluate --params p.json --out dir | verify --manifest path [--rpc url --contract addr] | progress --params p.json --key addr");
}
main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 2; });
