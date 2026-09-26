import { readFile, mkdir, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { StandardMerkleTree } from "@openzeppelin/merkle-tree";
import { evaluateRule, verifyCredentials, type Credential, type CredentialList, type Parameters } from "./evaluate.js";
import { verifyEvidence, type Envelope } from "./evidence.js";
import { UnavailableError, digestBytes, loadEnvelopes, readSource, sourcePath, writeJson } from "./io.js";
import { checkAdmissionRegistries, readAnchorsFromRegistry, readChainId, readPostedRoot } from "./chain.js";

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
  let paramsBytes = await readFile(paramsPath);
  const params = JSON.parse(paramsBytes.toString()) as Parameters;
  const live = sourcePath(params.evidenceSource, base).startsWith("https://");
  if (live && (!params.rpcUrl || !params.eventRegistry ||
      !params.definitionRegistry || !params.commitmentRegistry))
    throw new Error("live snapshot requires RPC and all three registry addresses");
  const pages = await loadEnvelopes(params.evidenceSource, base, params.eventId);
  const evidenceBytes = Buffer.from(JSON.stringify(pages, null, 2) + "\n");
  const credentialBytes = await readSource(params.credentialsSource, base);
  let anchorBytes: Buffer;
  if (live) {
    await checkAdmissionRegistries(params.rpcUrl!, params.chainId, params.eventRegistry!,
      params.definitionRegistry!, params.eventId, params.snapshot.cutoffBlock, pages);
    const anchored = await readAnchorsFromRegistry(params.rpcUrl!, params.commitmentRegistry!,
      params.eventId, params.chainId, params.snapshot.cutoffBlock, pages);
    params.snapshot.cutoffTimestamp = anchored.cutoffTimestamp;
    paramsBytes = Buffer.from(JSON.stringify(params, null, 2) + "\n");
    anchorBytes = Buffer.from(JSON.stringify(anchored.mapping, null, 2) + "\n");
  } else {
    if (!params.anchorBlocksSource) throw new Error("missing trusted anchor block mapping");
    anchorBytes = await readSource(params.anchorBlocksSource, base);
  }
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
  const manifestPath = join(dir, "manifest.json");
  await writeJson(manifestPath, manifest);
  const manifestDigest = "0x" + digestBytes(await readFile(manifestPath));
  console.log(JSON.stringify({ result: "EVALUATED", root: evaluation.root,
    eligible: evaluation.eligible.length, rejected: evaluation.rejected.length,
    invalidObservations: evaluation.invalidObservations.length, manifestDigest, out: dir }));
}
interface TrustedChain {
  chainId: number; eventRegistry: string; definitionRegistry: string; commitmentRegistry: string;
  paramsSource: string; paramsSha256?: string; credentialsSource?: string; fromBlock: number;
}
function trustedChain(a: Args): TrustedChain | undefined {
  const chainId = Number(a["chain-id"]), fromBlock = Number(a["from-block"] ?? 0);
  if (!Number.isSafeInteger(chainId) || chainId <= 0 || !Number.isSafeInteger(fromBlock) || fromBlock < 0 ||
      !a["event-registry"] || !a["definition-registry"] || !a["commitment-registry"] || !a["trusted-params"])
    return undefined;
  return { chainId, eventRegistry: a["event-registry"], definitionRegistry: a["definition-registry"],
    commitmentRegistry: a["commitment-registry"], paramsSource: a["trusted-params"],
    paramsSha256: a["trusted-params-sha256"], credentialsSource: a["credentials-source"], fromBlock };
}
// Fields of the published parameters that decide the result. Source locations are
// excluded: the archive records where the poster read from, not what was published.
const RULE_FIELDS: Array<[string, (p: any) => unknown]> = [
  ["evaluatorVersion", p => p.evaluatorVersion], ["eventId", p => String(p.eventId ?? "").toLowerCase()],
  ["chainId", p => p.chainId], ["minPartners", p => p.minPartners],
  ["minWindowsPerPartner", p => p.minWindowsPerPartner],
  ["credentialsPublicKey", p => String(p.credentialsPublicKey ?? "").toLowerCase()],
  ["snapshot.id", p => p.snapshot?.id], ["snapshot.cutoffBlock", p => p.snapshot?.cutoffBlock],
];
const signatureOf = (entry: Credential) => String(entry.attestation?.signature).toLowerCase();
// Entries of a list that verify on their own under the given parameters and cutoff.
function validEntries(list: CredentialList, params: Parameters): Credential[] {
  return list.credentials.filter(entry =>
    verifyCredentials({ eventId: list.eventId, credentials: [entry] }, params).accepted.size === 1);
}
type Receipt = { result: "PASS" } | { result: "FAIL"; fault: string; reason?: string } |
  { result: "UNAVAILABLE"; reason: string };
function report(receipt: Receipt): number {
  console.log(JSON.stringify(receipt));
  return receipt.result === "PASS" ? 0 : receipt.result === "FAIL" ? 1 : 2;
}
const unavailable = (reason: string) => report({ result: "UNAVAILABLE", reason });
const mismatch = (reason?: string) =>
  report(reason ? { result: "FAIL", fault: "root_mismatch", reason } : { result: "FAIL", fault: "root_mismatch" });
// The poster writes the archive, so trusted parameters read from inside it are not trusted.
async function insideArchive(source: string, archiveBase: string): Promise<boolean> {
  if (/^https:\/\//.test(source) || /^https:\/\//.test(archiveBase))
    return /^https:\/\//.test(source) && /^https:\/\//.test(archiveBase) &&
      new URL(source).href.startsWith(new URL(archiveBase).href);
  const real = (path: string) => realpath(path).catch(() => resolve(path));
  const inside = relative(await real(archiveBase), await real(resolve(source)));
  return !inside.startsWith("..") && !isAbsolute(inside);
}
// Checks the snapshot against the chain and sources the verifier chose. Returns an exit
// code when the receipt is decided here, or undefined when every check holds.
async function verifyOnChain(rpc: string, contract: string, trusted: TrustedChain | undefined,
  archiveBase: string, manifestBytes: Buffer, params: Parameters, pages: Envelope[],
  archiveMap: Record<string, number>, credentialBytes: Buffer, root: string): Promise<number | undefined> {
  if (!trusted)
    return unavailable("on-chain verification requires trusted --trusted-params, --chain-id, " +
      "--event-registry, --definition-registry and --commitment-registry");
  if (await insideArchive(trusted.paramsSource, archiveBase))
    return unavailable("--trusted-params is inside the archive; the poster writes that file, so use the " +
      "parameters published before the snapshot");
  let publishedBytes: Buffer, published: any;
  try {
    publishedBytes = await readSource(trusted.paramsSource, process.cwd());
    published = JSON.parse(publishedBytes.toString());
  } catch (error) { return unavailable(`trusted parameters unavailable: ${String(error)}`); }
  if (trusted.paramsSha256 !== undefined &&
      trusted.paramsSha256.toLowerCase().replace(/^0x/, "") !== digestBytes(publishedBytes))
    return unavailable("trusted parameters do not match --trusted-params-sha256");
  if (published?.chainId !== trusted.chainId) return unavailable("trusted parameters name another chain ID than --chain-id");
  const rpcChain = await readChainId(rpc);
  if (rpcChain !== trusted.chainId)
    return unavailable(`RPC chain ID ${rpcChain} is not the trusted chain ID ${trusted.chainId}`);
  const named = { chainId: params.chainId, eventRegistry: params.eventRegistry,
    definitionRegistry: params.definitionRegistry, commitmentRegistry: params.commitmentRegistry };
  for (const [field, value] of Object.entries(named)) {
    const expected = trusted[field as keyof typeof trusted];
    if (value !== undefined && String(value).toLowerCase() !== String(expected).toLowerCase())
      return mismatch(`parameters name a different ${field} than the trusted one`);
  }
  for (const [field, read] of RULE_FIELDS) {
    const expected = read(published);
    if (expected === undefined || expected === "") return unavailable(`trusted parameters lack ${field}`);
    if (JSON.stringify(read(params)) !== JSON.stringify(expected))
      return mismatch(`parameters name a different ${field} than the trusted one`);
  }
  try {
    await checkAdmissionRegistries(rpc, trusted.chainId, trusted.eventRegistry, trusted.definitionRegistry,
      params.eventId, params.snapshot.cutoffBlock, pages, trusted.fromBlock);
    const chain = await readAnchorsFromRegistry(rpc, trusted.commitmentRegistry,
      params.eventId, trusted.chainId, params.snapshot.cutoffBlock, pages, trusted.fromBlock);
    const sorted = (m: Record<string, number>) => JSON.stringify(Object.entries(m).sort());
    if (sorted(chain.mapping) !== sorted(archiveMap))
      throw new Error("archived anchor block mapping differs from chain");
    if (chain.cutoffTimestamp !== params.snapshot.cutoffTimestamp)
      throw new Error("cutoff timestamp differs from chain");
  } catch (error) {
    if (error instanceof UnavailableError) throw error;
    const reason = error instanceof Error ? error.message : String(error);
    if (!/differs from chain|missing from evidence|not backed by registry/.test(reason)) throw error;
    return mismatch(reason);
  }
  // The credential list only grows, so every entry the trusted source shows as valid
  // by the cutoff must be in the archive; otherwise a verified key was left out.
  const credentialsSource = trusted.credentialsSource ?? published.credentialsSource;
  if (!credentialsSource) return unavailable("no trusted credential source");
  const trustedBase = /^https:\/\//.test(trusted.paramsSource)
    ? new URL(".", trusted.paramsSource).toString() : dirname(resolve(trusted.paramsSource));
  let current: CredentialList;
  try {
    current = JSON.parse((await readSource(credentialsSource,
      trusted.credentialsSource ? process.cwd() : trustedBase)).toString());
    if (!Array.isArray(current?.credentials) ||
        !current.credentials.every(entry => entry && typeof entry === "object" && !Array.isArray(entry)))
      throw new Error("not a credential list of objects");
  } catch (error) { return unavailable(`trusted credential list unavailable: ${String(error)}`); }
  if (String(current.eventId).toLowerCase() !== params.eventId.toLowerCase())
    return unavailable("trusted credential list is for another event");
  const archived = new Set(validEntries(JSON.parse(credentialBytes.toString()), params).map(signatureOf));
  const omitted = validEntries(current, params).filter(entry => !archived.has(signatureOf(entry)));
  if (omitted.length)
    return mismatch(`credential verified before cutoff missing from inputs: ${omitted.map(e => e.eventKeyAddress).join(",")}`);
  const posted = await readPostedRoot(rpc, contract, trusted.chainId,
    params.snapshot.id, params.snapshot.cutoffBlock, trusted.fromBlock);
  if (posted.cutoffBlock !== params.snapshot.cutoffBlock) return mismatch("cutoff_block_mismatch");
  if (posted.manifestDigest.toLowerCase() !== ("0x" + digestBytes(manifestBytes)).toLowerCase())
    return mismatch("manifest_digest_mismatch");
  if (posted.root.toLowerCase() !== root.toLowerCase()) return mismatch();
  return undefined;
}
async function verify(manifestPath: string, rpc?: string, contract?: string, trusted?: TrustedChain) {
  const remote = manifestPath.startsWith("https://");
  const path = remote ? manifestPath : resolve(manifestPath);
  const dir = remote ? new URL(".", path).toString() : dirname(path);
  let manifest: any;
  let manifestBytes: Buffer;
  try {
    manifestBytes = await readSource(path, process.cwd());
    manifest = JSON.parse(manifestBytes.toString());
  } catch (error) { return unavailable(String(error)); }
  // Archive files are poster content: a missing or garbled file is a fault of the
  // snapshot. Only a transport failure while fetching a remote archive is unavailable.
  const readArchive = async (name: string) => {
    try { return await readSource(name, dir); }
    catch (error) {
      if (remote && error instanceof TypeError) throw new UnavailableError(`archive unreachable: ${error.message}`);
      throw new Error(`archive file unreadable: ${name}`);
    }
  };
  const parseArchive = (bytes: Buffer, name: string) => {
    try { return JSON.parse(bytes.toString()); } catch { throw new Error(`archive file is not JSON: ${name}`); }
  };
  try {
    if (rpc || contract) { if (!rpc || !contract) return unavailable("both --rpc and --contract required"); }
    const readInput = async (name: string) => {
      const descriptor = manifest.inputs?.[name];
      if (!/^inputs\/[a-z-]+\.json$/.test(descriptor?.path)) throw new Error("unsafe manifest input path");
      let b: Buffer;
      try { b = await readArchive(descriptor.path); }
      catch (error) {
        if (error instanceof UnavailableError) throw error;
        throw new Error(`input digest mismatch: ${name} is unreadable`);
      }
      if (digestBytes(b) !== descriptor.sha256) throw new Error(`input digest mismatch: ${name}`);
      return b;
    };
    const [paramsBytes, evidenceBytes, credentialBytes, anchorBytes] = await Promise.all(
      ["params", "envelopes", "credentials", "anchorBlocks"].map(readInput));
    const params = parseArchive(paramsBytes, "inputs/params.json") as Parameters;
    if (JSON.stringify(params) !== JSON.stringify(manifest.parameters))
      throw new Error("parameters altered");
    const pages = parseArchive(evidenceBytes, "inputs/envelopes.json") as Envelope[];
    const archiveMap = parseArchive(anchorBytes, "inputs/anchor-blocks.json");
    const evidence = verifyEvidence(pages, params.eventId, params.snapshot.cutoffBlock, archiveMap);
    const evaluation = evaluateRule(params, evidence, parseArchive(credentialBytes, "inputs/credentials.json"));
    // Every observation and credential field is signed, so recomputed verification
    // failures that the digest-bound rejected.json did not record are signature faults.
    // The file is optional here: without it the checks below still decide the receipt.
    const recorded = await readArchive("rejected.json").then(b => JSON.parse(b.toString())).catch(() => undefined);
    if (recorded && digestBytes(Buffer.from(JSON.stringify(recorded))) === manifest.outputDigests?.rejected &&
        (JSON.stringify(evaluation.invalidObservations) !== JSON.stringify(recorded.invalidObservations) ||
         JSON.stringify(evaluation.invalidCredentials) !== JSON.stringify(recorded.invalidCredentials)))
      return report({ result: "FAIL", fault: "invalid_signature", reason: "verification failures differ from the manifest" });
    if (evaluation.root.toLowerCase() !== String(manifest.root).toLowerCase()) return mismatch();
    if (JSON.stringify(evidence.inputDigests) !== JSON.stringify(manifest.inputs.observationDigests) ||
        JSON.stringify(evidence.commitmentDigests) !== JSON.stringify(manifest.inputs.commitmentDigests) ||
        evaluation.credentialDigest !== manifest.inputs.credentialListDigest ||
        JSON.stringify(evidence.anchorRange) !== JSON.stringify(manifest.inputs.anchorRange))
      throw new Error("manifest input summary mismatch");
    const eligible = { addresses: evaluation.eligible.map(x => x.address), explanations: evaluation.eligible };
    const rejected = { keys: evaluation.rejected, rpidConflicts: evaluation.rpidConflicts,
      invalidObservations: evaluation.invalidObservations, invalidCredentials: evaluation.invalidCredentials };
    if (digestBytes(Buffer.from(JSON.stringify(eligible))) !== manifest.outputDigests?.eligible ||
        digestBytes(Buffer.from(JSON.stringify(rejected))) !== manifest.outputDigests?.rejected)
      throw new Error("threshold output mismatch");
    if (rpc && contract) {
      const code = await verifyOnChain(rpc, contract, trusted, dir, manifestBytes, params, pages,
        archiveMap, credentialBytes, evaluation.root);
      if (code !== undefined) return code;
    }
    // Output files last: the manifest's digests already hold, so a missing or
    // unparsable output file is a fault of the snapshot, never UNAVAILABLE.
    const output = async (name: string) => {
      try { return JSON.parse((await readArchive(name)).toString()); }
      catch (error) {
        if (error instanceof UnavailableError) throw error;
        throw new Error(`threshold output unreadable: ${name}`);
      }
    };
    if (JSON.stringify(await output("eligible.json")) !== JSON.stringify(eligible) ||
        JSON.stringify(await output("rejected.json")) !== JSON.stringify(rejected))
      throw new Error("threshold output mismatch");
    for (const [address, proof] of Object.entries(evaluation.proofs)) {
      const saved = await output("proofs/" + address.toLowerCase() + ".json");
      if (JSON.stringify(saved?.proof) !== JSON.stringify(proof) ||
          !StandardMerkleTree.verify(evaluation.root, ["address"], [address], saved.proof))
        throw new Error("proof mismatch");
    }
    return report({ result: "PASS" });
  } catch (error) {
    if (error instanceof UnavailableError) return unavailable(error.message);
    const message = error instanceof Error ? error.message : String(error);
    const fault = /signature|digest mismatch|bundle mismatch|Merkle inclusion|COSE|anchor|CBOR/i.test(message)
      ? "invalid_signature" : "threshold_miscalculation";
    return report({ result: "FAIL", fault, reason: message });
  }
}
async function progress(paramsFile: string, key: string, pendingArg?: string) {
  const path = resolve(paramsFile), base = dirname(path);
  const params = JSON.parse((await readFile(path)).toString()) as Parameters;
  const pendingSource = pendingArg ?? params.pendingSource;
  if (!pendingSource) {
    console.log(JSON.stringify({ result: "UNAVAILABLE", reason: "pending evidence source is not configured" }));
    return 2;
  }
  let evaluation: ReturnType<typeof evaluateRule>;
  try {
    const pendingPath = sourcePath(pendingSource, base);
    const pending = JSON.parse((await readSource(pendingSource, base)).toString());
    if (pending.kind !== "synthetic-pending-fixture" || pending.eventId !== params.eventId)
      throw new Error("live pending feed format and admission binding are not defined");
    const pendingBase = pendingPath.startsWith("https://") ? new URL(".", pendingPath).toString() : dirname(pendingPath);
    const pages = await loadEnvelopes(pending.evidenceSource, pendingBase, params.eventId);
    const blocks = JSON.parse((await readSource(pending.anchorBlocksSource, pendingBase)).toString());
    const credentials = JSON.parse((await readSource(params.credentialsSource, base)).toString());
    const evidence = verifyEvidence(pages, params.eventId, params.snapshot.cutoffBlock, blocks);
    evaluation = evaluateRule(params, evidence, credentials);
  } catch (error) {
    console.log(JSON.stringify({ result: "UNAVAILABLE",
      reason: error instanceof Error ? error.message : String(error) }));
    return 2;
  }
  const address = key.toLowerCase();
  const eligible = evaluation.eligible.find(x => x.address.toLowerCase() === address);
  const rejected = evaluation.rejected.find(x => x.address.toLowerCase() === address);
  if (!eligible && !rejected) throw new Error("unknown event key");
  console.log(JSON.stringify({ provisional: true, source: "synthetic-pending-fixture", key, reached: !!eligible,
    partners: eligible?.partners ?? [], reason: rejected?.reason ?? null }));
  return 0;
}
async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const a = argsOf(rest);
  if (command === "evaluate" && a.params && a.out) await evaluate(a.params, a.out);
  else if (command === "verify" && a.manifest) process.exitCode = await verify(a.manifest, a.rpc, a.contract, trustedChain(a));
  else if (command === "progress" && a.params && a.key)
    process.exitCode = await progress(a.params, a.key, a.pending);
  else throw new Error("usage: mizar evaluate --params p.json --out dir | verify --manifest path [--rpc url --contract addr --trusted-params p.json [--trusted-params-sha256 hex] --chain-id n [--from-block n] --event-registry addr --definition-registry addr --commitment-registry addr [--credentials-source src]] | progress --params p.json --key addr");
}
main().catch(error => {
  const reason = error instanceof Error ? error.message : String(error);
  if (error instanceof UnavailableError || /live snapshot requires|missing trusted anchor block mapping|commitment anchor not backed|cutoff block unavailable|registration unavailable|definition anchor unavailable|fetch failed|network/i.test(reason))
    console.log(JSON.stringify({ result: "UNAVAILABLE", reason }));
  else console.error(reason);
  process.exitCode = 2;
});
