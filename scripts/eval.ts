import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { AutoCompiler } from "../src/compiler/auto.js";
import { TemplateCompiler } from "../src/compiler/template.js";
import type { Rule } from "../src/compiler/types.js";

interface HeldOutCase {
  text: string;
  expect: Record<string, unknown>;
}

const cases = JSON.parse(readFileSync(resolve("tests/heldout.json"), "utf8")) as HeldOutCase[];
const parser = new TemplateCompiler();
const auto = new AutoCompiler();

function flatten(rule: Rule): Record<string, unknown> {
  return {
    status: rule.status,
    event_type: rule.trigger.event_type,
    threshold: rule.trigger.threshold,
    action: rule.action.type,
    intensity: rule.action.intensity,
    part_id: rule.mutation.part_id,
    color: rule.mutation.color
  };
}

function matches(rule: Rule, expected: Record<string, unknown>): boolean {
  const actual = flatten(rule);
  return Object.entries(expected).every(([key, value]) => actual[key] === value);
}

let parserCorrect = 0;
let autoCorrect = 0;
const paths = new Map<string, number>();
for (const testCase of cases) {
  const parsed = await parser.compile(testCase.text);
  if (matches(parsed, testCase.expect)) parserCorrect += 1;
  const result = await auto.compileWithPath(testCase.text);
  if (matches(result.rule, testCase.expect)) autoCorrect += 1;
  paths.set(result.path, (paths.get(result.path) ?? 0) + 1);
}

const percentage = (correct: number) => `${(correct / cases.length * 100).toFixed(1)}%`;
console.log(`Held-out cases: ${cases.length}`);
console.log(`TemplateCompiler: ${parserCorrect}/${cases.length} (${percentage(parserCorrect)})`);
console.log(`AutoCompiler: ${autoCorrect}/${cases.length} (${percentage(autoCorrect)})`);
console.log(`AutoCompiler paths: ${[...paths].map(([path, count]) => `${path}=${count}`).join(", ")}`);
