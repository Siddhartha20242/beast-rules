export type SimulatedVote = "yes" | "no";

export function crowdVoteChoice(yesBiasPercent: number, randomValue = Math.random()): SimulatedVote {
  const bias = Number.isFinite(yesBiasPercent) ? Math.min(100, Math.max(0, yesBiasPercent)) : 80;
  return randomValue * 100 < bias ? "yes" : "no";
}

export function crowdCrisisVoteChoice(yesBiasPercent: number, randomValue = Math.random()): "existing" | "proposed" {
  return crowdVoteChoice(yesBiasPercent, randomValue) === "yes" ? "proposed" : "existing";
}
