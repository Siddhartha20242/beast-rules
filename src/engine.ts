import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { zoneForPart, type Zone } from "./schema.js";
import type { CompilerPath } from "./compiler/auto.js";
import type { EventType, Rule } from "./compiler/types.js";

const TEN_MINUTES_MS = 10 * 60 * 1000;
const CHAT_WINDOW_MS = 60 * 1000;

export interface ActiveLaw extends Rule {
  id: string;
  raw_text: string;
  zone: Zone;
  timestamp: number;
  compiler_path: CompilerPath;
  proposer_name?: string;
}

export interface HistoricalLaw extends ActiveLaw {
  repealed_at: number;
  overruled_by: string;
  reason: string;
}

export interface LawConflict {
  type: "crisis";
  zone: Zone;
  previous_law_id: string;
  replacement_law_id: string;
}

export interface AddLawResult {
  law: ActiveLaw;
  replaced?: HistoricalLaw;
  conflict?: LawConflict;
}

export type CrisisVoteChoice = "existing" | "proposed";

export interface CrisisSnapshot {
  zone: Zone;
  existing: ActiveLaw;
  proposed: ActiveLaw;
  started_at: number;
  ends_at: number;
  existing_votes: number;
  proposed_votes: number;
  seconds_left: number;
}

interface PersistedCrisis extends Omit<CrisisSnapshot, "existing_votes" | "proposed_votes" | "seconds_left"> {
  votes: Record<string, CrisisVoteChoice>;
}

export type CrisisStartResult =
  | { status: "busy" }
  | { status: "added"; law: ActiveLaw }
  | { status: "started"; crisis: CrisisSnapshot };

export interface CrisisOutcome {
  winner: ActiveLaw;
  loser: ActiveLaw;
  winner_choice: CrisisVoteChoice;
  existing_votes: number;
  proposed_votes: number;
}

export interface EngineEvent {
  event_type: EventType;
  timestamp?: number | string;
  message_id?: string;
}

export interface EventResult {
  ignored: boolean;
  reason?: "duplicate" | "stale";
  fired: ActiveLaw[];
}

export interface EngineOptions {
  filePath?: string;
  clock?: () => number;
  dedupeLimit?: number;
}

interface PersistedState {
  version: 1;
  nextId: number;
  active: ActiveLaw[];
  history: HistoricalLaw[];
  crisis?: PersistedCrisis;
}

export class RuleEngine {
  private readonly filePath: string;
  private readonly clock: () => number;
  private readonly dedupeLimit: number;
  private nextId = 1;
  private active = new Map<Zone, ActiveLaw>();
  private history: HistoricalLaw[] = [];
  private crisis: PersistedCrisis | undefined;
  private readonly processedMessageIds = new Set<string>();
  private readonly eventCounts = new Map<string, number>();
  private readonly chatTimes = new Map<string, number[]>();

  constructor(options: EngineOptions = {}) {
    this.filePath = resolve(options.filePath ?? "data/beast.json");
    this.clock = options.clock ?? Date.now;
    this.dedupeLimit = Math.max(1, options.dedupeLimit ?? 10_000);
    this.load();
  }

  get activeLaws(): ActiveLaw[] {
    return [...this.active.values()];
  }

  get lawHistory(): HistoricalLaw[] {
    return [...this.history];
  }

  get currentCrisis(): CrisisSnapshot | undefined {
    if (!this.crisis) return undefined;
    const existingVotes = Object.values(this.crisis.votes).filter((vote) => vote === "existing").length;
    const proposedVotes = Object.values(this.crisis.votes).filter((vote) => vote === "proposed").length;
    return {
      zone: this.crisis.zone,
      existing: structuredClone(this.crisis.existing),
      proposed: structuredClone(this.crisis.proposed),
      started_at: this.crisis.started_at,
      ends_at: this.crisis.ends_at,
      existing_votes: existingVotes,
      proposed_votes: proposedVotes,
      seconds_left: Math.max(0, Math.ceil((this.crisis.ends_at - this.clock()) / 1000))
    };
  }

  beginCrisis(rule: Rule, rawText: string, durationSeconds: number, compilerPath: CompilerPath = "parser", proposerName = "unknown"): CrisisStartResult {
    if (this.crisis) return { status: "busy" };
    if (rule.status !== "ok") throw new Error(`Cannot add a rule with status ${rule.status}`);
    const zone = zoneForPart(rule.mutation.part_id);
    const existing = this.active.get(zone);
    if (!existing) return { status: "added", law: this.add(rule, rawText, compilerPath, proposerName).law };

    const now = this.clock();
    const proposed: ActiveLaw = {
      ...structuredClone(rule),
      id: `law-${this.nextId++}`,
      raw_text: rawText,
      zone,
      timestamp: now,
      compiler_path: compilerPath,
      proposer_name: proposerName
    };
    this.crisis = {
      zone,
      existing: structuredClone(existing),
      proposed,
      started_at: now,
      ends_at: now + Math.max(1, durationSeconds) * 1000,
      votes: {}
    };
    this.persist();
    return { status: "started", crisis: this.currentCrisis! };
  }

  castCrisisVote(userId: string, choice: CrisisVoteChoice): boolean {
    if (!this.crisis || this.clock() >= this.crisis.ends_at || this.crisis.votes[userId]) return false;
    this.crisis.votes[userId] = choice;
    this.persist();
    return true;
  }

  resolveCrisisIfExpired(): CrisisOutcome | undefined {
    const crisis = this.crisis;
    if (!crisis || this.clock() < crisis.ends_at) return undefined;
    const existingVotes = Object.values(crisis.votes).filter((vote) => vote === "existing").length;
    const proposedVotes = Object.values(crisis.votes).filter((vote) => vote === "proposed").length;
    const proposedWins = proposedVotes > existingVotes;
    const winner = proposedWins ? crisis.proposed : crisis.existing;
    const loser = proposedWins ? crisis.existing : crisis.proposed;
    const endedAt = this.clock();
    this.history.push({
      ...loser,
      repealed_at: endedAt,
      overruled_by: winner.id,
      reason: `overruled by ${winner.id}`
    });
    if (proposedWins) {
      this.active.set(crisis.zone, crisis.proposed);
      this.eventCounts.delete(crisis.existing.id);
      this.chatTimes.delete(crisis.existing.id);
    }
    this.crisis = undefined;
    this.persist();
    return {
      winner: structuredClone(winner),
      loser: structuredClone(loser),
      winner_choice: proposedWins ? "proposed" : "existing",
      existing_votes: existingVotes,
      proposed_votes: proposedVotes
    };
  }

  cancelCrisis(): CrisisSnapshot | undefined {
    const current = this.currentCrisis;
    if (!this.crisis) return undefined;
    this.crisis = undefined;
    this.persist();
    return current;
  }

  clearAllLaws(): void {
    this.nextId = 1;
    this.active.clear();
    this.history = [];
    this.crisis = undefined;
    this.eventCounts.clear();
    this.chatTimes.clear();
    this.processedMessageIds.clear();
    this.persist();
  }

  add(rule: Rule, rawText: string, compilerPath: CompilerPath = "parser", proposerName = "unknown"): AddLawResult {
    if (rule.status !== "ok") throw new Error(`Cannot add a rule with status ${rule.status}`);
    const timestamp = this.clock();
    const zone = zoneForPart(rule.mutation.part_id);
    const law: ActiveLaw = {
      ...structuredClone(rule),
      id: `law-${this.nextId++}`,
      raw_text: rawText,
      zone,
      timestamp,
      compiler_path: compilerPath,
      proposer_name: proposerName
    };
    const previous = this.active.get(zone);
    let replaced: HistoricalLaw | undefined;
    let conflict: LawConflict | undefined;

    if (previous) {
      replaced = {
        ...previous,
        repealed_at: timestamp,
        overruled_by: law.id,
        reason: `overruled by ${law.id}`
      };
      this.history.push(replaced);
      conflict = {
        type: "crisis",
        zone,
        previous_law_id: previous.id,
        replacement_law_id: law.id
      };
    }

    this.active.set(zone, law);
    this.eventCounts.delete(previous?.id ?? "");
    this.chatTimes.delete(previous?.id ?? "");
    this.persist();
    return { law, ...(replaced ? { replaced } : {}), ...(conflict ? { conflict } : {}) };
  }

  handleEvent(event: EngineEvent): EventResult {
    const now = this.clock();
    const eventTime = event.timestamp === undefined
      ? now
      : typeof event.timestamp === "number" ? event.timestamp : Date.parse(event.timestamp);
    if (!Number.isFinite(eventTime) || now - eventTime > TEN_MINUTES_MS) {
      return { ignored: true, reason: "stale", fired: [] };
    }

    if (event.message_id) {
      if (this.processedMessageIds.has(event.message_id)) return { ignored: true, reason: "duplicate", fired: [] };
      this.processedMessageIds.add(event.message_id);
      while (this.processedMessageIds.size > this.dedupeLimit) {
        const oldest = this.processedMessageIds.values().next().value as string | undefined;
        if (oldest === undefined) break;
        this.processedMessageIds.delete(oldest);
      }
    }

    const fired: ActiveLaw[] = [];
    for (const law of this.active.values()) {
      if (law.status !== "ok" || law.trigger.event_type !== event.event_type) continue;
      if (event.event_type === "channel.chat.message") {
        const previousTimes = this.chatTimes.get(law.id) ?? [];
        const windowStart = eventTime - CHAT_WINDOW_MS;
        const previousCount = previousTimes.filter((time) => time > windowStart).length;
        const times = [...previousTimes.filter((time) => time > windowStart), eventTime];
        this.chatTimes.set(law.id, times);
        if (previousCount < law.trigger.threshold && times.length >= law.trigger.threshold) fired.push(law);
      } else {
        const count = (this.eventCounts.get(law.id) ?? 0) + 1;
        if (count >= law.trigger.threshold) {
          this.eventCounts.set(law.id, 0);
          fired.push(law);
        } else {
          this.eventCounts.set(law.id, count);
        }
      }
    }
    return { ignored: false, fired };
  }

  private load(): void {
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, "utf8")) as PersistedState;
      if (parsed.version !== 1 || !Array.isArray(parsed.active) || !Array.isArray(parsed.history)) return;
      this.nextId = Math.max(1, parsed.nextId);
      this.active = new Map(parsed.active.map((law) => [law.zone, { ...law, compiler_path: normalizeCompilerPath(law.compiler_path) }]));
      this.history = parsed.history.map((law) => ({ ...law, compiler_path: normalizeCompilerPath(law.compiler_path) }));
      this.crisis = parsed.crisis;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  private persist(): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const state: PersistedState = {
      version: 1,
      nextId: this.nextId,
      active: this.activeLaws,
      history: this.history,
      ...(this.crisis ? { crisis: this.crisis } : {})
    };
    writeFileSync(this.filePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  }
}

function normalizeCompilerPath(path: string | undefined): CompilerPath {
  if (path === "model (verified)" || path === "parser (model rejected)") return path;
  return "parser";
}
