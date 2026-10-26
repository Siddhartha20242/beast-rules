import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BallotManager, ballotForSnapshot, shouldOpenBallot, suggestLaws, type BallotOption } from "../src/ballot.js";
import { TemplateCompiler } from "../src/compiler/template.js";
import type { EventType, PartId } from "../src/compiler/types.js";
import { RuleEngine } from "../src/engine.js";
import { zoneForPart } from "../src/schema.js";

const compiler = new TemplateCompiler();

function clockAt(start = 1_000_000) {
  let now = start;
  return { now: () => now, advance: (ms: number) => { now += ms; } };
}

async function sampleOptions(seed = 0): Promise<BallotOption[]> {
  return suggestLaws({ activeParts: [], seed, compiler });
}

describe("suggestLaws", () => {
  it("returns three suggestions that all compile on the real parser", async () => {
    for (let seed = 0; seed < 25; seed += 1) {
      const options = await sampleOptions(seed);
      expect(options, `seed ${seed}`).toHaveLength(3);
      for (const option of options) {
        const recompiled = await compiler.compile(option.text);
        expect(recompiled.status).toBe("ok");
        expect(recompiled.mutation.part_id).toBe(option.rule.mutation.part_id);
        expect(recompiled.trigger.event_type).toBe(option.rule.trigger.event_type);
      }
      expect(options.map((option) => option.number)).toEqual([1, 2, 3]);
    }
  });

  it("is deterministic for the same seed and beast, and changes with the seed", async () => {
    const first = await sampleOptions(4);
    const again = await sampleOptions(4);
    expect(first.map((option) => option.text)).toEqual(again.map((option) => option.text));
    const other = await sampleOptions(5);
    expect(other.map((option) => option.text)).not.toEqual(first.map((option) => option.text));
  });

  it("prefers empty zones and never suggests a part already on the beast", async () => {
    const activeParts: PartId[] = ["horns", "wings"];
    for (let seed = 0; seed < 15; seed += 1) {
      const options = await suggestLaws({ activeParts, seed, compiler });
      expect(options).toHaveLength(3);
      for (const option of options) {
        const part = option.rule.mutation.part_id;
        expect(activeParts).not.toContain(part);
        expect(["head", "back"]).not.toContain(zoneForPart(part));
      }
      expect(new Set(options.map((option) => zoneForPart(option.rule.mutation.part_id))).size).toBe(3);
    }
  });

  it("still returns suggestions when every zone is taken (they would replace a part)", async () => {
    const activeParts: PartId[] = ["horns", "spikes", "wings", "tentacles", "flames"];
    const options = await suggestLaws({ activeParts, seed: 2, compiler });
    expect(options.length).toBeGreaterThanOrEqual(2);
    for (const option of options) expect(activeParts).not.toContain(option.rule.mutation.part_id);
  });

  it("favours event types that happened recently", async () => {
    const recentEvents: EventType[] = ["channel.chat.message", "channel.raid"];
    const options = await suggestLaws({ activeParts: [], recentEvents, seed: 0, compiler });
    const triggers = options.map((option) => option.rule.trigger.event_type);
    expect(triggers).toContain("channel.raid");
  });
});

describe("BallotManager", () => {
  it("opens, counts one vote per viewer, and closes on schedule", async () => {
    const clock = clockAt();
    const ballot = new BallotManager({ ballotSeconds: 20, clock: clock.now });
    expect(ballot.open(await sampleOptions())).toBe(true);
    expect(ballot.open(await sampleOptions())).toBe(false);
    expect(ballot.vote("a", 2)).toBe(true);
    expect(ballot.vote("a", 3)).toBe(false);
    expect(ballot.vote("b", 2)).toBe(true);
    expect(ballot.vote("c", 1)).toBe(true);
    expect(ballot.vote("d", 4)).toBe(false);
    expect(ballot.current?.votes).toEqual([1, 2, 0]);
    expect(ballot.closeIfExpired()).toBeUndefined();
    clock.advance(20_000);
    const outcome = ballot.closeIfExpired();
    expect(outcome?.winner?.number).toBe(2);
    expect(outcome?.total).toBe(3);
    expect(ballot.isOpen).toBe(false);
    expect(ballot.vote("e", 1)).toBe(false);
  });

  it("breaks ties toward the lowest number", async () => {
    const clock = clockAt();
    const ballot = new BallotManager({ ballotSeconds: 5, clock: clock.now });
    ballot.open(await sampleOptions());
    ballot.vote("a", 3);
    ballot.vote("b", 2);
    clock.advance(5_000);
    expect(ballot.closeIfExpired()?.winner?.number).toBe(2);
  });

  it("has no winner without any votes", async () => {
    const clock = clockAt();
    const ballot = new BallotManager({ ballotSeconds: 5, clock: clock.now });
    ballot.open(await sampleOptions());
    clock.advance(5_000);
    const outcome = ballot.closeIfExpired();
    expect(outcome?.winner).toBeUndefined();
    expect(outcome?.total).toBe(0);
  });

  it("refuses to open with fewer than two options, and can be cancelled", async () => {
    const ballot = new BallotManager({ clock: clockAt().now });
    expect(ballot.open((await sampleOptions()).slice(0, 1))).toBe(false);
    expect(ballot.open(await sampleOptions())).toBe(true);
    expect(ballot.cancel()).toBe(true);
    expect(ballot.isOpen).toBe(false);
  });

  it("produces a client-safe payload with canonical descriptions only", async () => {
    const clock = clockAt();
    const ballot = new BallotManager({ clock: clock.now });
    const options = await sampleOptions(1);
    ballot.open(options);
    ballot.vote("a", 1);
    const payload = ballotForSnapshot(ballot.current);
    expect(payload?.options).toHaveLength(3);
    expect(payload?.options[0]).toMatchObject({ number: 1, votes: 1 });
    const wire = JSON.stringify(payload);
    for (const option of options) expect(wire).not.toContain(option.text);
    expect(wire).not.toContain("raw_text");
    expect(ballotForSnapshot(undefined)).toBeNull();
  });
});

describe("shouldOpenBallot", () => {
  const base = { now: 10_000, nextAt: 9_000, ballotMinutes: 5, voteActive: false, crisisActive: false, paused: false, ballotOpen: false };

  it("opens only when due and nothing else is going on", () => {
    expect(shouldOpenBallot(base)).toBe(true);
    expect(shouldOpenBallot({ ...base, now: 8_000 })).toBe(false);
    expect(shouldOpenBallot({ ...base, voteActive: true })).toBe(false);
    expect(shouldOpenBallot({ ...base, crisisActive: true })).toBe(false);
    expect(shouldOpenBallot({ ...base, paused: true })).toBe(false);
    expect(shouldOpenBallot({ ...base, ballotOpen: true })).toBe(false);
    expect(shouldOpenBallot({ ...base, ballotMinutes: 0 })).toBe(false);
  });
});

describe("RuleEngine.repeal", () => {
  function freshEngine() {
    return new RuleEngine({ filePath: join(mkdtempSync(join(tmpdir(), "beast-repeal-")), "beast.json"), clock: () => 1_000_000 });
  }

  it("removes an active law, keeps it in history as repealed, and frees the zone", async () => {
    const engine = freshEngine();
    const rule = await compiler.compile("when someone subs grow wings and shake the screen");
    const { law } = engine.add(rule, "when someone subs grow wings and shake the screen");
    const record = engine.repeal(law.id);
    expect(record).toMatchObject({ id: law.id, overruled_by: "repealed", reason: "repealed by vote" });
    expect(engine.activeLaws).toHaveLength(0);
    expect(engine.lawHistory).toHaveLength(1);
    const second = engine.add(await compiler.compile("subs grow a green tail"), "subs grow a green tail");
    expect(second.replaced).toBeUndefined();
  });

  it("stops the repealed law from firing", async () => {
    const engine = freshEngine();
    const { law } = engine.add(await compiler.compile("every follow gives the beast horns"), "every follow gives the beast horns");
    expect(engine.handleEvent({ event_type: "channel.follow", message_id: "f1" }).fired.map((item) => item.id)).toEqual([law.id]);
    engine.repeal(law.id);
    expect(engine.handleEvent({ event_type: "channel.follow", message_id: "f2" }).fired).toEqual([]);
  });

  it("returns undefined for an unknown or already repealed id, and survives a reload", async () => {
    const dir = mkdtempSync(join(tmpdir(), "beast-repeal-"));
    const filePath = join(dir, "beast.json");
    const engine = new RuleEngine({ filePath, clock: () => 1_000_000 });
    const { law } = engine.add(await compiler.compile("raids give the beast a green shell"), "raids give the beast a green shell");
    expect(engine.repeal("law-99")).toBeUndefined();
    expect(engine.repeal(law.id)).toBeDefined();
    expect(engine.repeal(law.id)).toBeUndefined();
    const reloaded = new RuleEngine({ filePath, clock: () => 1_000_000 });
    expect(reloaded.activeLaws).toHaveLength(0);
    expect(reloaded.lawHistory[0]).toMatchObject({ id: law.id, overruled_by: "repealed" });
  });
});
