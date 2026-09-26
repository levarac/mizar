import { AbiCoder, JsonRpcProvider, id, toBeHex, zeroPadValue, type Log } from "ethers";
import type { Envelope } from "./evidence.js";

// RPC failures mean the chain could not be read, never that the snapshot is wrong.
async function rpc<T>(call: () => Promise<T>): Promise<T> {
  try { return await call(); }
  catch (error) { throw new Error(`RPC unavailable: ${error instanceof Error ? error.message : String(error)}`); }
}
// Public RPCs cap eth_getLogs ranges, so a failing range is split in half. The first
// failing range of MIN_SPAN blocks aborts the whole read, which bounds the retries.
const MIN_SPAN = 1_000;
async function logsInRange(provider: JsonRpcProvider, filter: { address: string; topics: string[] },
  fromBlock: number, toBlock: number | "latest"): Promise<Log[]> {
  const to = toBlock === "latest" ? await rpc(() => provider.getBlockNumber()) : toBlock;
  const read = async (from: number, until: number): Promise<Log[]> => {
    if (from > until) return [];
    try { return await provider.getLogs({ ...filter, fromBlock: from, toBlock: until }); }
    catch (error) {
      if (until - from + 1 <= MIN_SPAN) return rpc(() => Promise.reject(error));
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
  cutoffBlock: number, pages: Envelope[]) {
  const admission = pages[0]?.admission;
  if (!admission || pages.some(page => JSON.stringify(page.admission) !== JSON.stringify(admission)))
    throw new Error("inconsistent envelope admission");
  const provider = new JsonRpcProvider(rpcUrl, chainId);
  const eventTopic = zeroPadValue(eventId, 32);
  const registrations = await logsInRange(provider,
    { address: eventRegistry, topics: [registrationEvent, eventTopic] }, 0, cutoffBlock);
  if (registrations.length !== 1) throw new Error("event registration unavailable");
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
    { address: definitionRegistry, topics: [definitionEvent, eventTopic] }, 0, cutoffBlock);
  if (!anchored.length) throw new Error("definition anchor unavailable");
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
  eventId: string, chainId: number, cutoffBlock: number, pages: Envelope[]) {
  const provider = new JsonRpcProvider(rpcUrl, chainId);
  const network = await rpc(() => provider.getNetwork());
  if (network.chainId !== BigInt(chainId)) throw new Error("RPC chain ID mismatch");
  const block = await rpc(() => provider.getBlock(cutoffBlock));
  if (!block) throw new Error("cutoff block unavailable");
  const logs = await logsInRange(provider,
    { address: registry, topics: [commitmentEvent, zeroPadValue(eventId, 32)] }, 0, "latest");
  const records = new Map<string, { sequence: number; previous: string; committedAt: number; block: number }>();
  for (const log of logs) {
    const sequence = Number(BigInt(log.topics[2]));
    const digest = log.topics[3].slice(2).toLowerCase();
    const [previous, , committedAt] = AbiCoder.defaultAbiCoder()
      .decode(["bytes32", "address", "uint64"], log.data);
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
  snapshotId: number, cutoffBlock: number) {
  const provider = new JsonRpcProvider(rpcUrl, chainId);
  const logs = await logsInRange(provider, { address: contract,
    topics: [id("RootPosted(uint64,bytes32,bytes32,uint64)"), zeroPadValue(toBeHex(snapshotId), 32)] },
  cutoffBlock, "latest");
  if (logs.length !== 1) throw new Error("on-chain snapshot RootPosted event unavailable");
  const [root, manifestDigest, postedCutoff] = AbiCoder.defaultAbiCoder()
    .decode(["bytes32", "bytes32", "uint64"], logs[0].data);
  return { root: String(root), manifestDigest: String(manifestDigest), cutoffBlock: Number(postedCutoff) };
}
