import type { Color, EventType, PartId, Rule } from "./types.js";

const triggerWords: Record<EventType, RegExp> = {
  "channel.follow": /\b(?:follow(?:s|ed|ing)?|follower(?:s)?)\b/i,
  "channel.subscribe": /\b(?:sub|subs|subscribe|subscribes|subscribed|subscribing|subscriber|subscribers|subscription|subscriptions)\b/i,
  "channel.subscription.gift": /\bgifts?\b/i,
  "channel.cheer": /\b(?:cheer(?:s|ed|ing)?|bits?)\b/i,
  "channel.raid": /\braids?\b/i,
  "channel.hype_train.begin": /\bhype\b/i,
  "channel.chat.message": /\b(?:chat|messages?)\b/i
};

const partWords: Record<PartId, RegExp> = {
  horns: /\bhorns?\b/i,
  eyes: /\beyes?\b/i,
  crown: /\bcrowns?\b/i,
  spikes: /\bspikes?\b/i,
  armor: /\barmor\b/i,
  scales: /\bscales?\b/i,
  wings: /\bwings?\b/i,
  tail: /\btails?\b/i,
  shell: /\bshells?\b/i,
  tentacles: /\btentacles?\b/i,
  claws: /\bclaws?\b/i,
  extra_arms: /\bextra\s+arms?\b/i,
  flames: /\bflames?\b/i,
  runes: /\brunes?\b/i,
  lightning: /\blightning\b/i
};

const colorWords: Array<[RegExp, Color]> = [
  [/\bred\b/i, "red"], [/\borange\b/i, "orange"], [/\byellow\b/i, "yellow"],
  [/\b(?:gold|golden)\b/i, "yellow"], [/\bgreen\b/i, "green"], [/\bcyan\b/i, "cyan"],
  [/\bblue\b/i, "blue"], [/\bpurple\b/i, "purple"], [/\bpink\b/i, "pink"]
];

function colorsInText(text: string): Set<Color> {
  return new Set(colorWords.flatMap(([pattern, color]) => pattern.test(text) ? [color] : []));
}

function triggerMatches(text: string, eventType: EventType): boolean {
  const hasGift = /\bgifts?\b/i.test(text);
  const hasHype = /\bhype\b/i.test(text);
  if (hasGift) return eventType === "channel.subscription.gift";
  if (hasHype) return eventType === "channel.hype_train.begin";
  return triggerWords[eventType].test(text);
}

export function verifyModelRule(text: string, rule: Rule): boolean {
  if (rule.status !== "ok") return false;
  if (!triggerMatches(text, rule.trigger.event_type)) return false;
  if (!partWords[rule.mutation.part_id].test(text)) return false;
  const statedColors = colorsInText(text);
  return statedColors.size === 0 || (statedColors.size === 1 && statedColors.has(rule.mutation.color));
}
