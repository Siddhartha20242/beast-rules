import { describe, expect, it } from "vitest";
import { TemplateCompiler } from "../src/compiler/template.js";
import type { Rule } from "../src/compiler/types.js";
import { verifyModelRule } from "../src/compiler/verify.js";

const parser = new TemplateCompiler();
const base: Rule = {
  status: "ok",
  trigger: { event_type: "channel.follow", threshold: 1 },
  action: { type: "confetti", intensity: "low" },
  mutation: { part_id: "horns", color: "blue" }
};

describe("template number and color interpretation", () => {
  it.each([
    ["one sub", 1], ["two subs", 2], ["three cheers", 3], ["four follows", 4], ["five bits", 5],
    ["six raids", 6], ["seven subscriptions", 7], ["eight cheers", 8], ["nine follows", 9], ["ten subs", 10],
    ["a dozen raids", 12], ["twenty cheers", 20], ["thirty follows", 30], ["fifty subs", 50]
  ])("parses threshold phrase %s", async (phrase, threshold) => {
    const result = await parser.compile(`${phrase} grow horns`);
    expect(result.trigger.threshold).toBe(threshold);
  });

  it.each([
    ["azure", "blue"], ["navy", "blue"], ["sky", "blue"], ["crimson", "red"], ["scarlet", "red"],
    ["gold", "yellow"], ["golden", "yellow"], ["amber", "yellow"], ["teal", "cyan"], ["aqua", "cyan"],
    ["magenta", "pink"], ["violet", "purple"], ["lilac", "purple"], ["lime", "green"], ["emerald", "green"],
    ["purpel", "purple"]
  ])("maps color term %s", async (term, color) => {
    const result = await parser.compile(`follows grow ${term} horns`);
    expect(result.mutation.color).toBe(color);
  });

  it("keeps raider's arrival as an unsupported trigger", async () => {
    expect((await parser.compile("Each raider's arrival grants blue extra arms")).status).toBe("unsupported_trigger");
  });

  it.each([
    ["one", 1], ["two", 2], ["three", 3], ["four", 4], ["five", 5], ["six", 6], ["seven", 7],
    ["eight", 8], ["nine", 9], ["ten", 10], ["eleven", 11], ["twelve", 12], ["thirteen", 13],
    ["fourteen", 14], ["fifteen", 15], ["sixteen", 16], ["seventeen", 17], ["eighteen", 18],
    ["nineteen", 19], ["twenty", 20], ["thirty", 30], ["forty", 40], ["fifty", 50], ["a hundred", 100]
  ])("reads %s chat messages per minute as threshold %i", async (number, threshold) => {
    const result = await parser.compile(`${number} chat messages per minute grow blue horns`);
    expect(result.trigger).toEqual({ event_type: "channel.chat.message", threshold });
  });

  it.each([["three", 3], ["fifty", 50], ["a hundred", 100]])("reads %s messages a minute", async (number, threshold) => {
    const result = await parser.compile(`${number} messages a minute grow blue horns`);
    expect(result.trigger.threshold).toBe(threshold);
  });

  it("parses word-number scene and dare actions", async () => {
    expect((await parser.compile("follows switch to scene three and grow blue horns")).action.type).toBe("obs_scene_3");
    expect((await parser.compile("follows trigger dare two and grow blue horns")).action.type).toBe("dare_2");
  });
});

describe("screen shake synonyms", () => {
  it.each(["wobble", "wobbles", "wobbled", "wobbling", "shudder", "shudders", "shuddered", "shuddering"])("maps %s to screen_shake", async (word) => {
    const result = await parser.compile(`follows make the screen ${word} and grow blue horns`);
    expect(result.action.type).toBe("screen_shake");
  });
});

describe("model effect verification", () => {
  it.each([
    ["shake the screen", "screen_shake"], ["flash the screen", "screen_flash"], ["throw confetti", "confetti"],
    ["make it roar", "beast_roar"], ["switch to scene 2", "obs_scene_2"], ["trigger dare 3", "dare_3"]
  ])("accepts matching named effect: %s", (text, action) => {
    const rule = { ...base, action: { type: action as Rule["action"]["type"], intensity: "low" as const } };
    expect(verifyModelRule(`follow ${text} and grow blue horns`, rule)).toBe(true);
  });

  it.each(["dance", "jump", "explode", "sing", "fly", "spin"]) ("rejects unsupported effect verb %s", (verb) => {
    expect(verifyModelRule(`follow make it ${verb} and grow blue horns`, base)).toBe(false);
  });

  it("rejects a supported effect mismatch and requires confetti when no effect is named", () => {
    expect(verifyModelRule("follow shake the screen and grow blue horns", { ...base, action: { type: "beast_roar", intensity: "low" } })).toBe(false);
    expect(verifyModelRule("follow grow blue horns", { ...base, action: { type: "screen_shake", intensity: "low" } })).toBe(false);
    expect(verifyModelRule("follow grow blue horns", base)).toBe(true);
  });
});
