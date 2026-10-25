import { friendlyError, setPurpose, showState, showTransaction, type ClaimView } from "./presentation";
import QRCode from "qrcode";
import {
  createPublicClient,
  createWalletClient,
  custom,
  http,
  defineChain,
  getAddress,
  isAddress,
  toHex,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";
import {
  acceptClaimCallback,
  acceptHandoffClaim,
  callbackError,
  claimAbi,
  claimAppLink,
  groupAddress,
  handoffFragment,
  metamaskDappLink,
  parseCallbackFragment,
  parseHandoffFragment,
} from "./codec";
import { claimPageConfig } from "./config";
import {
  assertProofRoot,
  findEligible,
  parseEligibleFile,
  parseProofFile,
  proofsUrlFor,
  type EligibleKey,
  type ProofFile,
} from "./eligibility";
import { clearClaimIfDifferent, loadSession, saveSession, type Session, type StoredClaim } from "./session";

const statusEl = document.querySelector<HTMLElement>("#status")!;
const eventKeyEl = document.querySelector<HTMLElement>("#event-key")!;
const eligibilityEl = document.querySelector<HTMLElement>("#eligibility")!;
const recipientInput = document.querySelector<HTMLInputElement>("#recipient")!;
const recipientGrouped = document.querySelector<HTMLElement>("#recipient-grouped")!;
const signButton = document.querySelector<HTMLButtonElement>("#sign")!;
const submitButton = document.querySelector<HTMLButtonElement>("#submit")!;
const signatureEl = document.querySelector<HTMLElement>("#signature")!;
const handoffEl = document.querySelector<HTMLElement>("#handoff");
const handoffMetamask = document.querySelector<HTMLAnchorElement>("#handoff-metamask");
const handoffCopy = document.querySelector<HTMLButtonElement>("#handoff-copy");
const handoffQr = document.querySelector<HTMLImageElement>("#handoff-qr");
let handoffUrl = "";
setPurpose(claimPageConfig.eventId);
let hasStatusError = false;
let recipientErrorReturnState: ClaimView = "idle";
let displayedEligibility: EligibleKey | null | undefined;
let displayedSession: Session = {};
let refreshGeneration = 0;

const chain = defineChain({
  id: claimPageConfig.chainId,
  name: claimPageConfig.chainName,
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [claimPageConfig.rpcUrl] } },
});

function setStatus(message: string, isError = false): void {
  statusEl.textContent = message;
  statusEl.classList.toggle("error", isError);
  hasStatusError = isError;
  if (isError) {
    showState(/AlreadyClaimed/.test(message) ? "already-claimed" : "error", /AlreadyClaimed/.test(message) ? undefined : friendlyError(message));
  } else if (message.startsWith("Claim submitted: ")) {
    showTransaction(message.slice("Claim submitted: ".length));
    showState("submitted");
  } else {
    statusEl.textContent = message;
  }
}

function randomHex(bytes: number): Hex {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  return toHex(buffer);
}

function describeEligibility(eligible: EligibleKey): string {
  return `${eligible.partners.length} distinct partners in the published eligible list.`;
}

function render(session: Session, eligible?: EligibleKey | null): void {
  displayedSession = session;
  displayedEligibility = eligible;
  const pendingRecipient = session.pending?.recipient;
  const hasPendingRecipient = typeof pendingRecipient === "string" && isAddress(pendingRecipient) && getAddress(pendingRecipient) !== zeroAddress;
  if (hasPendingRecipient && !session.claim && recipientInput.value.trim() === "") {
    recipientInput.value = pendingRecipient;
    recipientGrouped.textContent = groupAddress(pendingRecipient);
  }
  eventKeyEl.textContent = session.eventKeyAddress
    ? groupAddress(session.eventKeyAddress)
    : "Waiting for the app callback.";
  if (!session.eventKeyAddress) {
    eligibilityEl.textContent = "Waiting for the app callback.";
  } else if (eligible === undefined) {
    eligibilityEl.textContent = "Checking the published list.";
  } else if (eligible === null) {
    eligibilityEl.textContent = "This event key is not in the published eligible list.";
  } else {
    eligibilityEl.textContent = describeEligibility(eligible);
  }
  signatureEl.textContent = session.claim
    ? `Signature stored for ${groupAddress(session.claim.recipient)}.`
    : "No claim signature yet.";
  submitButton.disabled = !session.claim || eligible == null;
  renderHandoff(session, eligible);
  if (!hasStatusError) {
    showState(!session.eventKeyAddress ? (hasPendingRecipient ? "signature" : "idle")
      : eligible === undefined ? "lookup" : eligible === null ? "not-eligible"
      : session.claim ? "ready" : hasPendingRecipient ? "signature" : "recipient");
  }
}

function renderHandoff(session: Session, eligible?: EligibleKey | null): void {
  if (!handoffEl) return;
  const claim = session.claim;
  if (!claim || eligible === null) {
    handoffEl.hidden = true;
    return;
  }
  const fragment = handoffFragment({
    snapshotId: claimPageConfig.snapshotId,
    eventKeyAddress: claim.eventKeyAddress,
    recipient: claim.recipient,
    signature: claim.signature,
    compressedKey: claim.compressedKey,
  });
  const page = `${window.location.origin}${window.location.pathname}`;
  const url = `${page}#${fragment}`;
  handoffEl.hidden = false;
  if (url === handoffUrl) return;
  handoffUrl = url;
  const metamask = metamaskDappLink(page, fragment);
  if (handoffMetamask) handoffMetamask.href = metamask;
  if (handoffQr) {
    // Encodes the MetaMask link, so a phone camera opens MetaMask directly.
    void QRCode.toDataURL(metamask, { margin: 1, width: 440, errorCorrectionLevel: "L" })
      .then((src) => { handoffQr.src = src; })
      .catch(() => { handoffQr.hidden = true; });
  }
}

handoffCopy?.addEventListener("click", () => {
  if (!handoffUrl) return;
  void navigator.clipboard?.writeText(handoffUrl).then(
    () => { handoffCopy.textContent = "Copied"; },
    () => { handoffCopy.textContent = "Copy failed; long-press the MetaMask link instead"; },
  );
});

function readRecipient(): Address | null {
  const value = recipientInput.value.trim();
  if (!isAddress(value)) return null;
  const address = getAddress(value);
  if (address === zeroAddress) return null;
  return address;
}

function showRecipient(): void {
  const value = recipientInput.value.trim();
  if (isAddress(value) && getAddress(value) === zeroAddress) {
    const current = document.querySelector<HTMLElement>("#claim-panel")?.dataset.state as ClaimView | undefined;
    if (current && current !== "error") recipientErrorReturnState = current;
    recipientGrouped.textContent = "";
    setStatus("The recipient cannot be the zero address.", true);
    return;
  }
  if (statusEl.textContent === "The recipient cannot be the zero address.") {
    hasStatusError = false;
    statusEl.textContent = "";
    statusEl.classList.toggle("error", false);
    showState(recipientErrorReturnState);
  }
  const recipient = readRecipient();
  recipientGrouped.textContent = recipient ? groupAddress(recipient) : "";
}

function assertSignedRecipient(claim: StoredClaim): void {
  if (readRecipient() !== getAddress(claim.recipient)) {
    submitButton.disabled = true;
    throw new Error("Recipient changed. Request a new signature before submitting.");
  }
}

function sameSession(left: Session, right: Session): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function assertCurrentSession(session: Session): void {
  if (!sameSession(session, displayedSession) || !sameSession(session, loadSession())) {
    throw new Error("The claim session changed. Check the current claim before submitting.");
  }
}

async function loadEligibility(address: Address): Promise<EligibleKey | null> {
  const response = await fetch(claimPageConfig.eligibleJsonUrl);
  if (!response.ok) throw new Error(`eligible.json returned ${response.status}`);
  const file = parseEligibleFile(await response.json());
  const found = findEligible(file, address);
  return found ?? null;
}

async function loadProof(address: Address): Promise<ProofFile> {
  const response = await fetch(proofsUrlFor(claimPageConfig.eligibleJsonUrl, address));
  if (!response.ok) throw new Error(`proof file returned ${response.status}`);
  return parseProofFile(await response.json());
}

signButton.addEventListener("click", () => {
  const value = recipientInput.value.trim();
  if (isAddress(value) && getAddress(value) === zeroAddress) {
    setStatus("The recipient cannot be the zero address.", true);
    return;
  }
  const recipient = readRecipient();
  if (!recipient) {
    setStatus("Enter a recipient address first.", true);
    return;
  }
  const state = randomHex(16);
  const session = clearClaimIfDifferent(loadSession(), { recipient });
  saveSession({ ...session, pending: { state, recipient } });
  showState("signature");
  window.location.assign(
    claimAppLink({
      eventId: claimPageConfig.eventId,
      chainId: BigInt(claimPageConfig.chainId),
      claimContract: claimPageConfig.claimContract,
      recipient,
      state,
    }),
  );
});

submitButton.addEventListener("click", async () => {
  const session = displayedSession;
  if (!sameSession(session, loadSession())) {
    void refresh(loadSession());
    return;
  }
  const claim = session.claim;
  if (!claim || !displayedEligibility) return;
  const ethereum = (window as Window & { ethereum?: { request: (args: unknown) => Promise<unknown> } }).ethereum;
  if (!ethereum) {
    setStatus("No injected wallet was found.", true);
    return;
  }
  try {
    assertCurrentSession(session);
    assertSignedRecipient(claim);
    showState("submitting");
    const eligible = await loadEligibility(claim.eventKeyAddress);
    assertCurrentSession(session);
    if (!eligible) {
      setStatus("This event key is not in the published eligible list.", true);
      return;
    }
    const proofFile = await loadProof(claim.eventKeyAddress);
    assertCurrentSession(session);
    assertSignedRecipient(claim);
    assertProofRoot(proofFile, claimPageConfig.expectedRoot);
    const client = createWalletClient({ chain, transport: custom(ethereum) });
    const [account] = await client.requestAddresses();
    assertCurrentSession(session);
    assertSignedRecipient(claim);
    const call = {
      account,
      address: claimPageConfig.claimContract,
      abi: claimAbi,
      functionName: "claim",
      args: [
        BigInt(claimPageConfig.snapshotId),
        claim.eventKeyAddress,
        proofFile.proof,
        claim.recipient,
        claim.signature,
      ],
    } as const;
    // Simulate first so a tampered or already-spent claim fails before the wallet prompt.
    await createPublicClient({ chain, transport: http(claimPageConfig.rpcUrl) }).simulateContract(call);
    assertCurrentSession(session);
    assertSignedRecipient(claim);
    const hash = await client.writeContract(call);
    assertCurrentSession(session);
    setStatus(`Claim submitted: ${hash}`);
  } catch (error) {
    // A completed request for an older claim must not change the newer page.
    if (!sameSession(session, loadSession())) {
      if (!sameSession(displayedSession, loadSession())) void refresh(loadSession());
      return;
    }
    if (!sameSession(session, displayedSession)) return;
    setStatus(error instanceof Error ? error.message : "Claim submission failed.", true);
  }
});

recipientInput.addEventListener("input", () => {
  showRecipient();
  const session = loadSession();
  if (!session.claim || readRecipient() === getAddress(session.claim.recipient)) return;
  // Once edited, the old signature cannot become ready again without signing.
  const unsigned = { ...session, claim: undefined, pending: undefined };
  saveSession(unsigned);
  hasStatusError = false;
  render(unsigned, displayedEligibility);
  showState("recipient", "Recipient changed. Sign again for this recipient before submitting.");
});

// Handles an app callback or a claim handoff in the URL fragment. The fragment is read
// before it is cleared. Runs at load and on hashchange, because returning to an already
// open tab with only a new fragment does not reload the page.
async function processFragment(session: Session): Promise<Session> {
  const hash = window.location.hash;
  let handoff;
  try {
    handoff = parseHandoffFragment(hash);
  } catch (error) {
    history.replaceState(null, "", window.location.pathname + window.location.search);
    setStatus(error instanceof Error ? error.message : "Claim link rejected.", true);
    return session;
  }
  if (handoff) {
    history.replaceState(null, "", window.location.pathname + window.location.search);
    try {
      const accepted = await acceptHandoffClaim({
        handoff,
        snapshotId: claimPageConfig.snapshotId,
        eventId: claimPageConfig.eventId,
        chainId: BigInt(claimPageConfig.chainId),
        claimContract: claimPageConfig.claimContract,
      });
      session = {
        eventKeyAddress: accepted.eventKeyAddress,
        pending: undefined,
        claim: {
          recipient: accepted.recipient,
          eventKeyAddress: accepted.eventKeyAddress,
          signature: accepted.signature,
          compressedKey: accepted.compressedKey,
        },
      };
      saveSession(session);
      setStatus("Signed claim imported.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Claim link rejected.", true);
    }
    return session;
  }
  if (callbackError(hash) === "cancelled") {
    setStatus("The app cancelled the signature.", true);
    history.replaceState(null, "", window.location.pathname + window.location.search);
  } else if (hash.includes("sig=")) {
    history.replaceState(null, "", window.location.pathname + window.location.search);
    try {
      const callback = parseCallbackFragment(hash);
      if (!session.pending) throw new Error("No pending app request is stored in this browser.");
      const accepted = await acceptClaimCallback({
        fragment: callback,
        expectedState: session.pending.state,
        eventId: claimPageConfig.eventId,
        chainId: BigInt(claimPageConfig.chainId),
        claimContract: claimPageConfig.claimContract,
        recipient: session.pending.recipient,
      });
      session = {
        eventKeyAddress: accepted.eventKeyAddress,
        pending: undefined,
        claim: {
          recipient: session.pending.recipient,
          eventKeyAddress: accepted.eventKeyAddress,
          signature: accepted.signature,
          compressedKey: accepted.compressedKey,
        },
      };
      saveSession(session);
      history.replaceState(null, "", window.location.pathname + window.location.search);
      setStatus("App callback accepted.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Callback rejected.", true);
    }
  }
  return session;
}

async function boot(): Promise<void> {
  const session = await processFragment(loadSession());
  await refresh(session);
}

async function refresh(session: Session): Promise<void> {
  if (!sameSession(session, loadSession())) return;
  const generation = ++refreshGeneration;
  const isCurrent = () => generation === refreshGeneration && sameSession(session, loadSession());
  // Set the input before rendering, and never overwrite later edits after a fetch.
  if (session.claim) {
    recipientInput.value = session.claim.recipient;
    showRecipient();
  }
  render(session);
  if (session.eventKeyAddress) {
    try {
      const eligible = await loadEligibility(session.eventKeyAddress);
      if (!isCurrent()) return;
      render(session, eligible);
    } catch (error) {
      if (!isCurrent()) return;
      eligibilityEl.textContent = "The published eligibility list could not be read.";
      if (!hasStatusError) showState("error", "The published eligibility list could not be read; check your connection and reload this page.");
      submitButton.disabled = true;
    }
  }
}

window.addEventListener?.("hashchange", () => {
  // A stale module instance (its page elements detached) must not consume the fragment.
  if (!window.location.hash || !document.contains(statusEl)) return;
  void processFragment(loadSession()).then(refresh);
});

void boot();
