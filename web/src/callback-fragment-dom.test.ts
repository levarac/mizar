// @vitest-environment happy-dom
import { secp256k1 } from "@noble/curves/secp256k1";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getAddress, hexToBytes, sha256, toHex } from "viem";
import html from "../index.html?raw";
import { addressFromCompressedKey, claimMessageBytes } from "./codec";
import { loadSession, saveSession, type Session } from "./session";

const config = vi.hoisted(() => ({
  chainId: 11155111,
  chainName: "Sepolia",
  rpcUrl: "https://ethereum-sepolia-rpc.publicnode.com",
  claimContract: "0xC54b23Ce524ea22D41A65c2EfceEc5e483f2F0fC",
  eventId: `0x${"11".repeat(32)}`,
  eligibleJsonUrl: "/snapshots/1/eligible.json",
  expectedRoot: `0x${"22".repeat(32)}`,
  snapshotId: 1,
}));
vi.mock("./config", () => ({ claimPageConfig: config }));
const recipient = getAddress("0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC");
// Deterministic public test key; no real credential or wallet is involved.
const privateKey = new Uint8Array(32);
privateKey[31] = 1;
const compressedKey = toHex(secp256k1.getPublicKey(privateKey, true));
const address = addressFromCompressedKey(compressedKey);
const signature = secp256k1.sign(
  hexToBytes(
    sha256(
      claimMessageBytes({
        eventId: config.eventId as `0x${string}`,
        chainId: BigInt(config.chainId),
        claimContract: getAddress(config.claimContract),
        recipient,
      }),
    ),
  ),
  privateKey,
);
const fragment = new URLSearchParams({
  sig: toHex(
    new Uint8Array([...signature.toCompactRawBytes(), signature.recovery + 27]),
  ),
  k: compressedKey,
  a: address,
  st: "incoming-state",
});

beforeEach(() => {
  vi.resetModules();
  document.body.innerHTML = html
    .match(/<body>([\s\S]*?)<\/body>/)![1]
    .replace(/<script[\s\S]*?<\/script>/g, "");
  localStorage.clear();
  history.replaceState(null, "", `/claim?source=app#${fragment}`);
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 503 }));
});
afterEach(() => vi.unstubAllGlobals());

describe("rejected claim callback fragments", () => {
  it.each([false, true])(
    "removes the fragment without changing stored claims (pending=%s)",
    async (pending) => {
      const stored: Session = {
        eventKeyAddress: address,
        claim: {
          recipient,
          eventKeyAddress: address,
          signature: "0x11",
          compressedKey,
        },
        ...(pending
          ? { pending: { recipient, state: "different-state" } }
          : {}),
      };
      saveSession(stored);
      await import("./main");
      await vi.waitFor(() =>
        expect(document.querySelector("#status")!.textContent).toContain(
          pending ? "state mismatch" : "No pending app request",
        ),
      );
      expect(location.hash).toBe("");
      expect(location.pathname + location.search).toBe("/claim?source=app");
      expect(loadSession()).toEqual(stored);
    },
  );
});
