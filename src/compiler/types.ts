export type RuleStatus =
  | "ok"
  | "unsupported_trigger"
  | "unsupported_effect"
  | "unsupported_part"
  | "too_vague"
  | "unsafe";

export type EventType =
  | "channel.follow"
  | "channel.subscribe"
  | "channel.subscription.gift"
  | "channel.cheer"
  | "channel.raid"
  | "channel.chat.message"
  | "channel.hype_train.begin";

export type ActionType =
  | "screen_shake"
  | "screen_flash"
  | "confetti"
  | "beast_roar"
  | "obs_scene_1"
  | "obs_scene_2"
  | "obs_scene_3"
  | "dare_1"
  | "dare_2"
  | "dare_3";

export type PartId =
  | "horns" | "eyes" | "crown"
  | "spikes" | "armor" | "scales"
  | "wings" | "tail" | "shell"
  | "tentacles" | "claws" | "extra_arms"
  | "flames" | "runes" | "lightning";

export type Color = "red" | "orange" | "yellow" | "green" | "cyan" | "blue" | "purple" | "pink";

export interface Rule {
  status: RuleStatus;
  trigger: { event_type: EventType; threshold: number };
  action: { type: ActionType; intensity: "low" | "medium" | "high" };
  mutation: { part_id: PartId; color: Color };
}

export interface Compiler {
  compile(text: string): Promise<Rule>;
}
