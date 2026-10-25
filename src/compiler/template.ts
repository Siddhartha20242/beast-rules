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
  /\bdanc(?:e|es|ed|ing)\b/,
  /\bscene\s*(?:#|number\s*)?([4-9]|[1-9]\d+)\b/
];

const unsupportedPartPatterns = [
  /\blaser\s+cannon\b/,
  /\b(?:laser|cannon)\b/
];

function matchPart(text: string): PartId | undefined {
  return partPatterns.find(([, pattern]) => pattern.test(text))?.[0];
}

function matchColor(text: string): Color | undefined {
  const colors: Array<[Color, RegExp]> = [
    ["red", /\bred\b/], ["orange", /\borange\b/], ["yellow", /\byellow\b|\bgolden\b|\bgold\b/],
    ["green", /\bgreen\b/], ["cyan", /\bcyan\b/], ["blue", /\bblue\b/],
    ["purple", /\bpurple\b/], ["pink", /\bpink\b/]
  ];
  return colors.find(([, pattern]) => pattern.test(text))?.[0];
}

function matchTrigger(text: string): { event_type: EventType; threshold: number } | undefined {
  const chat = text.match(/\b(\d+)\s+messages?\s+(?:a|per)\s+minute\b/);
  if (chat) return { event_type: "channel.chat.message", threshold: boundedThreshold(chat[1]) };
  if (/\bchat\b/.test(text) && /\b(?:loud|busy|spamming|spam|messages?)\b/.test(text)) {
    return { event_type: "channel.chat.message", threshold: 1 };
  }

  if (/\bhype\s+train\b/.test(text)) return { event_type: "channel.hype_train.begin", threshold: 1 };
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
  const number = before.match(/\b(\d+)\s*$/);
  return number ? boundedThreshold(number[1]) : 1;
}

function boundedThreshold(raw: string): number {
  return Math.min(100, Math.max(1, Number.parseInt(raw, 10)));
}

function matchAction(text: string): ActionType | undefined {
  if (/\bdare\s*([1-3])\b/.test(text)) return `dare_${text.match(/\bdare\s*([1-3])\b/)![1]}` as ActionType;
  const scene = text.match(/\bscene\s*(?:#|number\s*)?([1-3])\b/);
  if (scene) return `obs_scene_${scene[1]}` as ActionType;
  if (/\b(?:shake|shakes|shaking)\b/.test(text)) return "screen_shake";
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
