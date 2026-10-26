import { validateRule } from "../schema.js";
import type { ActionType, Color, Compiler, EventType, PartId, Rule, RuleStatus } from "./types.js";

const safeDefaults: Omit<Rule, "status"> = {
  trigger: { event_type: "channel.follow", threshold: 1 },
  action: { type: "confetti", intensity: "low" },
  mutation: { part_id: "runes", color: "yellow" }
};

const partPatterns: Array<[PartId, RegExp]> = [
  ["extra_arms", /\bextra\s+arms?\b/],
  ["tentacles", /\btentacles?\b/],
  ["lightning", /\blightning\b/],
  ["horns", /\bhorns?\b/],
  ["eyes", /\beyes?\b/],
  ["crown", /\bcrowns?\b/],
  ["spikes", /\bspikes?\b/],
  ["armor", /\barmor\b/],
  ["scales", /\bscales?\b/],
  ["wings", /\bwings?\b/],
  ["tail", /\btails?\b/],
  ["shell", /\bshells?\b/],
  ["claws", /\bclaws?\b/],
  ["flames", /\bflames?\b/],
  ["runes", /\brunes?\b/]
];

const unsupportedTriggerPatterns = [
  /\bdonat(?:e|es|ed|ion|ions)\b/,
  /\b(?:streamer\s+)?dies?\s+in\s+(?:the\s+)?game\b/,
  /\bgame\s+(?:death|deaths)\b/
];

const unsupportedEffectPatterns = [
  /\b(?:danc(?:e|es|ed|ing)|jump(?:s|ed|ing)?|explod(?:e|es|ed|ing)|sing(?:s|ed|ing|ang)?|fly|flies|flew|flying|spin(?:s|ning|ned|spun)?|leap(?:s|ed|ing)?|teleport(?:s|ed|ing)?|twirl(?:s|ed|ing)?|somersaults?|growl(?:s|ed|ing)?)\b/,
  /\bscene\s*(?:#|number\s*)?(?:[4-9]|[1-9]\d+|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|hundred)\b/
];

const unsupportedPartPatterns = [
  /\blaser\s+cannon\b/,
  /\b(?:laser|cannon)\b/
];

function matchPart(text: string): PartId | undefined {
  return partPatterns.find(([, pattern]) => pattern.test(text))?.[0];
}

const colorWords: Array<[Color, string[]]> = [
  ["red", ["red", "crimson", "scarlet"]], ["orange", ["orange"]],
  ["yellow", ["yellow", "gold", "golden", "amber"]], ["green", ["green", "lime", "emerald"]],
  ["cyan", ["cyan", "teal", "aqua"]], ["blue", ["blue", "azure", "navy", "sky"]],
  ["purple", ["purple", "violet", "lilac"]], ["pink", ["pink", "magenta"]]
];

function editDistanceAtMostOne(left: string, right: string): boolean {
  if (Math.abs(left.length - right.length) > 1) return false;
  for (let k = 0; k < left.length - 1; k += 1) {
    if (left[k] !== right[k] && left.slice(0, k) === right.slice(0, k) && left[k] === right[k + 1] && left[k + 1] === right[k]
      && left.slice(k + 2) === right.slice(k + 2)) return true;
  }
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < left.length && j < right.length) {
    if (left[i] === right[j]) { i += 1; j += 1; continue; }
    edits += 1;
    if (edits > 1) return false;
    if (left.length > right.length) i += 1;
    else if (right.length > left.length) j += 1;
    else { i += 1; j += 1; }
  }
  if (i < left.length || j < right.length) edits += 1;
  return edits <= 1;
}

function matchColor(text: string): Color | undefined {
  const words = text.match(/\b[a-z]+\b/g) ?? [];
  const exact = colorWords.find(([, aliases]) => words.some((word) => aliases.includes(word)));
  if (exact) return exact[0];
  for (const [color, aliases] of colorWords) if (words.some((word) => word.length >= 5 && aliases.some((alias) => alias.length >= 5 && editDistanceAtMostOne(word, alias)))) return color;
  return undefined;
}

const numberWords: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18,
  nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, dozen: 12, hundred: 100
};

function parseNumberToken(token: string): number | undefined {
  if (/^\d+$/.test(token)) return boundedThreshold(token);
  return numberWords[token];
}

function thresholdBefore(text: string): number {
  const match = text.match(/(?:\ba\s+(?:dozen|hundred)|\b(?:dozen|hundred|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty)|\b\d+)\s*$/);
  if (!match) return 1;
  const phrase = match[0].trim().toLowerCase();
  if (phrase === "a dozen" || phrase === "dozen") return 12;
  if (phrase === "a hundred" || phrase === "hundred") return 100;
  return parseNumberToken(phrase) ?? 1;
}

function matchTrigger(text: string): { event_type: EventType; threshold: number } | undefined {
  const numberPattern = "(?:\\d+|a\\s+(?:dozen|hundred)|dozen|hundred|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty)";
  const chat = text.match(new RegExp(`\\b(${numberPattern})\\s+(?:chat\\s+)?messages?\\s+(?:(?:a|per)\\s+minute|a\\s+minute)\\b`));
  const contextualChat = text.match(new RegExp(`\\bchat\\s+\\w+\\s+(${numberPattern})\\s+messages?\\s+(?:a|per)\\s+minute\\b`));
  if (chat || contextualChat) return { event_type: "channel.chat.message", threshold: thresholdBefore((chat ?? contextualChat)![1]!) };
  if (/\bchat\b/.test(text) && /\b(?:loud|busy|spamming|spam|messages?)\b/.test(text)) {
    return { event_type: "channel.chat.message", threshold: 1 };
  }

  if (/\bhype\s+train\b/.test(text)) return { event_type: "channel.hype_train.begin", threshold: precedingThreshold(text, /\bhype\s+train\b/) };
  if (/\bgift(?:ed)?\s+subs?\b|\bsubscription\s+gifts?\b|\bsubs?\s+gifts?\b/.test(text)) {
    return { event_type: "channel.subscription.gift", threshold: precedingThreshold(text, /\b(?:gift(?:ed)?\s+subs?|subscription\s+gifts?|subs?\s+gifts?)\b/) };
  }
  if (/\b(?:subs?|subscrib(?:e|es|ed|ing)|subscriptions?)\b/.test(text)) {
    return { event_type: "channel.subscribe", threshold: precedingThreshold(text, /\b(?:subs?|subscrib(?:e|es|ed|ing)|subscriptions?)\b/) };
  }
  if (/\b(?:follows?|followers?|following)\b/.test(text)) {
    return { event_type: "channel.follow", threshold: precedingThreshold(text, /\b(?:follows?|followers?|following)\b/) };
  }
  if (/\b(?:cheers?|bits?)\b/.test(text)) {
    return { event_type: "channel.cheer", threshold: precedingThreshold(text, /\b(?:cheers?|bits?)\b/) };
  }
  if (/\braids?\b/.test(text)) {
    return { event_type: "channel.raid", threshold: precedingThreshold(text, /\braids?\b/) };
  }
  return undefined;
}

function precedingThreshold(text: string, eventPattern: RegExp): number {
  const match = eventPattern.exec(text);
  if (!match) return 1;
  const before = text.slice(0, match.index);
  return thresholdBefore(before);
}

function boundedThreshold(raw: string): number {
  return Math.min(100, Math.max(1, Number.parseInt(raw, 10)));
}

function matchAction(text: string): ActionType | undefined {
  const actionNumber = "(?:[1-3]|one|two|three)";
  const dare = text.match(new RegExp(`\\bdare\\s*(${actionNumber})\\b`));
  if (dare) return `dare_${parseNumberToken(dare[1]!)}` as ActionType;
  const scene = text.match(new RegExp(`\\bscene\\s*(?:#|number\\s*)?(${actionNumber})\\b`));
  if (scene) return `obs_scene_${parseNumberToken(scene[1]!)}` as ActionType;
  if (/\b(?:shake|shakes|shaking|wobble|wobbles|wobbled|wobbling|shudder|shudders|shuddered|shuddering)\b/.test(text)) return "screen_shake";
  if (/\b(?:flash|flashes|flashing)\b/.test(text)) return "screen_flash";
  if (/\b(?:roar|roars|roaring)\b/.test(text)) return "beast_roar";
  if (/\bconfetti\b/.test(text)) return "confetti";
  return undefined;
}

function identifyStatus(text: string, hasTrigger: boolean, hasEffect: boolean, hasPart: boolean): RuleStatus {
  if (/\b(?:ban|bans|banned|timeout|timeouts|address|harass|harassment)\b/.test(text)) return "unsafe";
  if (unsupportedTriggerPatterns.some((pattern) => pattern.test(text))) return "unsupported_trigger";
  if (!hasTrigger && (hasEffect || hasPart)) return "unsupported_trigger";
  if (unsupportedEffectPatterns.some((pattern) => pattern.test(text))) return "unsupported_effect";
  if (unsupportedPartPatterns.some((pattern) => pattern.test(text))) return "unsupported_part";
  if (!hasTrigger && !hasEffect && !hasPart) return "too_vague";
  return "ok";
}

export class TemplateCompiler implements Compiler {
  async compile(text: string): Promise<Rule> {
    const normalized = text.toLowerCase().replace(/[’']/g, "'").trim();
    const matchedTrigger = matchTrigger(normalized);
    const trigger = matchedTrigger ?? safeDefaults.trigger;
    const action = matchAction(normalized) ?? safeDefaults.action.type;
    const part = matchPart(normalized) ?? safeDefaults.mutation.part_id;
    const color = matchColor(normalized) ?? safeDefaults.mutation.color;
    const status = identifyStatus(normalized, matchedTrigger !== undefined, matchAction(normalized) !== undefined, matchPart(normalized) !== undefined);
    const rule: Rule = {
      status,
      trigger,
      action: { type: action, intensity: "low" },
      mutation: { part_id: part, color }
    };

    if (!validateRule(rule)) throw new Error("TemplateCompiler generated a rule that failed schema validation");
    return rule;
  }
}
