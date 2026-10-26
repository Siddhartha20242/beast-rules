import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { BallotNumber } from "./ballot.js";

/** Fixed, friendly names. Chat chooses among these; viewer text never becomes the beast's name. */
export const beastNames = [
  "Gorgo", "Mugwump", "Pip", "Bramble", "Nimbus", "Tuck", "Wobbles", "Ember",
  "Fenwick", "Grumble", "Juniper", "Moss", "Pebble", "Quill", "Rumble", "Sprocket",
  "Thistle", "Umber", "Vex", "Wren", "Yarrow", "Zephyr", "Biscuit", "Cinder"
] as const;

export function beastNameOptions(seed: number): string[] {
  const start = Math.max(0, Math.floor(seed)) * 5;
  const chosen: string[] = [];
  for (let index = 0; chosen.length < 3 && index < beastNames.length * 2; index += 1) {
    const name = beastNames[(start + index * 7) % beastNames.length]!;
    if (!chosen.includes(name)) chosen.push(name);
  }
  return chosen;
}

interface PersistedProfile {
  version: 1;
  name: string | null;
  namedAt: number | null;
}

/** The beast's identity: a name chat chose once, saved between streams. */
export class BeastProfile {
  private readonly filePath: string;
  private readonly clock: () => number;
  private profile: PersistedProfile = { version: 1, name: null, namedAt: null };

  constructor(options: { filePath?: string; clock?: () => number } = {}) {
    this.filePath = resolve(options.filePath ?? "data/beast-profile.json");
    this.clock = options.clock ?? Date.now;
    this.load();
  }

  get name(): string | null {
    return this.profile.name;
  }

  setName(name: string): boolean {
    if (this.profile.name || !(beastNames as readonly string[]).includes(name)) return false;
    this.profile = { version: 1, name, namedAt: this.clock() };
    this.persist();
    return true;
  }

  clear(): void {
    this.profile = { version: 1, name: null, namedAt: null };
    this.persist();
  }

  private load(): void {
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, "utf8")) as Partial<PersistedProfile>;
      if (parsed.version === 1 && (parsed.name === null || (typeof parsed.name === "string" && (beastNames as readonly string[]).includes(parsed.name)))) {
        this.profile = { version: 1, name: parsed.name ?? null, namedAt: typeof parsed.namedAt === "number" ? parsed.namedAt : null };
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.profile = { version: 1, name: null, namedAt: null };
    }
  }

  private persist(): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, `${JSON.stringify(this.profile, null, 2)}\n`, "utf8");
  }
}

export interface NameVoteSnapshot {
  voteId: string;
  endsAt: number;
  names: string[];
  votes: [number, number, number];
  voters: number;
}

export interface NameVoteOutcome {
  voteId: string;
  winner?: string;
  votes: [number, number, number];
  total: number;
}

interface ActiveNameVote {
  voteId: string;
  endsAt: number;
  names: string[];
  ballots: Map<string, BallotNumber>;
}

/** One vote on the beast's name. Same rules as a ballot: one vote each, most votes wins, ties go to the lowest number. */
export class NameVote {
  private readonly windowMs: number;
  private readonly clock: () => number;
  private active: ActiveNameVote | undefined;
  private sequence = 0;

  constructor(options: { seconds?: number; clock?: () => number } = {}) {
    this.windowMs = Math.max(1, options.seconds ?? 20) * 1000;
    this.clock = options.clock ?? Date.now;
  }

  get isOpen(): boolean {
    return this.active !== undefined;
  }

  get current(): NameVoteSnapshot | undefined {
    const active = this.active;
    if (!active) return undefined;
    return { voteId: active.voteId, endsAt: active.endsAt, names: [...active.names], votes: this.counts(active), voters: active.ballots.size };
  }

  open(names: string[]): boolean {
    if (this.active || names.length < 2) return false;
    const now = this.clock();
    this.sequence += 1;
    this.active = { voteId: `name-${now}-${this.sequence}`, endsAt: now + this.windowMs, names: names.slice(0, 3), ballots: new Map() };
    return true;
  }

  vote(userId: string, number: number): boolean {
    const active = this.active;
    if (!active || this.clock() >= active.endsAt || active.ballots.has(userId)) return false;
    if (!Number.isInteger(number) || number < 1 || number > active.names.length) return false;
    active.ballots.set(userId, number as BallotNumber);
    return true;
  }

  closeIfExpired(): NameVoteOutcome | undefined {
    const active = this.active;
    if (!active || this.clock() < active.endsAt) return undefined;
    this.active = undefined;
    const votes = this.counts(active);
    const total = votes[0] + votes[1] + votes[2];
    let winner: string | undefined;
    if (total >= 1) {
      const order = active.names.map((_, index) => index).sort((a, b) => votes[b]! - votes[a]! || a - b);
      winner = active.names[order[0]!];
    }
    return { voteId: active.voteId, ...(winner ? { winner } : {}), votes, total };
  }

  cancel(): boolean {
    const wasOpen = this.active !== undefined;
    this.active = undefined;
    return wasOpen;
  }

  private counts(active: ActiveNameVote): [number, number, number] {
    const counts: [number, number, number] = [0, 0, 0];
    for (const number of active.ballots.values()) counts[number - 1] = (counts[number - 1] ?? 0) + 1;
    return counts;
  }
}

export interface NameVotePayload {
  ballot_id: string;
  ends_at: number;
  total: number;
  kind: "name";
  options: Array<{ number: BallotNumber; description: string; votes: number }>;
}

/** Client-safe naming vote: only names from the fixed list. */
export function nameVoteForSnapshot(snapshot: NameVoteSnapshot | undefined): NameVotePayload | null {
  if (!snapshot) return null;
  return {
    ballot_id: snapshot.voteId,
    ends_at: snapshot.endsAt,
    total: snapshot.voters,
    kind: "name",
    options: snapshot.names.map((name, index) => ({ number: (index + 1) as BallotNumber, description: name, votes: snapshot.votes[index] ?? 0 }))
  };
}
