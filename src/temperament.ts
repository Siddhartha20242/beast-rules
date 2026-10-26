import type { ActionType, PartId } from "./compiler/types.js";

export type Ferocity = "Fierce" | "Wary" | "Calm";
export type Order = "Orderly" | "Restless" | "Chaotic";
export type Mood = "unformed" | "fierce" | "calm" | "chaotic" | "steady";

export interface Temperament {
  ferocity: Ferocity | null;
  order: Order | null;
  mood: Mood;
  label: string;
}

const aggressiveParts = new Set<PartId>(["horns", "spikes", "claws", "flames", "lightning", "tentacles"]);
const loudActions = new Set<ActionType>(["beast_roar", "screen_shake", "screen_flash"]);

interface TemperamentLaw {
  action: { type: ActionType };
  mutation: { part_id: PartId };
}

/**
 * Two visible axes derived from the law history, no randomness.
 * Ferocity: how aggressive the active parts and loud the active effects are.
 * Order: how much of the beast's history is conflict (laws that were repealed or overruled).
 */
export function computeTemperament(active: readonly TemperamentLaw[], historyCount: number): Temperament {
  if (active.length === 0 && historyCount === 0) {
    return { ferocity: null, order: null, mood: "unformed", label: "Unformed" };
  }
  const aggressive = active.filter((law) => aggressiveParts.has(law.mutation.part_id)).length;
  const loud = active.filter((law) => loudActions.has(law.action.type)).length;
  const ferocityScore = active.length ? (aggressive + loud) / (2 * active.length) : 0;
  const ferocity: Ferocity = ferocityScore >= 0.6 ? "Fierce" : ferocityScore <= 0.25 ? "Calm" : "Wary";
  const chaosRatio = historyCount / (historyCount + active.length);
  const order: Order = chaosRatio >= 0.5 ? "Chaotic" : chaosRatio >= 0.2 ? "Restless" : "Orderly";
  const mood: Mood = order === "Chaotic" ? "chaotic" : ferocity === "Fierce" ? "fierce" : ferocity === "Calm" ? "calm" : "steady";
  return { ferocity, order, mood, label: `${ferocity} · ${order}` };
}
