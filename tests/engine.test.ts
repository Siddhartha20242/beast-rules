import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RuleEngine } from "../src/engine.js";
import { TemplateCompiler } from "../src/compiler/template.js";
import type { Rule } from "../src/compiler/types.js";

const temporaryDirectories: string[] = [];

function temporaryFile(): string {
  const directory = mkdtempSync(join(tmpdir(), "beast-rules-"));
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
  it("stores proposer attribution on an enacted law", () => {
    const engine = new RuleEngine({ filePath: temporaryFile(), clock: () => 1000 });
    const enacted = engine.add(rule("wings"), "follow law", "parser", "alice").law;
    expect(enacted.proposer_name).toBe("alice");
  });

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

  it("keeps proposer attribution absent on laws persisted before attribution existed", () => {
    const filePath = temporaryFile();
    const legacyLaw = { ...rule("wings"), id: "law-1", raw_text: "legacy law", zone: "back", timestamp: 10, compiler_path: "parser" };
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, JSON.stringify({ version: 1, nextId: 2, active: [legacyLaw], history: [] }));
    const engine = new RuleEngine({ filePath });
    expect(engine.activeLaws[0]?.proposer_name).toBeUndefined();
  });

  it("clears active laws, history, and crisis state on reset", () => {
    const filePath = temporaryFile();
    const engine = new RuleEngine({ filePath, clock: () => 500 });
    engine.add(rule("wings"), "active law");
    engine.add(rule("tail"), "replacement law");
    engine.clearAllLaws();
    expect(engine.activeLaws).toEqual([]);
    expect(engine.lawHistory).toEqual([]);
    expect(new RuleEngine({ filePath }).activeLaws).toEqual([]);
  });

  it("cancels a live crisis and persists the cancellation", () => {
    const filePath = temporaryFile();
    const engine = new RuleEngine({ filePath, clock: () => 500 });
    engine.add(rule("wings"), "old law");
    engine.beginCrisis(rule("tail"), "new law", 10);
    expect(engine.cancelCrisis()?.proposed.raw_text).toBe("new law");
    expect(new RuleEngine({ filePath, clock: () => 500 }).currentCrisis).toBeUndefined();
  });

  it("starts a crisis for a passed replacement while keeping the old law active", () => {
    const now = 10_000;
    const engine = new RuleEngine({ filePath: temporaryFile(), clock: () => now });
    const existing = engine.add(rule("wings"), "existing wings law").law;
    const started = engine.beginCrisis(rule("tail"), "new tail law", 20);

    expect(started.status).toBe("started");
    expect(engine.activeLaws[0].id).toBe(existing.id);
    expect(engine.currentCrisis).toMatchObject({
      existing: { raw_text: "existing wings law" },
      proposed: { raw_text: "new tail law" },
      existing_votes: 0,
      proposed_votes: 0,
      seconds_left: 20
    });
  });

  it("continues firing the existing law while crisis voting is open", () => {
    const engine = new RuleEngine({ filePath: temporaryFile(), clock: () => 10_000 });
    const existing = engine.add(rule("wings"), "existing follow law").law;
    engine.beginCrisis(rule("tail"), "proposed follow law", 20);

    expect(engine.handleEvent({ event_type: "channel.follow" }).fired.map((law) => law.id)).toEqual([existing.id]);
  });

  it("keeps the existing law when it wins", () => {
    let now = 1_000;
    const engine = new RuleEngine({ filePath: temporaryFile(), clock: () => now });
    const existing = engine.add(rule("wings"), "existing law").law;
    engine.beginCrisis(rule("tail"), "new law", 10);
    expect(engine.castCrisisVote("viewer-1", "existing")).toBe(true);
    now += 10_000;

    const outcome = engine.resolveCrisisIfExpired();
    expect(outcome).toMatchObject({ winner_choice: "existing", winner: { id: existing.id } });
    expect(engine.activeLaws[0].id).toBe(existing.id);
    expect(engine.lawHistory[0]).toMatchObject({ overruled_by: existing.id, reason: `overruled by ${existing.id}` });
  });

  it("activates the new law when it wins", () => {
    let now = 1_000;
    const engine = new RuleEngine({ filePath: temporaryFile(), clock: () => now });
    const existing = engine.add(rule("wings"), "existing law").law;
    const started = engine.beginCrisis(rule("tail"), "new law", 10);
    expect(started.status).toBe("started");
    const proposed = started.status === "started" ? started.crisis.proposed : undefined;
    engine.castCrisisVote("viewer-1", "proposed");
    now += 10_000;

    expect(engine.resolveCrisisIfExpired()).toMatchObject({ winner_choice: "proposed", winner: { id: proposed?.id } });
    expect(engine.activeLaws[0].id).toBe(proposed?.id);
    expect(engine.lawHistory[0]).toMatchObject({ id: existing.id, overruled_by: proposed?.id });
  });

  it("keeps the existing law on a tie", () => {
    let now = 1_000;
    const engine = new RuleEngine({ filePath: temporaryFile(), clock: () => now });
    const existing = engine.add(rule("wings"), "existing law").law;
    engine.beginCrisis(rule("tail"), "new law", 10);
    engine.castCrisisVote("viewer-1", "existing");
    engine.castCrisisVote("viewer-2", "proposed");
    now += 10_000;

    expect(engine.resolveCrisisIfExpired()).toMatchObject({ winner_choice: "existing", existing_votes: 1, proposed_votes: 1 });
    expect(engine.activeLaws[0].id).toBe(existing.id);
  });

  it("accepts one crisis vote per user", () => {
    const engine = new RuleEngine({ filePath: temporaryFile(), clock: () => 1_000 });
    engine.add(rule("wings"), "existing law");
    engine.beginCrisis(rule("tail"), "new law", 10);
    expect(engine.castCrisisVote("viewer", "existing")).toBe(true);
    expect(engine.castCrisisVote("viewer", "proposed")).toBe(false);
    expect(engine.currentCrisis).toMatchObject({ existing_votes: 1, proposed_votes: 0 });
  });

  it("rejects a new proposal while a crisis is active", () => {
    const engine = new RuleEngine({ filePath: temporaryFile(), clock: () => 1_000 });
    engine.add(rule("wings"), "existing law");
    expect(engine.beginCrisis(rule("tail"), "first replacement", 10).status).toBe("started");
    expect(engine.beginCrisis(rule("horns"), "queued proposal", 10).status).toBe("busy");
    expect(engine.activeLaws).toHaveLength(1);
    expect(engine.currentCrisis?.proposed.raw_text).toBe("first replacement");
  });

  it("persists an active crisis and its votes across reload", () => {
    let now = 1_000;
    const filePath = temporaryFile();
    const engine = new RuleEngine({ filePath, clock: () => now });
    const existing = engine.add(rule("wings"), "existing law").law;
    const started = engine.beginCrisis(rule("tail"), "new law", 20);
    expect(started.status).toBe("started");
    engine.castCrisisVote("viewer-1", "proposed");

    const loaded = new RuleEngine({ filePath, clock: () => now });
    expect(loaded.currentCrisis).toMatchObject({
      existing: { id: existing.id },
      proposed: { raw_text: "new law" },
      proposed_votes: 1,
      seconds_left: 20
    });
    expect(loaded.castCrisisVote("viewer-1", "existing")).toBe(false);
    now += 20_000;
    expect(loaded.resolveCrisisIfExpired()?.winner_choice).toBe("proposed");
    expect(loaded.activeLaws[0].raw_text).toBe("new law");
  });
});
