import { validateRule } from "./schema.js";
import type { ActionType, Color, EventType, PartId, Rule } from "./compiler/types.js";

const triggerPhrases: Record<EventType, (threshold: number) => string> = {
  "channel.follow": (n) => n === 1 ? "When someone follows" : `Every ${n} follows`,
  "channel.subscribe": (n) => n === 1 ? "When someone subscribes" : `Every ${n} subscriptions`,
  "channel.subscription.gift": (n) => n === 1 ? "When someone gifts a subscription" : `Every ${n} gifted subscriptions`,
  "channel.cheer": (n) => n === 1 ? "When someone cheers" : `Every ${n} cheers`,
  "channel.raid": (n) => n === 1 ? "When someone raids" : `Every ${n} raids`,
  "channel.chat.message": (n) => `When chat hits ${n} messages/min`,
  "channel.hype_train.begin": () => "When a hype train starts"
};

const actionPhrases: Record<ActionType, string> = {
  screen_shake: "screen shake",
  screen_flash: "screen flash",
  confetti: "confetti",
  beast_roar: "beast roar",
  obs_scene_1: "switch to scene 1",
  obs_scene_2: "switch to scene 2",
  obs_scene_3: "switch to scene 3",
  dare_1: "trigger dare 1",
  dare_2: "trigger dare 2",
  dare_3: "trigger dare 3"
};

const partPhrases: Record<PartId, string> = {
  horns: "horns", eyes: "eyes", crown: "crown", spikes: "spikes", armor: "armor",
  scales: "scales", wings: "wings", tail: "tail", shell: "shell", tentacles: "tentacles",
  claws: "claws", extra_arms: "extra arms", flames: "flames", runes: "runes", lightning: "lightning"
};

const colorPhrases: Record<Color, string> = {
  red: "red", orange: "orange", yellow: "yellow", green: "green",
  cyan: "cyan", blue: "blue", purple: "purple", pink: "pink"
};

/** Describe a compiler rule using only values accepted by the closed rule schema. */
export function describeRule(rule: Rule): string {
  if (!validateRule(rule) || rule.status !== "ok") throw new Error("Cannot describe an invalid or refused rule.");
  const trigger = triggerPhrases[rule.trigger.event_type];
  const action = actionPhrases[rule.action.type];
  const part = partPhrases[rule.mutation.part_id];
  const color = colorPhrases[rule.mutation.color];
  if (!trigger || !action || !part || !color) throw new Error("Rule contains an unmapped schema value.");
  return `${trigger(rule.trigger.threshold)}: grow ${color} ${part} + ${action}`;
}

const titleEpithets: Record<EventType, string> = {
  "channel.follow": "Follower's",
  "channel.subscribe": "Subscriber's",
  "channel.subscription.gift": "Gifter's",
  "channel.cheer": "Cheerer's",
  "channel.raid": "Raider's",
  "channel.chat.message": "Chatter's",
  "channel.hype_train.begin": "Hype Train's"
};

function capitalize(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/** A canonical name for a law, built only from validated values: "Follower's Yellow Horns". */
export function lawTitle(rule: Pick<Rule, "trigger" | "mutation">): string {
  const epithet = titleEpithets[rule.trigger.event_type];
  const part = partPhrases[rule.mutation.part_id];
  const color = colorPhrases[rule.mutation.color];
  if (!epithet || !part || !color) throw new Error("Rule contains an unmapped schema value.");
  return `${epithet} ${capitalize(color)} ${part.split(" ").map(capitalize).join(" ")}`;
}

export function displayUsername(username: string): string {
  return username.replace(/[\p{Cc}\p{Cf}]/gu, "").trim().slice(0, 24) || "unknown";
}

export interface DisplayLaw extends Rule {
  id: string;
  raw_text: string;
  zone: string;
  timestamp: number;
  compiler_path: string;
  proposer_name?: string;
}

/** Project a persisted law into a client-safe representation with no raw proposal text. */
export function lawForDisplay<T extends DisplayLaw>(law: T): Omit<T, "raw_text"> & { description: string; title: string; proposer_name?: string } {
  const { raw_text, proposer_name, ...safe } = law;
  void raw_text;
  return {
    ...safe,
    description: describeRule({ status: law.status, trigger: law.trigger, action: law.action, mutation: law.mutation }),
    title: lawTitle(law),
    ...(proposer_name ? { proposer_name: displayUsername(proposer_name) } : {})
  } as Omit<T, "raw_text"> & { description: string; title: string; proposer_name?: string };
}
