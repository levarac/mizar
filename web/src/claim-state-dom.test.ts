// @vitest-environment happy-dom
import { secp256k1 } from "@noble/curves/secp256k1";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getAddress, hexToBytes, sha256, toHex, type Address, type Hex } from "viem";
import html from "../index.html?raw";
import { addressFromCompressedKey, claimMessageBytes, groupAddress, handoffFragment } from "./codec";
import { loadSession, saveSession } from "./session";

const config = vi.hoisted(() => ({
  chainId: 11155111,
  chainName: "Sepolia",
  rpcUrl: "https://example.org/rpc",
  claimContract: "0xC54b23Ce524ea22D41A65c2EfceEc5e483f2F0fC",
  eventId: `0x${"11".repeat(32)}`,
  eligibleJsonUrl: "https://example.org/snapshots/1/eligible.json",
  expectedRoot: `0x${"22".repeat(32)}`,
  snapshotId: 1,
}));
const wallet = vi.hoisted(() => ({
  requestAddresses: vi.fn(),
  simulateContract: vi.fn(),
  writeContract: vi.fn(),
}));
vi.mock("./config", () => ({ claimPageConfig: config }));
vi.mock("viem", async (importOriginal) => ({
  ...await importOriginal<typeof import("viem")>(),
  createWalletClient: () => wallet,
  createPublicClient: () => wallet,
}));
vi.mock("qrcode", () => ({ default: { toDataURL: async () => "data:image/png;base64," } }));

const recipient = getAddress("0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC");
const replacement = getAddress("0x70997970C51812dc3A010C7d01b50e0d17dc79C8");
// Public deterministic test material; never used with a real wallet or chain.
function signedClaim(keyNumber: number, recipient: Address) {
  const key = new Uint8Array(32);
  key[31] = keyNumber;
  const compressedKey = toHex(secp256k1.getPublicKey(key, true));
  const eventKeyAddress = addressFromCompressedKey(compressedKey);
  const signed = secp256k1.sign(hexToBytes(sha256(claimMessageBytes({
    eventId: config.eventId as Hex,
    chainId: BigInt(config.chainId),
    claimContract: getAddress(config.claimContract),
    recipient,
  }))), key);
  const signature = toHex(new Uint8Array([...signed.toCompactRawBytes(), signed.recovery + 27]));
  return { recipient, eventKeyAddress, compressedKey, signature };
}
const claimA = signedClaim(1, recipient);
const claimB = signedClaim(2, replacement);
const eligible = {
  addresses: [claimA.eventKeyAddress, claimB.eventKeyAddress],
  explanations: [claimA, claimB].map(({ eventKeyAddress }) => ({ address: eventKeyAddress, partners: [] })),
};
const input = () => document.querySelector<HTMLInputElement>("#recipient")!;
const submit = () => document.querySelector<HTMLButtonElement>("#submit")!;
const panel = () => document.querySelector<HTMLElement>("#claim-panel")!;
function editRecipient(value: string) {
  input().value = value;
  input().dispatchEvent(new Event("input", { bubbles: true }));
}
function response(value: unknown) {
  return new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } });
}
async function signInPage() {
  vi.spyOn(window.location, "assign").mockImplementation(() => {});
  await import("./main");
  await vi.waitFor(() => expect(panel().dataset.state).toBe("idle"));
  editRecipient(recipient);
  document.querySelector<HTMLButtonElement>("#sign")!.click();
  const pending = loadSession().pending!;
  expect(pending.recipient).toBe(recipient);
  const fragment = new URLSearchParams({
    sig: claimA.signature, k: claimA.compressedKey, a: claimA.eventKeyAddress, st: pending.state,
  });
  history.replaceState(null, "", `/#${fragment}`);
  window.dispatchEvent(new Event("hashchange"));
  await vi.waitFor(() => expect(panel().dataset.state).toBe("ready"));
  expect(submit().disabled).toBe(false);
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  document.body.innerHTML = html.match(/<body>([\s\S]*?)<\/body>/)![1].replace(/<script[\s\S]*?<\/script>/g, "");
  localStorage.clear();
  history.replaceState(null, "", "/");
  wallet.requestAddresses.mockResolvedValue([recipient]);
  wallet.simulateContract.mockResolvedValue({});
  wallet.writeContract.mockResolvedValue(`0x${"44".repeat(32)}`);
  vi.stubGlobal("ethereum", { request: vi.fn() });
  vi.stubGlobal("fetch", vi.fn(async (url: string) => response(
    url.includes("/proofs/")
      ? { address: claimA.eventKeyAddress, root: config.expectedRoot, proof: [] }
      : eligible,
  )));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("signed recipient consistency", () => {
  it.each([replacement, "invalid", "", `0x${"00".repeat(20)}`])(
    "blocks Submit after signing and editing the recipient to %s", async (changed) => {
      await signInPage();
      editRecipient(changed);
      // Dispatch directly as well: the handler must refuse a stale signed recipient.
      submit().dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(wallet.writeContract).not.toHaveBeenCalled();
      expect(wallet.requestAddresses).not.toHaveBeenCalled();
      expect(submit().disabled).toBe(true);
      expect(document.querySelector("#state-status")!.textContent).toMatch(/sign|signature/i);
    },
  );

  it("does not restore a discarded signature when the original recipient is entered again", async () => {
    await signInPage();
    editRecipient(replacement);
    editRecipient(recipient);
    expect(submit().disabled).toBe(true);
    expect(loadSession().claim).toBeUndefined();
  });

  it("checks the displayed recipient when building the transaction after awaiting the wallet", async () => {
    await signInPage();
    let finish!: (accounts: Address[]) => void;
    wallet.requestAddresses.mockImplementation(() => new Promise<Address[]>((resolve) => { finish = resolve; }));
    submit().click();
    await vi.waitFor(() => expect(wallet.requestAddresses).toHaveBeenCalledOnce());
    // Programmatic changes do not dispatch input and bypass the disabled-button guard.
    input().value = replacement;
    finish([recipient]);
    await vi.waitFor(() => expect(panel().dataset.state).toBe("error"));
    expect(wallet.simulateContract).not.toHaveBeenCalled();
    expect(wallet.writeContract).not.toHaveBeenCalled();
  });

  it("submits the exact signed recipient when it still matches the input", async () => {
    await signInPage();
    submit().click();
    await vi.waitFor(() => expect(wallet.writeContract).toHaveBeenCalledOnce());
    expect(wallet.writeContract.mock.calls[0][0].args.slice(1)).toEqual([
      claimA.eventKeyAddress, [], input().value, claimA.signature,
    ]);
  });
});

async function importClaim(claim: typeof claimA) {
  history.replaceState(null, "", `/#${handoffFragment({ ...claim, snapshotId: 1 })}`);
  window.dispatchEvent(new Event("hashchange"));
  await vi.waitFor(() => {
    expect(loadSession().claim).toEqual(claim);
    expect(panel().dataset.state).toBe("ready");
    expect(input().value).toBe(claim.recipient);
  });
}

function expectDisplayedClaim(claim: typeof claimA) {
  expect(document.querySelector("#event-key")!.textContent).toBe(groupAddress(claim.eventKeyAddress));
  expect(input().value).toBe(claim.recipient);
  expect(document.querySelector("#recipient-grouped")!.textContent).toBe(groupAddress(claim.recipient));
  expect(loadSession()).toEqual({ eventKeyAddress: claim.eventKeyAddress, claim });
}

describe("refresh session consistency", () => {
  it.each(["eligible", "ineligible", "error"])(
    "drops an earlier refresh finishing with %s after a newer handoff", async (outcome) => {
      saveSession({ eventKeyAddress: claimA.eventKeyAddress, claim: claimA });
      let finish!: (value: ReturnType<typeof response>) => void;
      let fail!: (error: Error) => void;
      vi.mocked(fetch).mockImplementationOnce(() => new Promise((resolve, reject) => {
        finish = resolve;
        fail = reject;
      }));
      await import("./main");
      await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
      await importClaim(claimB);
      if (outcome === "error") fail(new Error("Delayed refresh failed"));
      else finish(response(outcome === "eligible" ? eligible : { addresses: [], explanations: [] }));
      // Drain the old fetch, JSON read and render continuations before asserting.
      await new Promise((resolve) => setTimeout(resolve, 0));
      expectDisplayedClaim(claimB);
      expect(panel().dataset.state).toBe("ready");
      expect(submit().disabled).toBe(false);
      submit().click();
      await vi.waitFor(() => expect(wallet.writeContract).toHaveBeenCalledOnce());
      expect(wallet.writeContract.mock.calls[0][0].args).toEqual([
        1n, claimB.eventKeyAddress, [], claimB.recipient, claimB.signature,
      ]);
      expectDisplayedClaim(claimB);
    },
  );

  it("refuses an in-flight submission when a different signed session is imported", async () => {
    await signInPage();
    let finish!: (accounts: Address[]) => void;
    wallet.requestAddresses.mockImplementation(() => new Promise<Address[]>((resolve) => { finish = resolve; }));
    submit().click();
    await vi.waitFor(() => expect(wallet.requestAddresses).toHaveBeenCalledOnce());
    // The same recipient isolates session identity from recipient equality.
    const newer = signedClaim(2, recipient);
    await importClaim(newer);
    finish([recipient]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(wallet.simulateContract).not.toHaveBeenCalled();
    expect(wallet.writeContract).not.toHaveBeenCalled();
    expectDisplayedClaim(newer);
    expect(panel().dataset.state).toBe("ready");
  });

  it("refuses Submit if storage no longer matches the displayed session", async () => {
    await signInPage();
    const newer = signedClaim(2, recipient);
    saveSession({ eventKeyAddress: newer.eventKeyAddress, claim: newer });
    submit().click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(wallet.requestAddresses).not.toHaveBeenCalled();
    expect(wallet.writeContract).not.toHaveBeenCalled();
  });
});
