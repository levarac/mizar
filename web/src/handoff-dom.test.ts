// @vitest-environment happy-dom
import { secp256k1 } from "@noble/curves/secp256k1";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getAddress, hexToBytes, sha256, toHex, type Hex } from "viem";
import html from "../index.html?raw";
import {
  acceptHandoffClaim,
  addressFromCompressedKey,
  claimMessageBytes,
  handoffFragment,
  metamaskDappLink,
  parseHandoffFragment,
  type HandoffClaim,
} from "./codec";
import { loadSession, saveSession } from "./session";

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
const otherRecipient = getAddress("0x70997970C51812dc3A010C7d01b50e0d17dc79C8");
// Deterministic public test key; no real credential or wallet is involved.
const privateKey = new Uint8Array(32);
privateKey[31] = 1;
const compressedKey = toHex(secp256k1.getPublicKey(privateKey, true));
const address = addressFromCompressedKey(compressedKey);
const signed = secp256k1.sign(
  hexToBytes(sha256(claimMessageBytes({
    eventId: config.eventId as Hex,
    chainId: BigInt(config.chainId),
    claimContract: getAddress(config.claimContract),
    recipient,
  }))),
  privateKey,
);
const signature = toHex(new Uint8Array([...signed.toCompactRawBytes(), signed.recovery + 27]));
const claim: HandoffClaim = { snapshotId: 1, eventKeyAddress: address, recipient, signature, compressedKey };
const accept = (handoff: HandoffClaim) => acceptHandoffClaim({
  handoff,
  snapshotId: 1,
  eventId: config.eventId as Hex,
  chainId: BigInt(config.chainId),
  claimContract: getAddress(config.claimContract),
});

describe("claim handoff codec", () => {
  it("round-trips a signed claim through the fragment and accepts it", async () => {
    const parsed = parseHandoffFragment(`#${handoffFragment(claim)}`);
    expect(parsed).toEqual(claim);
    await expect(accept(parsed!)).resolves.toEqual(claim);
  });

  it("ignores fragments that are not a handoff, such as an app callback", () => {
    expect(parseHandoffFragment("#sig=0x11&k=0x22&a=0x33&st=abc")).toBeNull();
    expect(parseHandoffFragment("")).toBeNull();
  });

  it("rejects a tampered recipient, key or snapshot", async () => {
    await expect(accept({ ...claim, recipient: otherRecipient })).rejects.toThrow("recovered signer");
    const otherKey = toHex(secp256k1.getPublicKey(new Uint8Array(32).fill(2), true));
    await expect(accept({ ...claim, compressedKey: otherKey })).rejects.toThrow("does not match k");
    await expect(accept({ ...claim, snapshotId: 2 })).rejects.toThrow("different snapshot");
  });

  it("rejects malformed fields", () => {
    const params = new URLSearchParams(handoffFragment(claim));
    params.set("sig", "0x1234");
    expect(() => parseHandoffFragment(params.toString())).toThrow("sig must be 65 bytes");
    params.delete("sig");
    expect(() => parseHandoffFragment(params.toString())).toThrow("missing");
  });

  it("builds a MetaMask in-app browser link that keeps the fragment", () => {
    expect(metamaskDappLink("https://levarac-mizar-claim.levarac.workers.dev/", "mizar-claim=1&s=1"))
      .toBe("https://metamask.app.link/dapp/levarac-mizar-claim.levarac.workers.dev/#mizar-claim=1&s=1");
  });
});

describe("claim handoff in the page", () => {
  beforeEach(() => {
    vi.resetModules();
    document.body.innerHTML = html.match(/<body>([\s\S]*?)<\/body>/)![1].replace(/<script[\s\S]*?<\/script>/g, "");
    localStorage.clear();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 503 }));
  });
  afterEach(() => vi.unstubAllGlobals());

  it("imports a signed claim without a stored session and clears the fragment", async () => {
    history.replaceState(null, "", `/?x=1#${handoffFragment(claim)}`);
    await import("./main");
    await vi.waitFor(() => expect(loadSession().claim?.eventKeyAddress).toBe(address));
    expect(loadSession().claim).toEqual({ recipient, eventKeyAddress: address, signature, compressedKey });
    expect(location.hash).toBe("");
    expect(location.pathname + location.search).toBe("/?x=1");
  });

  it("rejects a tampered handoff and keeps the stored session", async () => {
    const stored = { eventKeyAddress: address };
    saveSession(stored);
    history.replaceState(null, "", `/#${handoffFragment({ ...claim, recipient: otherRecipient })}`);
    await import("./main");
    await vi.waitFor(() => expect(document.querySelector("#status")!.textContent).toContain("recovered signer"));
    expect(loadSession()).toEqual(stored);
    expect(location.hash).toBe("");
  });

  it("shows the wallet handoff once a claim is stored", async () => {
    saveSession({ eventKeyAddress: address, claim: { recipient, eventKeyAddress: address, signature, compressedKey } });
    history.replaceState(null, "", "/");
    await import("./main");
    await vi.waitFor(() => expect(document.querySelector<HTMLElement>("#handoff")!.hidden).toBe(false));
    const link = document.querySelector<HTMLAnchorElement>("#handoff-metamask")!.href;
    expect(link.startsWith("https://metamask.app.link/dapp/")).toBe(true);
    expect(parseHandoffFragment(new URL(link).hash)).toEqual(claim);
  });
});
