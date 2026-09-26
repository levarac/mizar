import { readFile, mkdir, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import type { Envelope } from "./evidence.js";

// A source the verifier chose (RPC, trusted parameters or list, the manifest itself)
// could not be read. Only this maps to UNAVAILABLE; archive content never does.
export class UnavailableError extends Error {}
export const digestBytes = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
export const sourcePath = (source: string, base: string) =>
  /^https:\/\//.test(source) ? source : base.startsWith("https://") ? new URL(source, base).toString()
    : isAbsolute(source) ? source : resolve(base, source);
export async function readSource(source: string, base: string): Promise<Buffer> {
  const path = sourcePath(source, base);
  if (path.startsWith("https://")) {
    const response = await fetch(path, { method: "GET" });
    if (!response.ok) throw new Error(`GET ${path}: HTTP ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  }
  return readFile(path);
}
export async function loadEnvelopes(source: string, base: string, eventId: string): Promise<Envelope[]> {
  const path = sourcePath(source, base);
  if (!path.startsWith("https://")) {
    const parsed = JSON.parse((await readFile(path)).toString()) as Envelope[] | Envelope;
    return Array.isArray(parsed) ? parsed : [parsed];
  }
  const url = new URL(path);
  if (!url.pathname.endsWith(`/v1/events/${eventId.replace(/^0x/, "").toLowerCase()}/verification`))
    throw new Error("evidence URL does not match verification-envelope API and event ID");
  const pages: Envelope[] = [];
  let cursor: string | null = null, observationCursor: string | null = null;
  const seen = new Set<string>();
  do {
    const next = new URL(path);
    if (cursor !== null) next.searchParams.set("cursor", cursor);
    if (observationCursor !== null) next.searchParams.set("observationCursor", observationCursor);
    const marker = next.search;
    if (seen.has(marker)) throw new Error("verification envelope pagination cycle");
    seen.add(marker);
    const response = await fetch(next, { method: "GET" });
    if (!response.ok) throw new Error(`GET verification envelope: HTTP ${response.status}`);
    const page = await response.json() as Envelope;
    pages.push(page);
    const inner = page.commitments.find(c => c.nextObservationCursor !== null);
    if (inner) {
      observationCursor = inner.nextObservationCursor;
    } else {
      cursor = page.page.nextCursor;
      observationCursor = null;
    }
  } while (observationCursor !== null || pages.at(-1)!.page.nextCursor !== null);
  return pages;
}
export async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2) + "\n");
}
export const inside = (root: string, child: string) => join(root, child);
// The poster writes the archive, so a trusted file read from inside it is not trusted.
// A remote archive's whole origin counts as inside: servers may map percent-encoded or
// case-variant paths to the same file, so a path prefix cannot tell them apart.
export async function insideArchive(source: string, archiveBase: string): Promise<boolean> {
  const remoteSource = /^https:\/\//i.test(source), remoteArchive = /^https:\/\//i.test(archiveBase);
  if (remoteSource || remoteArchive)
    return remoteSource && remoteArchive && new URL(source).origin === new URL(archiveBase).origin;
  // Resolve symlinks through the nearest existing ancestor, so a file that does not
  // exist yet is compared on the same real path as the archive directory.
  const real = async (path: string): Promise<string> => {
    try { return await realpath(path); }
    catch { const parent = dirname(path); return parent === path ? path : join(await real(parent), basename(path)); }
  };
  const inside = relative(await real(archiveBase), await real(resolve(source)));
  return !(inside === ".." || inside.startsWith(".." + sep) || isAbsolute(inside));
}
