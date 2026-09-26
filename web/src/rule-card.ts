import { sha256 } from "viem";

export type RuleConfig = {
  paramsUrl: string;
  paramsSha256: string;
  eventId: string;
  slotSeconds?: number;
  eventStart?: string;
  eventEnd?: string;
};
export type Parameters = {
  minPartners: number;
  minWindowsPerPartner: number;
  credentialsSource: string;
  credentialsPublicKey: string;
};

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Missing parameters");
  return value as Record<string, unknown>;
}
function httpsUrl(value: unknown): string {
  if (typeof value !== "string") throw new Error("Missing URL");
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password)
    throw new Error("Invalid URL");
  return value;
}
function positiveInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
    throw new Error("Invalid rule count");
  return value;
}
function time(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString().replace(".000Z", "Z") !== value
  ) {
    throw new Error("Invalid event time");
  }
  return value;
}
export function parseRuleConfig(raw: unknown): RuleConfig {
  const value = object(raw);
  if (
    typeof value.paramsSha256 !== "string" ||
    !/^[a-f0-9]{64}$/i.test(value.paramsSha256)
  )
    throw new Error("Missing or invalid SHA-256");
  if (
    typeof value.eventId !== "string" ||
    !/^0x[a-f0-9]{64}$/i.test(value.eventId)
  )
    throw new Error("Missing event ID");
  const config: RuleConfig = {
    paramsUrl: httpsUrl(value.paramsUrl),
    paramsSha256: value.paramsSha256.toLowerCase(),
    eventId: value.eventId,
  };
  if (value.slotSeconds !== undefined)
    config.slotSeconds = positiveInteger(value.slotSeconds);
  if (value.eventStart !== undefined || value.eventEnd !== undefined) {
    config.eventStart = time(value.eventStart);
    config.eventEnd = time(value.eventEnd);
    if (Date.parse(config.eventEnd) <= Date.parse(config.eventStart))
      throw new Error("Invalid event window");
  }
  return config;
}
export function verifyParameters(
  bytes: Uint8Array,
  config: RuleConfig,
): Parameters {
  if (sha256(bytes).slice(2) !== config.paramsSha256)
    throw new Error("Parameters digest mismatch");
  const raw = object(
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
  );
  if (raw.eventId !== config.eventId)
    throw new Error("Parameters event mismatch");
  if (
    typeof raw.credentialsPublicKey !== "string" ||
    !/^0x[0-9a-f]{64}$/i.test(raw.credentialsPublicKey)
  )
    throw new Error("Invalid issuer key");
  return {
    minPartners: positiveInteger(raw.minPartners),
    minWindowsPerPartner: positiveInteger(raw.minWindowsPerPartner),
    credentialsSource: httpsUrl(raw.credentialsSource),
    credentialsPublicKey: raw.credentialsPublicKey,
  };
}
const element = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(id) as T;
export function showRuleError(): void {
  element("rules-status").textContent = "Parameters could not be verified";
  element("rules-status").classList.add("error");
  element("rules-content").hidden = true;
  element("rules-error").hidden = false;
  element("rules-error").textContent =
    "The published file or its configuration could not be verified; ask the event organizer for the correct claim page.";
}
export function renderRules(params: Parameters, config: RuleConfig): void {
  element("rules-status").textContent = "Verified parameters · N, B & issuer";
  element("rules-status").classList.remove("error");
  element("rules-content").hidden = false;
  element("rules-error").hidden = true;
  element("rule-n").textContent = String(params.minPartners);
  element("rule-b").textContent = String(params.minWindowsPerPartner);
  element<HTMLAnchorElement>("rule-issuer").href = params.credentialsSource;
  element("rule-issuer").title = params.credentialsSource;
  element("rule-key-short").textContent =
    `${params.credentialsPublicKey.slice(0, 10)}…${params.credentialsPublicKey.slice(-8)}`;
  element("rule-key-short").title = params.credentialsPublicKey;
  element("rule-key").textContent = params.credentialsPublicKey;
  element<HTMLAnchorElement>("rule-link").href = config.paramsUrl;
  element("rule-digest").textContent = config.paramsSha256;
  element("slot-row").hidden = config.slotSeconds === undefined;
  element("window-row").hidden = config.eventStart === undefined;
  element("event-reference").hidden =
    config.slotSeconds === undefined && config.eventStart === undefined;
  if (config.slotSeconds !== undefined)
    element("rule-slot").textContent =
      config.slotSeconds % 60 === 0
        ? `${config.slotSeconds / 60} minutes`
        : `${config.slotSeconds} seconds`;
  if (config.eventStart && config.eventEnd) {
    const start = new Date(config.eventStart),
      end = new Date(config.eventEnd);
    const format = (date: Date, zone?: string) =>
      new Intl.DateTimeFormat("en-GB", {
        day: "2-digit",
        month: "short",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
        timeZone: zone,
      }).format(date);
    element("rule-window-utc").textContent =
      `${format(start, "UTC")} → ${format(end, "UTC")} UTC`;
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    element("rule-window-local").textContent =
      `${format(start)} → ${format(end)} · ${zone}`;
  }
}
export async function loadRules(raw: unknown): Promise<void> {
  try {
    const config = parseRuleConfig(raw);
    const response = await fetch(config.paramsUrl, {
      credentials: "omit",
      cache: "no-cache",
    });
    if (!response.ok) throw new Error("Parameters unavailable");
    const bytes = new Uint8Array(await response.arrayBuffer());
    renderRules(verifyParameters(bytes, config), config);
  } catch {
    showRuleError();
  }
}
