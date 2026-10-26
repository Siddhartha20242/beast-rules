import type { EventType } from "./compiler/types.js";
import type { Mood } from "./temperament.js";

export interface Desire {
  /** The kind of law the beast wants, or null when it simply wants its first law. */
  trigger: EventType | null;
  text: string;
}

const phrases: Record<EventType, string> = {
  "channel.follow": "follows",
  "channel.subscribe": "subs",
  "channel.subscription.gift": "gifted subs",
  "channel.cheer": "cheers",
  "channel.raid": "raids",
  "channel.chat.message": "chat activity",
  "channel.hype_train.begin": "a hype train"
};

// Each temperament has appetites. A fierce beast craves raids; a calm one craves chat; a chaotic one craves a hype train.
const appetite: Record<Mood, EventType[]> = {
  fierce: ["channel.raid", "channel.cheer", "channel.hype_train.begin", "channel.subscribe", "channel.subscription.gift", "channel.follow", "channel.chat.message"],
  calm: ["channel.chat.message", "channel.follow", "channel.subscribe", "channel.subscription.gift", "channel.cheer", "channel.raid", "channel.hype_train.begin"],
  chaotic: ["channel.hype_train.begin", "channel.raid", "channel.cheer", "channel.subscription.gift", "channel.subscribe", "channel.chat.message", "channel.follow"],
  steady: ["channel.follow", "channel.subscribe", "channel.chat.message", "channel.raid", "channel.cheer", "channel.subscription.gift", "channel.hype_train.begin"],
  unformed: ["channel.follow", "channel.subscribe", "channel.chat.message", "channel.raid", "channel.cheer", "channel.subscription.gift", "channel.hype_train.begin"]
};

/**
 * One visible desire at a time, derived only from the active laws and the beast's mood:
 * the first kind of trigger its temperament craves that no active law uses yet. Chat can satisfy it or ignore it.
 */
export function computeDesire(activeTriggers: readonly EventType[], mood: Mood, beastName: string | null): Desire {
  const who = beastName ?? "The beast";
  if (activeTriggers.length === 0 && mood === "unformed") return { trigger: null, text: `${who} wants its first law.` };
  const used = new Set(activeTriggers);
  const wanted = appetite[mood].find((trigger) => !used.has(trigger));
  if (!wanted) return { trigger: null, text: `${who} is content.` };
  return { trigger: wanted, text: `${who} wants a law about ${phrases[wanted]}.` };
}

/** A law satisfies the desire when it uses the trigger the beast wanted. */
export function satisfiesDesire(desire: Desire | null | undefined, lawTrigger: EventType): boolean {
  return Boolean(desire && desire.trigger && desire.trigger === lawTrigger);
}
