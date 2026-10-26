import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TemplateCompiler } from "../src/compiler/template.js";
import type { EventType, Rule } from "../src/compiler/types.js";
import { buildConstitution } from "../src/constitution.js";
import { computeDesire, satisfiesDesire } from "../src/desire.js";
import { RuleEngine } from "../src/engine.js";
import { createLawBannerPayload } from "../src/law-banner.js";
import { createLawToast } from "../src/law-toast.js";

const compiler = new TemplateCompiler();

async function rule(text: string): Promise<Rule> {
  const compiled = await compiler.compile(text);
  expect(compiled.status).toBe("ok");
  return compiled;
}

function engineAt(clock: () => number) {
  return new RuleEngine({ filePath: join(mkdtempSync(join(tmpdir(), "beast-polish-")), "beast.json"), clock });
}

describe("computeDesire", () => {
  it("wants its first law when nothing has happened", () => {
    expect(computeDesire([], "unformed", null)).toEqual({ trigger: null, text: "The beast wants its first law." });
    expect(computeDesire([], "unformed", "Pebble").text).toBe("Pebble wants its first law.");
  });

  it("craves what its temperament craves, skipping triggers already covered", () => {
    expect(computeDesire(["channel.follow"], "fierce", "Pebble")).toEqual({ trigger: "channel.raid", text: "Pebble wants a law about raids." });
    expect(computeDesire(["channel.raid"], "fierce", null).trigger).toBe("channel.cheer");
    expect(computeDesire(["channel.follow"], "calm", null).trigger).toBe("channel.chat.message");
    expect(computeDesire(["channel.raid"], "chaotic", null).trigger).toBe("channel.hype_train.begin");
    expect(computeDesire(["channel.follow"], "steady", null).trigger).toBe("channel.subscribe");
  });

  it("always has something to want, even with every zone filled", () => {
    const five: EventType[] = ["channel.follow", "channel.subscribe", "channel.raid", "channel.cheer", "channel.chat.message"];
    for (const mood of ["fierce", "calm", "chaotic", "steady"] as const) {
      const desire = computeDesire(five, mood, null);
      expect(desire.trigger).not.toBeNull();
      expect(five).not.toContain(desire.trigger);
    }
  });

  it("is satisfied only by a law that uses the wanted trigger", () => {
    const desire = computeDesire(["channel.follow"], "fierce", null);
    expect(satisfiesDesire(desire, "channel.raid")).toBe(true);
    expect(satisfiesDesire(desire, "channel.follow")).toBe(false);
    expect(satisfiesDesire(null, "channel.raid")).toBe(false);
    expect(satisfiesDesire({ trigger: null, text: "x" }, "channel.raid")).toBe(false);
  });
});

describe("law banner caption", () => {
  it("carries the article number, title and vote result, and never viewer text", async () => {
    const engine = engineAt(() => 1_700_000_000_000);
    const { law } = engine.add(await rule("every follow gives the beast horns"), "every follow gives the beast horns VIEWER-SECRET", "parser", "alice");
    const banner = createLawBannerPayload("passed", law, { voteSummary: "passed 7-2", now: 1_700_000_000_000 });
    expect(banner).toMatchObject({ article: 1, law_title: "Follower's Yellow Horns", vote_summary: "passed 7-2", proposer_name: "alice", headline: "LAW PASSED" });
    expect(JSON.stringify(banner)).not.toContain("VIEWER-SECRET");
  });

  it("omits the vote summary when there is none", async () => {
    const engine = engineAt(() => 1_700_000_000_000);
    const { law } = engine.add(await rule("subs grow wings"), "subs grow wings", "parser", "bob");
    expect(createLawBannerPayload("passed", law)).not.toHaveProperty("vote_summary");
  });
});

describe("law toast sponsor", () => {
  it("names the sponsor even for simulated events, and the actor only for real ones", async () => {
    const engine = engineAt(() => 1_700_000_000_000);
    const { law } = engine.add(await rule("every follow gives the beast horns"), "x", "parser", "carol");
    const real = createLawToast(law, "dave", false, 1000);
    expect(real).toMatchObject({ triggered_by: "dave", sponsor: "carol", simulated: false });
    const simulated = createLawToast(law, undefined, true, 1000);
    expect(simulated.sponsor).toBe("carol");
    expect(simulated).not.toHaveProperty("triggered_by");
    const anonymous = engineAt(() => 1).add(await rule("subs grow wings"), "x").law;
    expect(createLawToast(anonymous, "dave", false, 1000)).not.toHaveProperty("sponsor");
  });
});

describe("constitution cover", () => {
  it("is empty before any law", () => {
    const document = buildConstitution({ beastName: null, active: [], history: [], temperamentLabel: "Unformed" });
    expect(document.cover).toEqual({ beast_name: null, temperament: "Unformed", ratified_at: null, integrity_percent: null, laws_written: 0, laws_in_force: 0 });
  });

  it("reports ratification date, integrity and counts", async () => {
    let now = Date.UTC(2026, 9, 27, 9, 30, 0);
    const engine = engineAt(() => now);
    engine.add(await rule("every follow gives the beast horns"), "x", "parser", "a");
    now += 3_600_000;
    engine.add(await rule("subs grow wings"), "x", "parser", "b");
    now += 3_600_000;
    engine.add(await rule("raids give the beast a green shell"), "x", "parser", "c"); // replaces wings in the back zone
    now += 3_600_000;
    engine.repeal("law-1");
    const document = buildConstitution({ beastName: "Pebble", active: engine.activeLaws, history: engine.lawHistory, temperamentLabel: "Wary · Chaotic" });
    expect(document.cover).toEqual({
      beast_name: "Pebble",
      temperament: "Wary · Chaotic",
      ratified_at: "2026-10-27T09:30:00.000Z",
      integrity_percent: 33,
      laws_written: 3,
      laws_in_force: 1
    });
  });
});
