import { AbiCoder, JsonRpcProvider, id, toBeHex, zeroPadValue, type Log } from "ethers";
import type { Envelope } from "./evidence.js";
import { UnavailableError } from "./io.js";

// RPC failures mean the chain could not be read, never that the snapshot is wrong.
async function rpc<T>(call: () => Promise<T>): Promise<T> {
  try { return await call(); }
  catch {
    // Provider errors may include authenticated URLs or echo credentials.
    throw new UnavailableError("RPC unavailable");
  }
}
// Public RPCs cap eth_getLogs by block range or result size. Only such an error splits
// the range in half, down to the configured span. A shared call budget covers
// every registry and RootPosted read, including rejected ranges.
let minLogSpan = 100, maxLogCalls = 500, logCalls = 0;
export function configureLogReads(minSpan = 100, maxCalls = 500): void {
  for (const [flag, value] of [["--min-log-span", minSpan], ["--max-log-calls", maxCalls]] as const)
    if (!Number.isSafeInteger(value) || value < 1)
      throw new UnavailableError(`${flag} must be a positive safe integer`);
  minLogSpan = minSpan;
  maxLogCalls = maxCalls;
  logCalls = 0;
}
const RANGE_ERROR = /block range|range (is )?too|too (large|wide|big)|too many (results|logs|blocks)|returned more than|response size|max(imum)? (block|range|results)/i;
async function logsInRange(provider: JsonRpcProvider, filter: { address: string; topics: string[] },
  fromBlock: number, toBlock: number | "latest"): Promise<Log[]> {
  const to = toBlock === "latest" ? await rpc(() => provider.getBlockNumber()) : toBlock;
  const read = async (from: number, until: number): Promise<Log[]> => {
    if (from > until) return [];
    if (++logCalls > maxLogCalls)
      throw new UnavailableError(`RPC unavailable: more than ${maxLogCalls} eth_getLogs calls; ` +
        "pass a trusted --from-block or increase --max-log-calls");
    try { return await provider.getLogs({ ...filter, fromBlock: from, toBlock: until }); }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!RANGE_ERROR.test(message) || until - from + 1 <= minLogSpan) return rpc(() => Promise.reject(error));
      const middle = Math.floor((from + until) / 2);
      return [...await read(from, middle), ...await read(middle + 1, until)];
    }
  };
  return read(fromBlock, to);
}
const commitmentEvent = id("ObservationCommitmentRecorded(bytes32,uint64,bytes32,bytes32,address,uint64)");
const registrationEvent = id("EventRegistered(bytes32,address,address,bytes32,uint64)");
const definitionEvent = id("EventDefinitionAnchored(bytes32,uint64,bytes32,bytes32,uint64,uint64,uint64)");
export async function checkAdmissionRegistries(rpcUrl: string, chainId: number,
  eventRegistry: string, definitionRegistry: string, eventId: string,
  cutoffBlock: number, pages: Envelope[], fromBlock = 0) {
  const admission = pages[0]?.admission;
  if (!admission || pages.some(page => JSON.stringify(page.admission) !== JSON.stringify(admission)))
    throw new Error("inconsistent envelope admission");
  const provider = new JsonRpcProvider(rpcUrl, chainId);
  const eventTopic = zeroPadValue(eventId, 32);
  const registrations = await logsInRange(provider,
    { address: eventRegistry, topics: [registrationEvent, eventTopic] }, fromBlock, cutoffBlock);
  if (registrations.length !== 1) throw new UnavailableError("event registration unavailable");
  const registration = admission.anchorRegistration;
  const [keySetDigest, registeredAt] = AbiCoder.defaultAbiCoder()
    .decode(["bytes32", "uint64"], registrations[0].data);
  if (registrations[0].topics[2].slice(-40).toLowerCase() !== registration.registrar.toLowerCase() ||
      registrations[0].topics[3].slice(-40).toLowerCase() !== registration.operator.toLowerCase() ||
      String(keySetDigest).slice(2).toLowerCase() !== registration.keySetDigest.toLowerCase() ||
      Number(registeredAt) !== registration.registeredAt)
    throw new Error("event registration differs from chain");
  const anchor = admission.definitionAnchor;
  const anchored = await logsInRange(provider,
    { address: definitionRegistry, topics: [definitionEvent, eventTopic] }, fromBlock, cutoffBlock);
  if (!anchored.length) throw new UnavailableError("definition anchor unavailable");
  // The admission must carry the event's latest definition anchored by the cutoff;
  // an older one would silently drop every observation made under the newer one.
  const latest = Math.max(...anchored.map(log => Number(BigInt(log.topics[2]))));
  const definitions = anchored.filter(log => Number(BigInt(log.topics[2])) === latest);
  if (latest !== anchor.sequence || definitions.length !== 1 ||
      definitions[0].topics[3].slice(2).toLowerCase() !== anchor.definitionDigest.toLowerCase())
    throw new Error("latest definition anchor differs from chain");
  const [previous, validFrom, validUntil, anchoredAt] = AbiCoder.defaultAbiCoder()
    .decode(["bytes32", "uint64", "uint64", "uint64"], definitions[0].data);
  if (String(previous).slice(2).toLowerCase() !== anchor.previousDefinitionDigest.toLowerCase() ||
      Number(validFrom) !== anchor.validFrom || Number(validUntil) !== anchor.validUntil ||
      Number(anchoredAt) !== anchor.anchoredAt)
    throw new Error("definition anchor differs from chain");
}
export async function readAnchorsFromRegistry(rpcUrl: string, registry: string,
  eventId: string, chainId: number, cutoffBlock: number, pages: Envelope[], fromBlock = 0) {
  const provider = new JsonRpcProvider(rpcUrl, chainId);
  const network = await rpc(() => provider.getNetwork());
  if (network.chainId !== BigInt(chainId)) throw new UnavailableError("RPC chain ID mismatch");
  const block = await rpc(() => provider.getBlock(cutoffBlock));
  if (!block) throw new UnavailableError("cutoff block unavailable");
  const logs = await logsInRange(provider,
    { address: registry, topics: [commitmentEvent, zeroPadValue(eventId, 32)] }, fromBlock, "latest");
  // Assumption: only the operator registered for the event records its commitments.
  // Logs from any other recorder are ignored, so a third party that can write to the
  // registry cannot make an honest snapshot look incomplete. The operator is taken from
  // the admission, which checkAdmissionRegistries has already matched to the chain.
  const operator = pages[0]?.admission.anchorRegistration.operator.toLowerCase().replace(/^0x/, "");
  const records = new Map<string, { sequence: number; previous: string; committedAt: number; block: number }>();
  for (const log of logs) {
    const sequence = Number(BigInt(log.topics[2]));
    const digest = log.topics[3].slice(2).toLowerCase();
    const [previous, recorder, committedAt] = AbiCoder.defaultAbiCoder()
      .decode(["bytes32", "address", "uint64"], log.data);
    if (String(recorder).toLowerCase().replace(/^0x/, "") !== operator) continue;
    if (records.has(digest)) throw new Error("duplicate on-chain commitment digest");
    records.set(digest, { sequence, previous: String(previous).slice(2).toLowerCase(),
      committedAt: Number(committedAt), block: log.blockNumber });
  }
  const mapping: Record<string, number> = {};
  for (const page of pages) for (const item of page.commitments) {
    const digest = item.anchor.commitmentDigest.toLowerCase();
    const record = records.get(digest);
    if (!record || record.sequence !== item.anchor.sequence ||
        record.previous !== item.anchor.previousCommitmentDigest.toLowerCase() ||
        record.committedAt !== item.anchor.committedAt)
      throw new Error("commitment anchor not backed by registry event");
    mapping[digest] = record.block;
  }
  for (const [digest, record] of records)
    if (record.block <= cutoffBlock && !(digest in mapping))
      throw new Error("commitment anchored before cutoff missing from evidence");
  return { mapping, cutoffTimestamp: block.timestamp };
}
export async function readChainId(rpcUrl: string): Promise<number> {
  const provider = new JsonRpcProvider(rpcUrl);
  try { return Number((await rpc(() => provider.getNetwork())).chainId); } finally { provider.destroy(); }
}
export async function readPostedRoot(rpcUrl: string, contract: string, chainId: number,
  snapshotId: number, cutoffBlock: number, fromBlock = 0) {
  const provider = new JsonRpcProvider(rpcUrl, chainId);
  const logs = await logsInRange(provider, { address: contract,
    topics: [id("RootPosted(uint64,bytes32,bytes32,uint64)"), zeroPadValue(toBeHex(snapshotId), 32)] },
  Math.max(cutoffBlock, fromBlock), "latest");
  if (logs.length !== 1) throw new UnavailableError("on-chain snapshot RootPosted event unavailable");
  const [root, manifestDigest, postedCutoff] = AbiCoder.defaultAbiCoder()
    .decode(["bytes32", "bytes32", "uint64"], logs[0].data);
  return { root: String(root), manifestDigest: String(manifestDigest), cutoffBlock: Number(postedCutoff) };
}
