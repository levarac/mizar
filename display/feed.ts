// Writes live.json for the display. Everything is fetched, verified and exported
// by the evaluator's own functions; this file only orchestrates them and turns
// the NON-CANONICAL graph export into a compact feed.
//
//   --snapshot <evaluation dir>   recorded archive, offline (e.g. web/public/snapshots/1)
//   (default)                     live preview from the Parallax operator, Alcor and Sepolia
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnvelopes, readSource } from "../evaluator/src/io.js";
import { checkAdmissionRegistries, configureLogReads, readAnchorsFromRegistry, readPostedRoot } from "../evaluator/src/chain.js";
import { verifyEvidence, type Envelope } from "../evaluator/src/evidence.js";
import { evaluateRule, type CredentialList, type Parameters } from "../evaluator/src/evaluate.js";
import { graph } from "../evaluator/src/graph.js";
import { anchorList, checkRoundTrip, compactFrames } from "./lib/compact.mjs";
import { startServer } from "./serve.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..");
const PUBLIC_RPC = "https://ethereum-sepolia-rpc.publicnode.com";

interface Options {
  snapshot?: string; params: string; out: string; rpc?: string; fromBlock?: number;
  confirmations: number; minLogSpan: number; maxLogCalls: number;
  watch?: number; serve: boolean; host: string; port: number;
}
interface Source {
  params: Parameters; pages: Envelope[]; credentials: CredentialList;
  blocks: Record<string, number>; exported: any;
  unserved?: Array<{ sequence: number; block: number; committedAt: number }> | null;
}
interface ClaimConfig {
  chainId: number; claimContract: string; snapshotId: number; expectedRoot: string; slotSeconds: number;
}

function options(argv: string[]): Options {
  const flags = new Set(["serve"]);
  const a: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const name = argv[i].replace(/^--/, "");
    if (!argv[i].startsWith("--")) throw new Error(`unexpected argument ${argv[i]}`);
    if (flags.has(name)) a[name] = true;
    else if (argv[i + 1] === undefined) throw new Error(`--${name} needs a value`);
    else a[name] = argv[++i];
  }
  const known = ["snapshot", "params", "out", "rpc", "from-block", "confirmations", "min-log-span", "max-log-calls",
    "watch", "serve", "host", "port"];
  for (const key of Object.keys(a)) if (!known.includes(key)) throw new Error(`unknown option --${key}`);
  const int = (key: string, fallback?: number) => {
    if (a[key] === undefined) return fallback;
    const value = Number(a[key]);
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`--${key} must be a non-negative integer`);
    return value;
  };
  return {
    snapshot: a.snapshot as string | undefined,
    params: (a.params as string | undefined) ?? join(repo, "docs/demo/params-0xccb8770a.json"),
    out: (a.out as string | undefined) ?? join(here, "dist/live.json"),
    rpc: a.rpc as string | undefined, fromBlock: int("from-block"),
    confirmations: int("confirmations", 5)!, minLogSpan: int("min-log-span", 10)!, maxLogCalls: int("max-log-calls", 500)!,
    watch: int("watch"), serve: a.serve === true, host: (a.host as string | undefined) ?? "127.0.0.1", port: int("port", 4180)!,
  };
}

// Same convention as the evaluator CLI: env:NAME keeps a keyed URL out of arguments.
function rpcUrl(source?: string): string {
  if (!source) return process.env.SEPOLIA_RPC_URL || PUBLIC_RPC;
  if (!source.startsWith("env:")) return source;
  const value = process.env[source.slice(4)];
  if (!value) throw new Error("RPC environment variable is unset");
  return value;
}

async function rpcCall(rpc: string, method: string, params: unknown[]): Promise<any> {
  try {
    const response = await fetch(rpc, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    const body = await response.json();
    if (body.error || body.result === undefined) throw new Error();
    return body.result;
  } catch {
    throw new Error("RPC unavailable"); // never echo the endpoint
  }
}
const latestBlock = async (rpc: string) => Number(BigInt(await rpcCall(rpc, "eth_blockNumber", [])));

// keccak256("ObservationCommitmentRecorded(bytes32,uint64,bytes32,bytes32,address,uint64)"), the
// event evaluator/src/chain.ts reads; topics are [signature, eventId, sequence, digest].
const COMMITMENT_RECORDED = "0xe2c93b49f121cf4c80ee3fa7232d78edf0d07579022e8895d0b407c4f51ff003";

// Commitments the registered operator recorded on chain after the newest one it serves.
// They only show that an anchor has landed: their evidence is not published yet, so
// nothing but sequence, block and commit time is taken from them.
async function unservedAnchors(rpc: string, registry: string, eventId: string, operator: string,
  fromBlock: number, servedSequence: number) {
  try {
    const logs: any[] = await rpcCall(rpc, "eth_getLogs", [{ address: registry, fromBlock: "0x" + fromBlock.toString(16),
      toBlock: "latest", topics: [COMMITMENT_RECORDED, "0x" + eventId.replace(/^0x/, "").toLowerCase().padStart(64, "0")] }]);
    return logs.map(log => ({ sequence: Number(BigInt(log.topics[2])), block: Number(BigInt(log.blockNumber)),
      recorder: String(log.data).slice(2 + 64 + 24, 2 + 128).toLowerCase(),
      committedAt: Number(BigInt("0x" + String(log.data).slice(2 + 128, 2 + 192))) }))
      .filter(r => r.recorder === operator.toLowerCase().replace(/^0x/, "") && r.sequence > servedSequence)
      .map(({ recorder: _recorder, ...r }) => r).sort((a, b) => a.sequence - b.sequence);
  } catch { return null; } // unknown, not empty
}

const json = async (path: string) => JSON.parse(await readFile(path, "utf8"));
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

// The exporter writes graph.json into an empty directory; read it back and clean up.
async function exportGraph(source: { params?: string; snapshot?: string }, scratch: string) {
  const out = join(scratch, "graph");
  await graph(source, out);
  return json(join(out, "graph.json"));
}

async function fromSnapshot(dir: string): Promise<Source> {
  const read = (name: string) => json(join(dir, name));
  const [params, pages, credentials, blocks] = await Promise.all(
    ["inputs/params.json", "inputs/envelopes.json", "inputs/credentials.json", "inputs/anchor-blocks.json"].map(read));
  const scratch = await mkdtemp(join(tmpdir(), "parallax-display-"));
  try {
    // --snapshot also rechecks the archived eligible.json and rejected.json.
    return { params, pages, credentials, blocks, exported: await exportGraph({ snapshot: resolve(dir) }, scratch) };
  } finally { await rm(scratch, { recursive: true, force: true }); }
}

async function fromLive(o: Options, rpc: string): Promise<Source> {
  configureLogReads(o.minLogSpan, o.maxLogCalls); // the call budget is per refresh
  const paramsPath = resolve(o.params), base = dirname(paramsPath);
  const { snapshot: _unused, rpcUrl: _dropped, ...baseline } = await json(paramsPath);
  const latest = (await latestBlock(rpc)) - o.confirmations;
  const fromBlock = o.fromBlock ?? baseline.registrationBlock ?? 0;
  const pages = await loadEnvelopes(baseline.evidenceSource, base, baseline.eventId);
  const credentials = JSON.parse((await readSource(baseline.credentialsSource, base)).toString());
  // The operator publishes a commitment some time after it lands on chain, so a
  // cutoff at the chain head can precede evidence it has not served yet. First map
  // the served commitments to their registry blocks (a cutoff at the lower bound
  // makes no completeness claim), then cut at the newest served anchor and run the
  // evaluator's full completeness check there.
  const probe = await readAnchorsFromRegistry(rpc, baseline.commitmentRegistry, baseline.eventId,
    baseline.chainId, fromBlock, pages, fromBlock);
  const newest = Math.min(latest, Math.max(fromBlock, ...Object.values(probe.mapping)));
  let cutoffBlock = newest, anchored;
  for (;;) {
    try {
      anchored = await readAnchorsFromRegistry(rpc, baseline.commitmentRegistry, baseline.eventId,
        baseline.chainId, cutoffBlock, pages, fromBlock);
      break;
    } catch (error) {
      // Another commitment in the same block may not be served yet: cut one block earlier.
      if (cutoffBlock !== newest || !/missing from evidence/.test(String(error))) throw error;
      cutoffBlock = newest - 1;
    }
  }
  const params: Parameters = { ...baseline, snapshot: { id: 0, cutoffBlock, cutoffTimestamp: anchored.cutoffTimestamp } };
  await checkAdmissionRegistries(rpc, params.chainId, params.eventRegistry!, params.definitionRegistry!,
    params.eventId, cutoffBlock, pages, fromBlock);
  const servedSequence = Math.max(0, ...pages.flatMap(page => page.commitments.map(c => c.anchor.sequence)));
  const unserved = await unservedAnchors(rpc, params.commitmentRegistry!, params.eventId,
    pages[0].admission.anchorRegistration.operator, newest, servedSequence);
  // Record the verified inputs locally so the unchanged exporter replays them.
  const scratch = await mkdtemp(join(tmpdir(), "parallax-display-"));
  try {
    await Promise.all([
      writeFile(join(scratch, "envelopes.json"), JSON.stringify(pages)),
      writeFile(join(scratch, "credentials.json"), JSON.stringify(credentials)),
      writeFile(join(scratch, "anchor-blocks.json"), JSON.stringify(anchored.mapping)),
      writeFile(join(scratch, "params.json"), JSON.stringify({ ...params, evidenceSource: "envelopes.json",
        credentialsSource: "credentials.json", anchorBlocksSource: "anchor-blocks.json" })),
    ]);
    const exported = await exportGraph({ params: join(scratch, "params.json") }, scratch);
    return { params, pages, credentials, blocks: anchored.mapping, exported, unserved };
  } finally { await rm(scratch, { recursive: true, force: true }); }
}

// The snapshot posted to the claim contract, from the archive the claim page serves.
// With an RPC, its RootPosted event is read back and compared.
let postedOnChain: string | undefined;
async function postedSnapshot(config: ClaimConfig, rpc?: string) {
  const dir = join(repo, "web/public/snapshots", String(config.snapshotId));
  const manifestBytes = await readFile(join(dir, "manifest.json"));
  const manifest = JSON.parse(manifestBytes.toString());
  const eligible = await json(join(dir, "eligible.json"));
  if (String(manifest.root).toLowerCase() !== config.expectedRoot.toLowerCase())
    throw new Error("posted snapshot archive differs from the claim page configuration");
  const snapshot = manifest.parameters.snapshot;
  const manifestDigest = "0x" + sha256(manifestBytes);
  if (rpc && postedOnChain !== "matches") {
    try {
      const posted = await readPostedRoot(rpc, config.claimContract, config.chainId, config.snapshotId,
        snapshot.cutoffBlock, snapshot.cutoffBlock);
      postedOnChain = posted.root.toLowerCase() === String(manifest.root).toLowerCase() &&
        posted.manifestDigest.toLowerCase() === manifestDigest && posted.cutoffBlock === snapshot.cutoffBlock
        ? "matches" : "differs";
    } catch { postedOnChain = undefined; }
  }
  return { snapshotId: config.snapshotId, cutoffBlock: snapshot.cutoffBlock, cutoffTimestamp: snapshot.cutoffTimestamp,
    root: manifest.root, manifestDigest, eligible: eligible.addresses, contract: config.claimContract,
    rootPosted: rpc ? postedOnChain ?? "unavailable" : "not-checked" };
}

function feedFrom(mode: string, source: Source, posted: unknown) {
  const { params, pages, credentials, blocks, exported } = source;
  const evidence = verifyEvidence(pages, params.eventId, params.snapshot.cutoffBlock, blocks);
  const evaluation = evaluateRule(params, evidence, credentials);
  const compact = compactFrames(exported);
  checkRoundTrip(exported, compact);
  const definition = pages[0].admission.definitionAnchor;
  return {
    version: 1, kind: "NON-CANONICAL", notice: exported.notice, mode, generatedAt: new Date().toISOString(),
    event: { id: params.eventId, chainId: params.chainId, validFrom: definition.validFrom, validUntil: definition.validUntil },
    rule: compact.rule,
    cutoff: { block: params.snapshot.cutoffBlock, timestamp: params.snapshot.cutoffTimestamp },
    outcome: { root: evaluation.root, eligible: evaluation.eligible.map(e => e.address) },
    posted,
    slots: compact.slots,
    // No human-check times: on a big screen they would let bystanders link a key to a person.
    keys: compact.keys,
    pairs: compact.pairs,
    anchors: anchorList(pages, blocks, params.snapshot.cutoffBlock, evidence),
    // Live only: anchors on chain whose evidence the operator has not published yet (null: unknown).
    unservedAnchors: source.unserved ?? null,
    diagnostics: { observations: evidence.observations.length, invalidObservations: evidence.invalid.length,
      invalidCredentials: evaluation.invalidCredentials.length, rpidConflicts: evaluation.rpidConflicts.length },
  };
}

async function writeAtomic(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(value) + "\n");
  await rename(temporary, path);
}

async function produce(o: Options) {
  const config = await json(join(repo, "web/public/claim-config.json")) as ClaimConfig;
  if (o.snapshot) return feedFrom("recorded-snapshot", await fromSnapshot(o.snapshot), await postedSnapshot(config));
  const rpc = rpcUrl(o.rpc);
  const source = await fromLive(o, rpc);
  return feedFrom("live-preview", source, await postedSnapshot(config, rpc));
}

async function main() {
  const o = options(process.argv.slice(2));
  const out = resolve(o.out), statusPath = join(dirname(out), "status.json");
  // Refresh status is a live-feed concept; a recorded archive has none.
  const status = (value: unknown) => o.snapshot ? Promise.resolve() : writeAtomic(statusPath, value);
  if (o.serve) startServer({ root: dirname(out), host: o.host, port: o.port });
  let lastSuccess: string | null = null;
  for (;;) {
    const started = Date.now();
    try {
      const feed = await produce(o);
      await writeAtomic(out, feed);
      lastSuccess = feed.generatedAt;
      await status({ ok: true, lastAttemptAt: feed.generatedAt, lastSuccessAt: lastSuccess, error: null });
      console.log(`${feed.mode}: ${feed.keys.length} keys, ${feed.pairs.length} pairs, ${feed.anchors.length} anchors, ` +
        `cutoff block ${feed.cutoff.block}, ${Math.round((Date.now() - started) / 1000)} s`);
    } catch (error) {
      const reason = (error instanceof Error ? error.message : String(error)).slice(0, 160);
      console.error(`refresh failed: ${reason}`);
      // Keep the last good live.json; only the status says the feed is behind.
      await status({ ok: false, lastAttemptAt: new Date().toISOString(), lastSuccessAt: lastSuccess, error: reason });
      if (o.watch === undefined) process.exit(2);
    }
    if (o.watch === undefined) return;
    await new Promise(r => setTimeout(r, Math.max(5000, o.watch! * 1000 - (Date.now() - started))));
  }
}

main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exit(2); });
