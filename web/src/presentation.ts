export type ClaimView =
  | "idle"
  | "unconfigured"
  | "lookup"
  | "not-eligible"
  | "recipient"
  | "signature"
  | "ready"
  | "submitting"
  | "submitted"
  | "claimed"
  | "already-claimed"
  | "error";
const content: Record<ClaimView, [string, string, string, number]> = {
  idle: [
    "START YOUR CLAIM",
    "Choose your recipient wallet.",
    "Open the app to sign with your event key, then check your eligibility here.",
    2,
  ],
  unconfigured: [
    "SETUP REQUIRED",
    "This claim page is not ready yet.",
    "The event configuration is incomplete; ask the event organizer for the published claim page.",
    1,
  ],
  lookup: [
    "CHECKING ELIGIBILITY",
    "Finding your participation.",
    "Checking your event key against the published eligibility list.",
    1,
  ],
  "not-eligible": [
    "NOT ELIGIBLE",
    "No record to claim yet.",
    "Your event key is not in the published eligible list; check the event rules or contact the event organizer.",
    1,
  ],
  recipient: [
    "ELIGIBLE TO CLAIM",
    "Where should your record go?",
    "Your event key meets the published rule. Choose the wallet that will receive your record.",
    2,
  ],
  signature: [
    "WAITING FOR THE APP",
    "Confirm in the app.",
    "Review the recipient and purpose in the app, then return here after signing.",
    2,
  ],
  ready: [
    "APP SIGNATURE RECEIVED",
    "Your record is ready to claim.",
    "Submit the signed claim with your connected wallet on Sepolia.",
    3,
  ],
  submitting: [
    "WAITING FOR THE TRANSACTION",
    "Submit with your wallet.",
    "Confirm the transaction in your wallet and wait for it to be submitted.",
    3,
  ],
  submitted: [
    "TRANSACTION SUBMITTED",
    "Your claim is on its way.",
    "The transaction has been submitted; open it to check confirmation on Sepolia.",
    3,
  ],
  claimed: [
    "PARTICIPATION RECORDED",
    "Your record is yours.",
    "Your participation record has been claimed for the recipient below.",
    3,
  ],
  "already-claimed": [
    "ALREADY CLAIMED",
    "This record has been claimed.",
    "This event key already has a participation record; no further claim is needed.",
    3,
  ],
  error: [
    "ACTION NEEDED",
    "We could not complete this step.",
    "The claim could not be completed; check your wallet and connection, then try again.",
    2,
  ],
};
const emphasis: Record<ClaimView, string> = {
  idle: "recipient wallet.",
  unconfigured: "not ready yet.",
  lookup: "participation.",
  "not-eligible": "No record",
  recipient: "your record",
  signature: "the app.",
  ready: "ready to claim.",
  submitting: "your wallet.",
  submitted: "on its way.",
  claimed: "yours.",
  "already-claimed": "has been claimed.",
  error: "this step.",
};
export function setStateHeading(title: string, phrase: string): void {
  const heading = document.querySelector("#state-title")!;
  const start = title.indexOf(phrase);
  if (start < 0) {
    heading.textContent = title;
    return;
  }
  const highlight = document.createElement("span");
  highlight.className = "highlight";
  highlight.textContent = phrase;
  heading.replaceChildren(
    title.slice(0, start),
    highlight,
    title.slice(start + phrase.length),
  );
}
export function showState(state: ClaimView, message?: string): void {
  if (!document.querySelector("#claim-panel")) return;
  const [label, title, description, step] = content[state];
  document.querySelector<HTMLElement>("#claim-panel")!.dataset.state = state;
  document.querySelector("#state-label")!.textContent = label;
  setStateHeading(title, emphasis[state]);
  const result = document.querySelector<HTMLElement>("#state-result")!;
  const pass = ["recipient", "ready", "claimed", "already-claimed"].includes(
    state,
  );
  const fail = ["not-eligible", "error"].includes(state);
  result.hidden = !pass && !fail;
  result.textContent = pass ? "PASS" : "FAIL";
  result.classList.toggle("fail", fail);
  document.querySelector("#state-status")!.textContent = message ?? description;
  document
    .querySelectorAll<HTMLElement>("[data-step]")
    .forEach((el) =>
      el.classList.toggle("active", Number(el.dataset.step) === step),
    );
  document.querySelector<HTMLInputElement>("#recipient")!.readOnly = [
    "submitting",
    "submitted",
    "claimed",
    "already-claimed",
  ].includes(state);
  const recipientVisible = [
    "idle",
    "recipient",
    "signature",
    "ready",
    "submitting",
    "submitted",
    "claimed",
    "already-claimed",
    "error",
  ].includes(state);
  document.querySelector<HTMLElement>("#recipient-section")!.hidden =
    !recipientVisible;
  document.querySelector<HTMLElement>("#purpose")!.hidden = !recipientVisible;
  document.querySelector<HTMLElement>("#sign")!.hidden = ![
    "idle",
    "recipient",
    "signature",
    "ready",
    "error",
  ].includes(state);
  document
    .querySelector<HTMLElement>("#sign")!
    .classList.toggle("secondary", state === "ready");
  document.querySelector<HTMLElement>("#submit")!.hidden = ![
    "ready",
    "submitting",
  ].includes(state);
  document.querySelector<HTMLElement>("#transaction-link")!.hidden = ![
    "submitted",
    "claimed",
  ].includes(state);
}
export function setPurpose(eventId: string): void {
  const purpose = document.querySelector("#purpose");
  if (!purpose) return;
  purpose.textContent = `Purpose: claim a participation record for event ${eventId.slice(0, 10)}…${eventId.slice(-4)} to this wallet.`;
}
export function showTransaction(hash: string): void {
  if (!/^0x[0-9a-f]{64}$/i.test(hash)) return;
  document.querySelector<HTMLAnchorElement>("#transaction-link")!.href =
    `https://sepolia.etherscan.io/tx/${hash}`;
}
export function friendlyError(message: string): string {
  if (/zero address/.test(message))
    return "The recipient cannot be the zero address; enter the wallet that should receive your record.";
  if (/recipient address first/.test(message))
    return "The recipient address is missing or invalid; enter a complete wallet address.";
  if (/No injected wallet/.test(message))
    return "No wallet was found; open this page in a browser with a wallet connected.";
  if (/cancelled|rejected|denied/i.test(message))
    return "The request was cancelled or rejected; review the recipient and try again when ready.";
  if (/eligible list/.test(message))
    return "Your event key is not in the published eligible list; check the event rules or contact the event organizer.";
  if (
    /state mismatch|pending app|signature|callback|compressed|event key/i.test(
      message,
    )
  )
    return "The app response could not be verified; request a new signature from this page.";
  return "This step could not be completed; check your wallet and connection, then try again.";
}
