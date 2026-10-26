import { describeRule } from "./describe.js";
import { zoneForPart, type Zone } from "./schema.js";
import type { Color, Compiler, EventType, PartId, Rule } from "./compiler/types.js";

export type BallotNumber = 1 | 2 | 3;

export interface BallotOption {
  number: BallotNumber;
  /** Internal sentence the parser accepted. Never sent to clients. */
  text: string;
  rule: Rule;
}

export interface BallotSuggestionInput {
  /** Parts, zones and colors already on the beast. */
  activeParts: PartId[];
  /** Event types seen recently, most recent last. Suggestions favour them. */
  recentEvents?: EventType[];
  /** Increases with every ballot so repeated ballots differ. */
  seed: number;
  compiler: Compiler;
}

const triggers: Array<{ type: EventType; phrase: string }> = [
  { type: "channel.follow", phrase: "when someone follows" },
  { type: "channel.subscribe", phrase: "when someone subs" },
  { type: "channel.cheer", phrase: "when someone cheers" },
  { type: "channel.raid", phrase: "on a raid" },
  { type: "channel.hype_train.begin", phrase: "when a hype train starts" },
  { type: "channel.chat.message", phrase: "if chat hits 20 messages a minute" }
];
const effects = ["shake the screen", "flash the screen", "throw confetti", "make the beast roar"];
const parts: Array<{ id: PartId; phrase: string }> = [
  { id: "horns", phrase: "horns" }, { id: "eyes", phrase: "eyes" }, { id: "crown", phrase: "crown" },
  { id: "spikes", phrase: "spikes" }, { id: "armor", phrase: "armor" }, { id: "scales", phrase: "scales" },
  { id: "wings", phrase: "wings" }, { id: "tail", phrase: "tail" }, { id: "shell", phrase: "shell" },
  { id: "tentacles", phrase: "tentacles" }, { id: "claws", phrase: "claws" }, { id: "extra_arms", phrase: "extra arms" },
  { id: "flames", phrase: "flames" }, { id: "runes", phrase: "runes" }, { id: "lightning", phrase: "lightning" }
];
const colors: Color[] = ["red", "orange", "yellow", "green", "cyan", "blue", "purple", "pink"];

/**
 * Build up to three suggested laws, deterministically for a given seed and beast.
 * Every suggestion is run through the real compiler; anything that is not status "ok" is discarded.
 * Suggestions favour body zones that are still empty (so they add something instead of starting a crisis),
 * parts not already on the beast, and event types that happened recently.
 */
export async function suggestLaws(input: BallotSuggestionInput): Promise<BallotOption[]> {
  const occupied = new Set<Zone>(input.activeParts.map((part) => zoneForPart(part)));
  const onBeast = new Set<PartId>(input.activeParts);
  const recent = [...(input.recentEvents ?? [])].reverse();
  const orderedTriggers = [
    ...triggers.filter((item) => recent.includes(item.type)).sort((a, b) => recent.indexOf(a.type) - recent.indexOf(b.type)),
    ...triggers.filter((item) => !recent.includes(item.type))
  ];
  // Parts in empty zones first, then parts that would replace something; never a part already on the beast.
  const freeParts = parts.filter((part) => !onBeast.has(part.id) && !occupied.has(zoneForPart(part.id)));
  const replacingParts = parts.filter((part) => !onBeast.has(part.id) && occupied.has(zoneForPart(part.id)));
  // Use only empty-zone parts when they cover at least three zones; otherwise mix in parts that replace.
  const freeZones = new Set(freeParts.map((part) => zoneForPart(part.id)));
  const partPool = freeZones.size >= 3 ? freeParts : [...freeParts, ...replacingParts];

  const options: BallotOption[] = [];
  const usedZones = new Set<Zone>();
  const usedParts = new Set<PartId>();
  const usedTriggers = new Set<EventType>();
  const seed = Math.max(0, Math.floor(input.seed));

  for (let attempt = 0; attempt < 60 && options.length < 3; attempt += 1) {
    const trigger = orderedTriggers[(seed + attempt + options.length) % orderedTriggers.length]!;
    const part = partPool[(seed * 3 + attempt * 2 + options.length * 5) % partPool.length]!;
    if (partPool.length === 0 || usedParts.has(part.id)) continue;
    // Keep the three options in different zones and with different triggers while that is possible.
    const lenient = attempt >= 30;
    if (!lenient && (usedZones.has(zoneForPart(part.id)) || usedTriggers.has(trigger.type))) continue;
    const color = colors[(seed * 5 + attempt * 3 + part.phrase.length) % colors.length]!;
    const effect = effects[(seed + attempt) % effects.length]!;
    const text = `${trigger.phrase} grow ${color} ${part.phrase} and ${effect}`;
    let rule: Rule;
    try {
      rule = await input.compiler.compile(text);
    } catch {
      continue;
    }
    if (rule.status !== "ok" || rule.mutation.part_id !== part.id || rule.trigger.event_type !== trigger.type) continue;
    options.push({ number: (options.length + 1) as BallotNumber, text, rule });
    usedParts.add(part.id);
    usedZones.add(zoneForPart(part.id));
    usedTriggers.add(trigger.type);
  }
  return options;
}

export interface BallotSnapshot {
  ballotId: string;
  startedAt: number;
  endsAt: number;
  votes: [number, number, number];
  voters: number;
  options: Array<{ number: BallotNumber; rule: Rule }>;
}

export interface BallotOutcome {
  ballotId: string;
  winner?: BallotOption;
  votes: [number, number, number];
  total: number;
}

interface ActiveBallot {
  ballotId: string;
  startedAt: number;
  endsAt: number;
  options: BallotOption[];
  ballots: Map<string, BallotNumber>;
}

export interface BallotManagerOptions {
  ballotSeconds?: number;
  clock?: () => number;
}

export class BallotManager {
  private readonly windowMs: number;
  private readonly clock: () => number;
  private active: ActiveBallot | undefined;
  private sequence = 0;

  constructor(options: BallotManagerOptions = {}) {
    this.windowMs = Math.max(1, options.ballotSeconds ?? 20) * 1000;
    this.clock = options.clock ?? Date.now;
  }

  get isOpen(): boolean {
    return this.active !== undefined;
  }

  get current(): BallotSnapshot | undefined {
    if (!this.active) return undefined;
    return {
      ballotId: this.active.ballotId,
      startedAt: this.active.startedAt,
      endsAt: this.active.endsAt,
      votes: this.counts(this.active),
      voters: this.active.ballots.size,
      options: this.active.options.map(({ number, rule }) => ({ number, rule }))
    };
  }

  open(options: BallotOption[]): boolean {
    if (this.active || options.length < 2) return false;
    const now = this.clock();
    this.sequence += 1;
    this.active = { ballotId: `ballot-${now}-${this.sequence}`, startedAt: now, endsAt: now + this.windowMs, options, ballots: new Map() };
    return true;
  }

  vote(userId: string, number: number): boolean {
    const active = this.active;
    if (!active || this.clock() >= active.endsAt || active.ballots.has(userId)) return false;
    if (!active.options.some((option) => option.number === number)) return false;
    active.ballots.set(userId, number as BallotNumber);
    return true;
  }

  closeIfExpired(): BallotOutcome | undefined {
    const active = this.active;
    if (!active || this.clock() < active.endsAt) return undefined;
    this.active = undefined;
    const votes = this.counts(active);
    const total = votes[0] + votes[1] + votes[2];
    let winner: BallotOption | undefined;
    if (total >= 1) {
      // Most votes wins; a tie goes to the lowest number.
      winner = [...active.options].sort((a, b) => votes[b.number - 1]! - votes[a.number - 1]! || a.number - b.number)[0];
    }
    return { ballotId: active.ballotId, ...(winner ? { winner } : {}), votes, total };
  }

  cancel(): boolean {
    const wasOpen = this.active !== undefined;
    this.active = undefined;
    return wasOpen;
  }

  private counts(active: ActiveBallot): [number, number, number] {
    const counts: [number, number, number] = [0, 0, 0];
    for (const number of active.ballots.values()) counts[number - 1] = (counts[number - 1] ?? 0) + 1;
    return counts;
  }
}

export interface BallotPayload {
  ballot_id: string;
  ends_at: number;
  total: number;
  options: Array<{ number: BallotNumber; description: string; votes: number; part_id: PartId; color: Color }>;
}

/** Client-safe ballot: canonical descriptions built from validated values only. */
export function ballotForSnapshot(ballot: BallotSnapshot | undefined): BallotPayload | null {
  if (!ballot) return null;
  return {
    ballot_id: ballot.ballotId,
    ends_at: ballot.endsAt,
    total: ballot.voters,
    options: ballot.options.map(({ number, rule }) => ({
      number,
      description: describeRule(rule),
      votes: ballot.votes[number - 1] ?? 0,
      part_id: rule.mutation.part_id,
      color: rule.mutation.color
    }))
  };
}

export interface BallotScheduleState {
  now: number;
  nextAt: number;
  ballotMinutes: number;
  voteActive: boolean;
  crisisActive: boolean;
  paused: boolean;
  ballotOpen: boolean;
}

/** A ballot opens only when it is due and nothing else is happening on stream. */
export function shouldOpenBallot(state: BallotScheduleState): boolean {
  return state.ballotMinutes > 0
    && state.now >= state.nextAt
    && !state.voteActive
    && !state.crisisActive
    && !state.paused
    && !state.ballotOpen;
}
