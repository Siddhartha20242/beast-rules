import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { zoneForPart, type Zone } from "./schema.js";
import type { EventType, Rule } from "./compiler/types.js";

const TEN_MINUTES_MS = 10 * 60 * 1000;
const CHAT_WINDOW_MS = 60 * 1000;

export interface ActiveLaw extends Rule {
  id: string;
  raw_text: string;
  zone: Zone;
  timestamp: number;
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
}

export class RuleEngine {
  private readonly filePath: string;
  private readonly clock: () => number;
  private readonly dedupeLimit: number;
  private nextId = 1;
  private active = new Map<Zone, ActiveLaw>();
  private history: HistoricalLaw[] = [];
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

  add(rule: Rule, rawText: string): AddLawResult {
    if (rule.status !== "ok") throw new Error(`Cannot add a rule with status ${rule.status}`);
    const timestamp = this.clock();
    const zone = zoneForPart(rule.mutation.part_id);
    const law: ActiveLaw = {
      ...structuredClone(rule),
      id: `law-${this.nextId++}`,
      raw_text: rawText,
      zone,
      timestamp
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
      this.active = new Map(parsed.active.map((law) => [law.zone, law]));
      this.history = parsed.history;
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
      history: this.history
    };
    writeFileSync(this.filePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  }
}
