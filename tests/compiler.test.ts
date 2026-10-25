import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { TemplateCompiler } from "../src/compiler/template.js";

interface ContractCase {
  text: string;
  expect: Record<string, unknown>;
}

const contract = JSON.parse(readFileSync(new URL("./laws.json", import.meta.url), "utf8")) as { compile: ContractCase[] };
const compiler = new TemplateCompiler();

describe("TemplateCompiler contract", () => {
  it.each(contract.compile)("compiles: $text", async ({ text, expect: expected }) => {
    const rule = await compiler.compile(text);
    for (const [key, value] of Object.entries(expected)) {
      if (key === "event_type") expect(rule.trigger.event_type, key).toBe(value);
      else if (key === "threshold") expect(rule.trigger.threshold, key).toBe(value);
      else if (key === "action") expect(rule.action.type, key).toBe(value);
      else if (key === "part_id") expect(rule.mutation.part_id, key).toBe(value);
      else if (key === "color") expect(rule.mutation.color, key).toBe(value);
      else expect(rule[key as keyof typeof rule], key).toBe(value);
    }
  });
});
