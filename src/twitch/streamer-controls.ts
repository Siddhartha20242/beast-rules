import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export type StreamerRole = "broadcaster" | "moderator" | "viewer";
export type StreamerCommand = "pause" | "resume" | "reset" | "reset_confirm" | "veto";

interface PersistedStreamerState {
  version: 1;
  paused: boolean;
  resetUntil?: number;
  resetRequestedBy?: string;
}

export function hasModeratorBadge(payload: unknown): boolean {
  const outer = object(payload);
  const event = object(outer.event ?? payload);
  const userInfo = object(event.userInfo ?? event.user_info);
  if (userInfo.isModerator === true || userInfo.is_moderator === true) return true;
  const badges = Array.isArray(event.badges) ? event.badges : Array.isArray(event.user_badges) ? event.user_badges : [];
  return badges.some((item) => {
    const badge = object(item);
    const badgeSet = badge.set_id ?? badge.setId ?? badge.id;
    return badgeSet === "moderator" || badgeSet === "broadcaster";
  });
}

export function streamerRole(userId: string, broadcasterId: string, moderatorBadge: boolean): StreamerRole {
  if (broadcasterId && userId === broadcasterId) return "broadcaster";
  return moderatorBadge ? "moderator" : "viewer";
}

export function parseStreamerCommand(text: string): StreamerCommand | undefined {
  const command = text.trim().toLowerCase();
  if (command === "!beast pause") return "pause";
  if (command === "!beast resume") return "resume";
  if (command === "!beast reset") return "reset";
  if (command === "!beast reset confirm") return "reset_confirm";
  if (command === "!beast veto") return "veto";
  return undefined;
}

export class StreamerControlState {
  private readonly filePath: string;
  private readonly clock: () => number;
  private pausedValue = false;
  private resetUntil: number | undefined;
  private resetRequestedBy: string | undefined;

  constructor(filePath = resolve("data/streamer-controls.json"), clock: () => number = Date.now) {
    this.filePath = filePath;
    this.clock = clock;
    this.load();
  }

  get paused(): boolean { return this.pausedValue; }

  setPaused(paused: boolean): boolean {
    const changed = this.pausedValue !== paused;
    this.pausedValue = paused;
    this.persist();
    return changed;
  }

  requestReset(userId: string): void {
    this.resetUntil = this.clock() + 15_000;
    this.resetRequestedBy = userId;
    this.persist();
  }

  confirmReset(userId: string): boolean {
    if (this.resetUntil === undefined) return false;
    if (this.clock() > this.resetUntil) {
      this.resetUntil = undefined;
      this.resetRequestedBy = undefined;
      this.persist();
      return false;
    }
    if (this.resetRequestedBy !== userId) return false;
    this.resetUntil = undefined;
    this.resetRequestedBy = undefined;
    this.persist();
    return true;
  }

  private load(): void {
    try {
      const state = JSON.parse(readFileSync(this.filePath, "utf8")) as PersistedStreamerState;
      if (state.version !== 1 || typeof state.paused !== "boolean") return;
      this.pausedValue = state.paused;
      if (typeof state.resetUntil === "number" && typeof state.resetRequestedBy === "string" && state.resetUntil >= this.clock()) {
        this.resetUntil = state.resetUntil;
        this.resetRequestedBy = state.resetRequestedBy;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  private persist(): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const state: PersistedStreamerState = {
      version: 1,
      paused: this.pausedValue,
      ...(this.resetUntil === undefined ? {} : { resetUntil: this.resetUntil }),
      ...(this.resetRequestedBy === undefined ? {} : { resetRequestedBy: this.resetRequestedBy })
    };
    writeFileSync(this.filePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  }
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}
