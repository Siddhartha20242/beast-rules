import { displayUsername } from "./describe.js";

export type VoteTickerChoice = "yes" | "no" | "1" | "2";

export interface VoteTickerEntry {
  username: string;
  choice: VoteTickerChoice;
  at: number;
  crisis: boolean;
  simulated: boolean;
}

export function createVoteTickerEntry(
  username: string,
  choice: VoteTickerChoice,
  now = Date.now(),
  options: { crisis?: boolean; simulated?: boolean } = {}
): VoteTickerEntry {
  const safeUsername = displayUsername(username);
  return {
    username: safeUsername,
    choice,
    at: now,
    crisis: options.crisis ?? (choice === "1" || choice === "2"),
    simulated: options.simulated ?? false
  };
}

export function voteTickerForSnapshot(entries: readonly VoteTickerEntry[], now = Date.now()): VoteTickerEntry[] {
  return entries.filter((entry) => now - entry.at < 4000 && now >= entry.at).slice(-5).map((entry) => ({ ...entry }));
}
