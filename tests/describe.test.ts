import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { describeRule, lawForDisplay } from "../src/describe.js";
import type { Rule } from "../src/compiler/types.js";

const schema = JSON.parse(readFileSync(new URL("../schema/rule.schema.json", import.meta.url), "utf8")) as Record<string, unknown>;
function enumAt(...path: string[]): string[] {
  let value: unknown = schema;
  for (const part of path) {
    if (!value || typeof value !== "object") throw new Error(`Invalid schema path: ${path.join(".")}`);
    value = (value as Record<string, unknown>)[part];
  }
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) throw new Error(`Missing enum at ${path.join(".")}`);
  return value;
}

const rule: Rule = {
  status: "ok",
  trigger: { event_type: "channel.subscribe", threshold: 1 },
  action: { type: "screen_shake", intensity: "low" },
  mutation: { part_id: "wings", color: "yellow" }
};

describe("canonical rule descriptions", () => {
  it("has fixed phrases for every trigger, action, part, and color enum", () => {
    for (const event_type of enumAt("properties", "trigger", "properties", "event_type", "enum")) {
      expect(() => describeRule({ ...rule, trigger: { ...rule.trigger, event_type } as Rule["trigger"] })).not.toThrow();
    }
    for (const type of enumAt("properties", "action", "properties", "type", "enum")) {
      expect(() => describeRule({ ...rule, action: { ...rule.action, type } as Rule["action"] })).not.toThrow();
    }
    for (const part_id of enumAt("properties", "mutation", "properties", "part_id", "enum")) {
      expect(() => describeRule({ ...rule, mutation: { ...rule.mutation, part_id } as Rule["mutation"] })).not.toThrow();
    }
    for (const color of enumAt("properties", "mutation", "properties", "color", "enum")) {
      expect(() => describeRule({ ...rule, mutation: { ...rule.mutation, color } as Rule["mutation"] })).not.toThrow();
    }
    for (const intensity of enumAt("properties", "action", "properties", "intensity", "enum")) {
      expect(() => describeRule({ ...rule, action: { ...rule.action, intensity } as Rule["action"] })).not.toThrow();
    }
  });

  it("projects an arbitrary proposal sentence as an enum-only snapshot description", () => {
    const contaminated = "when someone subs grow wings and shake the screen slur_exploit_731 arbitrary offensive words";
    const snapshot = {
      active_laws: [lawForDisplay({ ...rule, id: "law-1", raw_text: contaminated, zone: "back", timestamp: 1, compiler_path: "parser", proposer_name: "<img onerror=alert(1)>verylongusername123" })]
    };
    const serialized = JSON.stringify(snapshot);
    expect(snapshot.active_laws[0]).not.toHaveProperty("raw_text");
    expect(snapshot.active_laws[0]?.description).toBe("When someone subscribes: grow yellow wings + screen shake");
    expect(serialized).not.toContain("slur_exploit_731");
    expect(serialized).not.toContain("arbitrary offensive words");
    expect(snapshot.active_laws[0]?.proposer_name?.length).toBeLessThanOrEqual(24);
  });
});
