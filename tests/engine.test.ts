import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RuleEngine } from "../src/engine.js";
import { TemplateCompiler } from "../src/compiler/template.js";
import type { Rule } from "../src/compiler/types.js";

const temporaryDirectories: string[] = [];

function temporaryFile(): string {
  const directory = mkdtempSync(join(tmpdir(), "constitution-beast-"));
  temporaryDirectories.push(directory);
  return join(directory, "data", "beast.json");
}

function rule(partId: Rule["mutation"]["part_id"], threshold = 1, eventType: Rule["trigger"]["event_type"] = "channel.follow"): Rule {
  return {
    status: "ok",
    trigger: { event_type: eventType, threshold },
    action: { type: "confetti", intensity: "low" },
    mutation: { part_id: partId, color: "yellow" }
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("RuleEngine", () => {
  it("replaces a law in an occupied zone and records its repeal", () => {
    let now = 1_000;
    const engine = new RuleEngine({ filePath: temporaryFile(), clock: () => now });
    const first = engine.add(rule("wings"), "first wings law");
    now += 1_000;
    const second = engine.add(rule("tail"), "replacement tail law");

    expect(engine.activeLaws).toHaveLength(1);
    expect(engine.activeLaws[0].id).toBe(second.law.id);
    expect(second.replaced?.id).toBe(first.law.id);
    expect(second.replaced?.overruled_by).toBe(second.law.id);
    expect(second.replaced?.reason).toBe(`overruled by ${second.law.id}`);
    expect(second.conflict).toMatchObject({ type: "crisis", zone: "back" });
  });

  it.each([
    { laws: ["when someone subs grow wings", "when someone follows grow a tail"], zone: "back" },
    { laws: ["subs grow horns", "raids grow red eyes"], zone: "head" }
  ])("detects the contract conflict in the $zone zone", async ({ laws, zone }) => {
    let now = 50_000;
    const compiler = new TemplateCompiler();
    const engine = new RuleEngine({ filePath: temporaryFile(), clock: () => now++ });
    const first = await compiler.compile(laws[0]);
    const second = await compiler.compile(laws[1]);
    engine.add(first, laws[0]);
    const replacement = engine.add(second, laws[1]);

    expect(replacement.conflict).toMatchObject({ type: "crisis", zone });
  });

  it("fires thresholded events after the requested count", () => {
    const engine = new RuleEngine({ filePath: temporaryFile() });
    const law = engine.add(rule("horns", 2), "two follows").law;

    expect(engine.handleEvent({ event_type: "channel.follow" }).fired).toEqual([]);
    expect(engine.handleEvent({ event_type: "channel.follow" }).fired.map((item) => item.id)).toEqual([law.id]);
    expect(engine.handleEvent({ event_type: "channel.follow" }).fired).toEqual([]);
  });

  it("fires chat thresholds using a sliding one-minute window", () => {
    let now = 100_000;
    const engine = new RuleEngine({ filePath: temporaryFile(), clock: () => now });
    const law = engine.add(rule("runes", 2, "channel.chat.message"), "two messages per minute").law;
    expect(engine.handleEvent({ event_type: "channel.chat.message", timestamp: now }).fired).toEqual([]);
    now += 10_000;
    expect(engine.handleEvent({ event_type: "channel.chat.message", timestamp: now }).fired[0].id).toBe(law.id);
    now += 61_000;
    expect(engine.handleEvent({ event_type: "channel.chat.message", timestamp: now }).fired).toEqual([]);
  });

  it("deduplicates message IDs and ignores events older than ten minutes", () => {
    const now = 1_000_000;
    const engine = new RuleEngine({ filePath: temporaryFile(), clock: () => now, dedupeLimit: 2 });
    const law = engine.add(rule("horns"), "follow law").law;
    const event = { event_type: "channel.follow" as const, message_id: "message-1", timestamp: now };
    expect(engine.handleEvent(event).fired[0].id).toBe(law.id);
    expect(engine.handleEvent(event)).toMatchObject({ ignored: true, reason: "duplicate", fired: [] });
    expect(engine.handleEvent({ event_type: "channel.follow", timestamp: now - 10 * 60 * 1000 - 1 })).toMatchObject({ ignored: true, reason: "stale", fired: [] });
  });

  it("persists and reloads active laws, history, and the next ID", () => {
    const filePath = temporaryFile();
    let now = 500;
    const firstEngine = new RuleEngine({ filePath, clock: () => now });
    firstEngine.add(rule("wings"), "old law");
    now++;
    const replacement = firstEngine.add(rule("tail"), "new law");
    const raw = JSON.parse(readFileSync(filePath, "utf8")) as { active: unknown[]; history: unknown[] };
    const loaded = new RuleEngine({ filePath, clock: () => now });
    const reloadedId = loaded.activeLaws[0].id;
    const reloadedOverruledBy = loaded.lawHistory[0].overruled_by;
    const next = loaded.add(rule("shell"), "next law");

    expect(raw.active).toHaveLength(1);
    expect(raw.history).toHaveLength(1);
    expect(reloadedId).toBe(replacement.law.id);
    expect(reloadedOverruledBy).toBe(replacement.law.id);
    expect(next.law.id).not.toBe(reloadedId);
  });
});
