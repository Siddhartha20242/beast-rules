import type { RuleStatus } from "./compiler/types.js";

export type RefusalStatus = Exclude<RuleStatus, "ok">;

export const refusalText: Record<RefusalStatus, string> = {
  unsupported_trigger: "I only know: follow, sub, gift sub, cheer, raid, hype train, chat activity.",
  unsupported_effect: "Effects: shake, flash, confetti, roar, scene 1-3, dare 1-3.",
  unsupported_part: "Parts: horns, eyes, crown, spikes, armor, scales, wings, tail, shell, tentacles, claws, extra arms, flames, runes, lightning.",
  too_vague: "Say what triggers it and what the beast gets, e.g. when someone subs grow wings.",
  unsafe: "That one is not allowed."
};

export function refusalForStatus(status: RefusalStatus): string {
  return refusalText[status];
}
