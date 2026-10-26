import type { RuleStatus } from "./compiler/types.js";

export type RefusalStatus = Exclude<RuleStatus, "ok">;

// The closed vocabulary is the beast's language: it cannot embody what it cannot say.
// Every message is a fixed string chosen by status only; viewer text never appears in one.
export const refusalText: Record<RefusalStatus, string> = {
  unsupported_trigger: "The beast cannot hear that. It only understands: follow, sub, gift sub, cheer, raid, hype train, chat activity.",
  unsupported_effect: "The beast cannot do that. Its effects: shake, flash, confetti, roar, scene 1-3, dare 1-3.",
  unsupported_part: "The beast has no such body part. Its parts: horns, eyes, crown, spikes, armor, scales, wings, tail, shell, tentacles, claws, extra arms, flames, runes, lightning.",
  too_vague: "The beast does not understand. Say what triggers it and what it grows, e.g. when someone subs grow wings.",
  unsafe: "The beast refuses. That law is not allowed."
};

export function refusalForStatus(status: RefusalStatus): string {
  return refusalText[status];
}

/** The beast's whole vocabulary, for `!tongue`. */
export const beastTongue: string[] = [
  "Triggers: follow, sub, gift sub, cheer, raid, hype train, chat activity (N messages a minute).",
  "Effects: shake, flash, confetti, roar, scene 1-3, dare 1-3.",
  "Parts: horns, eyes, crown · spikes, armor, scales · wings, tail, shell · tentacles, claws, extra arms · flames, runes, lightning.",
  "Colors: red, orange, yellow, green, cyan, blue, purple, pink.",
  "Body: five zones (head, torso, back, limbs, aura), one law each. Try: !law when someone follows grow red eyes"
];
