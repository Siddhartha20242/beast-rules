import { describe, expect, it } from "vitest";
import { validateRule, zoneForPart } from "../src/schema.js";

const validRule = {
  status: "ok",
  trigger: { event_type: "channel.follow", threshold: 1 },
  action: { type: "confetti", intensity: "low" },
  mutation: { part_id: "horns", color: "red" }
};

describe("validateRule", () => {
  it("accepts a valid rule", () => {
    expect(validateRule(validRule)).toBe(true);
  });

  it("rejects an extra key", () => {
    expect(validateRule({ ...validRule, unexpected: true })).toBe(false);
  });

  it("rejects an invalid enum value", () => {
    expect(validateRule({ ...validRule, status: "maybe" })).toBe(false);
  });
});

describe("zoneForPart", () => {
  it.each([
    ["horns", "head"], ["eyes", "head"], ["crown", "head"],
    ["spikes", "torso"], ["armor", "torso"], ["scales", "torso"],
    ["wings", "back"], ["tail", "back"], ["shell", "back"],
    ["tentacles", "limbs"], ["claws", "limbs"], ["extra_arms", "limbs"],
    ["flames", "aura"], ["runes", "aura"], ["lightning", "aura"]
  ] as const)("maps %s to %s", (partId, zone) => {
    expect(zoneForPart(partId)).toBe(zone);
  });
});
