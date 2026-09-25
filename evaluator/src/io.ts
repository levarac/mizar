import { readFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import type { Envelope } from "./evidence.js";

export const digestBytes = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
export const sourcePath = (source: string, base: string) =>
  /^https:\/\//.test(source) ? source : isAbsolute(source) ? source : resolve(base, source);
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
