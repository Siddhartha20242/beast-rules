import type { EngineEvent } from "../engine.js";
import type { EventType } from "../compiler/types.js";

export type TwitchEventName = "chat" | "follow" | "subscribe" | "gift" | "cheer" | "raid" | "hype_train";

type Bag = Record<string, unknown>;

function bag(value: unknown): Bag {
  return value && typeof value === "object" ? value as Bag : {};
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === "string" && value.length > 0);
}

function firstDate(...values: unknown[]): number | undefined {
  for (const value of values) {
    const timestamp = typeof value === "number" ? value : typeof value === "string" ? Date.parse(value) : NaN;
    if (Number.isFinite(timestamp)) return timestamp;
    if (value instanceof Date && Number.isFinite(value.getTime())) return value.getTime();
  }
  return undefined;
}

/** Converts either a Twitch EventSub envelope or a Twurple event object to the engine's event shape. */
export function translateTwitchEvent(name: TwitchEventName, payload: unknown, now = Date.now()): EngineEvent {
  const outer = bag(payload);
  const event = bag(outer.event ?? payload);
  const metadata = bag(outer.metadata);
  const eventType: Record<TwitchEventName, EventType> = {
    chat: "channel.chat.message",
    follow: "channel.follow",
    subscribe: "channel.subscribe",
    gift: "channel.subscription.gift",
    cheer: "channel.cheer",
    raid: "channel.raid",
    hype_train: "channel.hype_train.begin"
  };
  const timestamp = firstDate(event.message_timestamp, event.followed_at, event.followDate,
    event.started_at, event.startDate, event.ended_at, event.eventDate, event.timestamp) ?? now;
  const specificId = name === "chat"
    ? firstString(event.message_id, event.messageId)
    : firstString(event.id, event.message_id, event.messageId);
  const identity = firstString(event.user_id, event.userId, event.chatterId, event.from_broadcaster_user_id,
    event.fromBroadcasterId, event.broadcaster_user_id, event.broadcasterId, event.level);
  const messageId = firstString(metadata.message_id, specificId) ?? `${eventType[name]}:${identity ?? "event"}:${timestamp}`;
  return { event_type: eventType[name], timestamp, message_id: messageId };
}

export function chatMessageDetails(payload: unknown): { userId: string; userName: string; message: string; messageId: string } {
  const outer = bag(payload);
  const event = bag(outer.event ?? payload);
  const message = bag(event.message);
  const chatter = bag(event.chatter);
  const text = typeof message.text === "string" ? message.text : typeof event.messageText === "string" ? event.messageText : "";
  const userId = firstString(event.chatter_user_id, event.chatterId, chatter.user_id) ?? "unknown";
  return {
    userId,
    userName: firstString(event.chatter_user_name, event.chatterDisplayName, event.user_name, event.userName, chatter.user_name, chatter.name) ?? userId,
    message: text,
    messageId: translateTwitchEvent("chat", payload).message_id ?? ""
  };
}
