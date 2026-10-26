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

const colorWords: Array<[string[], Color]> = [
  [["red", "crimson", "scarlet"], "red"], [["orange"], "orange"], [["yellow", "gold", "golden", "amber"], "yellow"],
  [["green", "lime", "emerald"], "green"], [["cyan", "teal", "aqua"], "cyan"],
  [["blue", "azure", "navy", "sky"], "blue"], [["purple", "violet", "lilac"], "purple"], [["pink", "magenta"], "pink"]
];

function colorWordsInText(text: string): Set<Color> {
  const words = text.toLowerCase().match(/\b[a-z]+\b/g) ?? [];
  const result = new Set<Color>();
  for (const [aliases, color] of colorWords) {
    if (words.some((word) => aliases.includes(word) || (word.length >= 5 && aliases.some((alias) => alias.length >= 5 && editDistanceAtMostOne(word, alias))))) result.add(color);
  }
  return result;
}

function editDistanceAtMostOne(left: string, right: string): boolean {
  if (Math.abs(left.length - right.length) > 1) return false;
  for (let k = 0; k < left.length - 1; k += 1) {
    if (left[k] !== right[k] && left.slice(0, k) === right.slice(0, k)
      && left[k] === right[k + 1] && left[k + 1] === right[k] && left.slice(k + 2) === right.slice(k + 2)) return true;
  }
  let i = 0; let j = 0; let edits = 0;
  while (i < left.length && j < right.length) {
    if (left[i] === right[j]) { i += 1; j += 1; continue; }
    edits += 1;
    if (edits > 1) return false;
    if (left.length > right.length) i += 1;
    else if (right.length > left.length) j += 1;
    else { i += 1; j += 1; }
  }
  return edits + (i < left.length || j < right.length ? 1 : 0) <= 1;
}

const supportedEffects: Array<[RegExp, string]> = [
  [/\b(?:shake|shakes|shaking)\b/i, "screen_shake"],
  [/\b(?:flash|flashes|flashing)\b/i, "screen_flash"],
  [/\bconfetti\b/i, "confetti"],
  [/\b(?:roar|roars|roaring)\b/i, "beast_roar"],
  [/\bscene\s*(?:#|number\s*)?([1-3])\b/i, "scene"],
  [/\bdare\s*([1-3])\b/i, "dare"]
];
const unsupportedEffectVerbs = /\b(?:dance|dances|danced|dancing|jump|jumps|jumped|jumping|explode|explodes|exploded|exploding|sing|sings|sang|singing|fly|flies|flew|flying|spin|spins|spun|spinning|leap|leaps|leapt|leaping|teleport|teleports|teleported|teleporting|twirl|twirls|twirled|twirling|somersault|somersaults)\b/i;

function verifyEffect(text: string, action: Rule["action"]["type"]): boolean {
  if (unsupportedEffectVerbs.test(text)) return false;
  const scene = /\bscene\s*(?:#|number\s*)?([1-3])\b/i.exec(text);
  if (scene) return action === `obs_scene_${scene[1]}`;
  const dare = /\bdare\s*([1-3])\b/i.exec(text);
  if (dare) return action === `dare_${dare[1]}`;
  const namedEffects = supportedEffects.slice(0, 4).flatMap(([pattern, type]) => pattern.test(text) ? [type] : []);
  return namedEffects.length === 0 ? action === "confetti" : namedEffects.includes(action);
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
  if (!verifyEffect(text, rule.action.type)) return false;
  const statedColors = colorWordsInText(text);
  return statedColors.size === 0 || (statedColors.size === 1 && statedColors.has(rule.mutation.color));
}
