import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BeastProfile, NameVote, beastNameOptions, beastNames, nameVoteForSnapshot } from "../src/beast-profile.js";
import { parseChatCommand } from "../src/chat-commands.js";
import { TemplateCompiler } from "../src/compiler/template.js";
import type { Rule } from "../src/compiler/types.js";
import { buildConstitution, constitutionPanel, scarsByZone } from "../src/constitution.js";
import { lawForDisplay, lawTitle } from "../src/describe.js";
import { RuleEngine } from "../src/engine.js";
import { beastTongue, refusalForStatus } from "../src/refusals.js";
import { computeTemperament } from "../src/temperament.js";

const compiler = new TemplateCompiler();

async function rule(text: string): Promise<Rule> {
  const compiled = await compiler.compile(text);
  expect(compiled.status).toBe("ok");
  return compiled;
}

function tempEngine(clock = () => 1_700_000_000_000) {
  return new RuleEngine({ filePath: join(mkdtempSync(join(tmpdir(), "beast-char-")), "beast.json"), clock });
}

describe("lawTitle", () => {
  it("names a law from its trigger, color and part", async () => {
    expect(lawTitle(await rule("every follow gives the beast horns"))).toBe("Follower's Yellow Horns");
    expect(lawTitle(await rule("when someone subs give it a long pink tail"))).toBe("Subscriber's Pink Tail");
    expect(lawTitle(await rule("on a raid make the beast roar and grow flames"))).toBe("Raider's Yellow Flames");
    expect(lawTitle(await rule("when a hype train starts throw confetti and grow extra arms"))).toBe("Hype Train's Yellow Extra Arms");
  });

  it("is included in the client-safe law and never contains viewer text", async () => {
    const engine = tempEngine();
    const text = "when someone subs grow wings and shake the screen";
    const { law } = engine.add(await rule(text), `${text} SECRET-VIEWER-WORDS`, "parser", "alice");
    const display = lawForDisplay(law);
    expect(display.title).toBe("Subscriber's Yellow Wings");
    expect(JSON.stringify(display)).not.toContain("SECRET-VIEWER-WORDS");
  });
});

describe("computeTemperament", () => {
  const law = (part: string, action: string) => ({ mutation: { part_id: part }, action: { type: action } }) as never;

  it("is unformed with no laws and no history", () => {
    expect(computeTemperament([], 0)).toEqual({ ferocity: null, order: null, mood: "unformed", label: "Unformed" });
  });

  it("is fierce and orderly for aggressive parts with loud effects and no conflict", () => {
    const result = computeTemperament([law("horns", "beast_roar"), law("claws", "screen_shake")], 0);
    expect(result).toMatchObject({ ferocity: "Fierce", order: "Orderly", mood: "fierce", label: "Fierce · Orderly" });
  });

  it("is calm for gentle parts with quiet effects", () => {
    const result = computeTemperament([law("crown", "confetti"), law("runes", "confetti"), law("wings", "confetti")], 0);
    expect(result).toMatchObject({ ferocity: "Calm", mood: "calm" });
  });

  it("becomes restless, then chaotic, as repeals and overruled laws pile up", () => {
    const active = [law("crown", "confetti"), law("runes", "confetti"), law("wings", "confetti"), law("tail", "confetti")];
    expect(computeTemperament(active, 0).order).toBe("Orderly");
    expect(computeTemperament(active, 1).order).toBe("Restless");
    expect(computeTemperament(active, 4).order).toBe("Chaotic");
    expect(computeTemperament(active, 4).mood).toBe("chaotic");
  });

  it("is chaotic even with no active laws once history exists", () => {
    expect(computeTemperament([], 2)).toMatchObject({ order: "Chaotic", mood: "chaotic" });
  });
});

describe("beast names and the naming vote", () => {
  it("offers three distinct names from the fixed list, deterministically", () => {
    for (let seed = 0; seed < 30; seed += 1) {
      const names = beastNameOptions(seed);
      expect(names).toHaveLength(3);
      expect(new Set(names).size).toBe(3);
      for (const name of names) expect(beastNames as readonly string[]).toContain(name);
      expect(beastNameOptions(seed)).toEqual(names);
    }
    expect(beastNameOptions(1)).not.toEqual(beastNameOptions(2));
  });

  it("counts one vote each, breaks ties toward the lowest number, and needs a vote to name", () => {
    let now = 1_000_000;
    const vote = new NameVote({ seconds: 10, clock: () => now });
    expect(vote.open(["Gorgo", "Pip", "Ember"])).toBe(true);
    expect(vote.open(["Gorgo", "Pip", "Ember"])).toBe(false);
    expect(vote.vote("a", 3)).toBe(true);
    expect(vote.vote("a", 1)).toBe(false);
    expect(vote.vote("b", 2)).toBe(true);
    expect(vote.vote("c", 9)).toBe(false);
    expect(vote.closeIfExpired()).toBeUndefined();
    now += 10_000;
    expect(vote.closeIfExpired()).toMatchObject({ winner: "Pip", total: 2 });
    expect(vote.open(["Gorgo", "Pip", "Ember"])).toBe(true);
    now += 10_000;
    expect(vote.closeIfExpired()?.winner).toBeUndefined();
  });

  it("builds a client payload with only names from the list", () => {
    let now = 5_000;
    const vote = new NameVote({ seconds: 5, clock: () => now });
    vote.open(beastNameOptions(3));
    vote.vote("x", 2);
    const payload = nameVoteForSnapshot(vote.current);
    expect(payload).toMatchObject({ kind: "name", total: 1 });
    expect(payload?.options.map((option) => option.votes)).toEqual([0, 1, 0]);
    expect(nameVoteForSnapshot(undefined)).toBeNull();
    now += 5_000;
  });
});

describe("BeastProfile", () => {
  it("saves a name once, refuses unknown names and a second name, and survives a reload", () => {
    const filePath = join(mkdtempSync(join(tmpdir(), "beast-profile-")), "profile.json");
    const profile = new BeastProfile({ filePath, clock: () => 42 });
    expect(profile.name).toBeNull();
    expect(profile.setName("Definitely Not On The List")).toBe(false);
    expect(profile.setName("Gorgo")).toBe(true);
    expect(profile.setName("Pip")).toBe(false);
    expect(new BeastProfile({ filePath }).name).toBe("Gorgo");
    profile.clear();
    expect(new BeastProfile({ filePath }).name).toBeNull();
  });

  it("ignores a tampered or corrupt profile file instead of trusting it", () => {
    const filePath = join(mkdtempSync(join(tmpdir(), "beast-profile-")), "profile.json");
    writeFileSync(filePath, JSON.stringify({ version: 1, name: "<script>alert(1)</script>", namedAt: 1 }));
    expect(new BeastProfile({ filePath }).name).toBeNull();
    writeFileSync(filePath, "{not json");
    expect(new BeastProfile({ filePath }).name).toBeNull();
    expect(readFileSync(filePath, "utf8")).toContain("{not json");
  });
});

describe("constitution and scars", () => {
  it("lists active, repealed and overruled laws with titles, dates and proposers, and counts scars by zone", async () => {
    let now = Date.UTC(2026, 9, 27, 12, 0, 0);
    const engine = tempEngine(() => now);
    const wings = engine.add(await rule("when someone subs grow wings and shake the screen"), "x", "parser", "alice").law;
    now += 60_000;
    const horns = engine.add(await rule("every follow gives the beast horns"), "x", "parser", "bob").law;
    now += 60_000;
    engine.add(await rule("subs grow a green tail"), "x", "parser", "carol"); // replaces wings in the back zone
    now += 60_000;
    engine.repeal(horns.id);

    const document = buildConstitution({ beastName: "Gorgo", active: engine.activeLaws, history: engine.lawHistory });
    expect(document.title).toBe("Constitution of Gorgo");
    expect(document.summary).toEqual({ active: 1, repealed: 1, overruled: 1 });
    expect(document.articles.map((article) => article.id)).toEqual(["law-1", "law-2", "law-3"]);
    const byId = Object.fromEntries(document.articles.map((article) => [article.id, article]));
    expect(byId["law-1"]).toMatchObject({ title: "Subscriber's Yellow Wings", status: "overruled", proposer: "alice", note: "Overruled by law-3." });
    expect(byId["law-2"]).toMatchObject({ status: "repealed", proposer: "bob", note: "Repealed by a chat vote." });
    expect(byId["law-3"]).toMatchObject({ status: "active", proposer: "carol" });
    expect(byId["law-1"]?.enacted_at).toBe("2026-10-27T12:00:00.000Z");
    expect(document.scars).toEqual({ back: 1, head: 1 });
    expect(wings.zone).toBe("back");
  });

  it("never contains a viewer's raw sentence", async () => {
    const engine = tempEngine();
    engine.add(await rule("every follow gives the beast horns"), "every follow gives the beast horns AND OFFENSIVE-WORDS", "parser", "alice");
    const wire = JSON.stringify(buildConstitution({ beastName: null, active: engine.activeLaws, history: engine.lawHistory }));
    expect(wire).not.toContain("OFFENSIVE-WORDS");
    expect(wire).not.toContain("raw_text");
  });

  it("titles an unnamed beast generically and builds a short panel with a scar note", async () => {
    const engine = tempEngine();
    for (const text of ["every follow gives the beast horns", "subs grow wings", "raids give the beast a green shell", "10 cheers gives it blue tentacles and a screen shake", "follows make it grow scales and flash orange", "on a raid make the beast roar and grow flames", "chat spamming 50 messages a minute triggers dare 3 and claws"]) {
      engine.add(await rule(text), text, "parser", "viewer");
    }
    const document = buildConstitution({ beastName: null, active: engine.activeLaws, history: engine.lawHistory });
    expect(document.title).toBe("Constitution of the Beast");
    const panel = constitutionPanel(document, 4);
    expect(panel.title).toBe("CONSTITUTION OF THE BEAST");
    expect(panel.rows.length).toBeLessThanOrEqual(6);
    expect(panel.rows.some((row) => row.startsWith("…and"))).toBe(true);
    const empty = constitutionPanel(buildConstitution({ beastName: null, active: [], history: [] }));
    expect(empty.rows).toEqual(["No laws yet. Chat has not written anything."]);
  });

  it("scarsByZone counts every lost law", () => {
    expect(scarsByZone([{ zone: "head" }, { zone: "head" }, { zone: "aura" }])).toEqual({ head: 2, aura: 1 });
    expect(scarsByZone([])).toEqual({});
  });
});

describe("in-world refusals and the beast's tongue", () => {
  it("speaks as the beast and never echoes viewer text", () => {
    for (const status of ["unsupported_trigger", "unsupported_effect", "unsupported_part", "too_vague", "unsafe"] as const) {
      expect(refusalForStatus(status)).toMatch(/^The beast /);
    }
  });

  it("lists the whole vocabulary", () => {
    const text = beastTongue.join(" ");
    for (const word of ["follow", "raid", "hype train", "shake", "roar", "horns", "lightning", "red", "pink", "five zones"]) expect(text).toContain(word);
  });
});

describe("new chat commands", () => {
  it("recognises !constitution, !tongue and !name only on their own", () => {
    expect(parseChatCommand("!constitution")).toEqual({ kind: "constitution" });
    expect(parseChatCommand("  !CONSTITUTION ")).toEqual({ kind: "constitution" });
    expect(parseChatCommand("!tongue")).toEqual({ kind: "tongue" });
    expect(parseChatCommand("!name")).toEqual({ kind: "name_beast" });
    expect(parseChatCommand("!Name  ")).toEqual({ kind: "name_beast" });
  });

  it("does not let a viewer smuggle a name or extra text into these commands", () => {
    for (const text of ["!name Gorgo", "!name <script>", "!constitution now", "!tongue please", "!names", "!constitutions", "name"]) {
      expect(parseChatCommand(text).kind, text).toBe("none");
    }
  });
});
