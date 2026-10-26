import type { TwitchEventName } from "./events.js";
import { translateTwitchEvent } from "./events.js";

const subscriptionTypes: Record<TwitchEventName, string> = {
  chat: "channel.chat.message",
  follow: "channel.follow",
  subscribe: "channel.subscribe",
  gift: "channel.subscription.gift",
  cheer: "channel.cheer",
  raid: "channel.raid",
  hype_train: "channel.hype_train.begin"
};

const eventColors: Record<TwitchEventName, string> = {
  chat: "\u001b[36m", follow: "\u001b[32m", subscribe: "\u001b[34m", gift: "\u001b[35m",
  cheer: "\u001b[33m", raid: "\u001b[31m", hype_train: "\u001b[95m"
};

type Bag = Record<string, unknown>;
function bag(value: unknown): Bag { return value && typeof value === "object" ? value as Bag : {}; }
function string(...values: unknown[]): string | undefined { return values.find((value): value is string => typeof value === "string" && value.length > 0); }

/** Redacts credential-like text and normalizes user content so each record stays on one terminal line. */
export function redactForLog(value: string): string {
  return value
    .replace(/\bauthorization\s*[:=]\s*[^\s,;]+(?:\s+[^\s,;]+)?/gi, "[REDACTED]")
    .replace(/\b(?:authorization\s*[:=]\s*)?(?:bearer|oauth)\s*[: ]\s*[^\s,;]+/gi, "[REDACTED]")
    .replace(/\b(?:access[_-]?token|refresh[_-]?token|client[_-]?secret)\s*[:=]\s*[^\s,;]+/gi, "[REDACTED]")
    .replace(/\b[A-Za-z0-9_-]{30,}\b/g, "[REDACTED]")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function payloadFields(name: TwitchEventName, payload: unknown): { id: string; user: string; text?: string } {
  const outer = bag(payload);
  const event = bag(outer.event ?? payload);
  const metadata = bag(outer.metadata);
  const chatter = bag(event.chatter);
  const message = bag(event.message);
  const id = string(metadata.message_id, metadata.messageId, outer.message_id, event.message_id, event.messageId, event.id)
    ?? translateTwitchEvent(name, payload, Date.now()).message_id
    ?? "unknown";
  const user = string(event.chatter_user_name, event.chatterDisplayName, event.user_name, event.userName, event.userDisplayName,
    event.from_broadcaster_user_name, event.fromBroadcasterDisplayName, event.broadcaster_user_name,
    chatter.user_name, chatter.name) ?? "unknown";
  const text = name === "chat" ? string(message.text, event.messageText) ?? "" : undefined;
  return { id, user, ...(text !== undefined ? { text } : {}) };
}

export function formatEventSubLogLine(name: TwitchEventName, payload: unknown, at = new Date()): string {
  const fields = payloadFields(name, payload);
  const shortId = fields.id.length > 12 ? `${fields.id.slice(0, 12)}…` : fields.id;
  const details = `id=${redactForLog(shortId)} user=${JSON.stringify(redactForLog(fields.user))}`;
  const chat = fields.text === undefined ? "" : ` text=${JSON.stringify(redactForLog(fields.text).slice(0, 80))}`;
  const type = subscriptionTypes[name];
  const reset = "\u001b[0m";
  return `${at.toISOString()} ${eventColors[name]}${type}${reset} ${details}${chat}`;
}

export function formatDecisionLogLine(decision: string, fields: Record<string, string | number | boolean | undefined> = {}, at = new Date()): string {
  const values = Object.entries(fields).filter(([, value]) => value !== undefined).map(([key, value]) =>
    `${key}=${typeof value === "string" ? JSON.stringify(redactForLog(value)) : String(value)}`);
  return `${at.toISOString()} [decision] ${decision}${values.length ? ` ${values.join(" ")}` : ""}`;
}
