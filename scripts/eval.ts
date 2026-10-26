import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { AutoCompiler } from "../src/compiler/auto.js";
import { TemplateCompiler } from "../src/compiler/template.js";
import type { Rule } from "../src/compiler/types.js";

interface HeldOutCase {
  text: string;
  expect: Record<string, unknown>;
}

const fileIndex = process.argv.indexOf("--file");
const casesFile = fileIndex >= 0 ? process.argv[fileIndex + 1] : "tests/heldout.json";
if (!casesFile) throw new Error("--file requires a JSON file path");
const cases = JSON.parse(readFileSync(resolve(casesFile), "utf8")) as HeldOutCase[];
const parser = new TemplateCompiler();
const auto = new AutoCompiler();
const verbose = process.argv.includes("--verbose");

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
const autoFailures: Array<{ text: string; expected: Record<string, unknown>; actual: Record<string, unknown>; path: string }> = [];
for (const testCase of cases) {
  const parsed = await parser.compile(testCase.text);
  if (matches(parsed, testCase.expect)) parserCorrect += 1;
  const result = await auto.compileWithPath(testCase.text);
  if (matches(result.rule, testCase.expect)) autoCorrect += 1;
  else autoFailures.push({ text: testCase.text, expected: testCase.expect, actual: flatten(result.rule), path: result.path });
  paths.set(result.path, (paths.get(result.path) ?? 0) + 1);
}

const percentage = (correct: number) => `${(correct / cases.length * 100).toFixed(1)}%`;
console.log(`Held-out cases: ${cases.length}`);
console.log(`Case file: ${casesFile}`);
console.log(`TemplateCompiler: ${parserCorrect}/${cases.length} (${percentage(parserCorrect)})`);
console.log(`AutoCompiler: ${autoCorrect}/${cases.length} (${percentage(autoCorrect)})`);
console.log(`AutoCompiler paths: ${[...paths].map(([path, count]) => `${path}=${count}`).join(", ")}`);
if (verbose) {
  console.log(`AutoCompiler failures: ${autoFailures.length}`);
  for (const [index, failure] of autoFailures.entries()) {
    console.log(`${index + 1}. Law: ${JSON.stringify(failure.text)}`);
    console.log(`   Expected: ${JSON.stringify(failure.expected)}`);
    console.log(`   Actual: ${JSON.stringify(failure.actual)}`);
    console.log(`   Path: ${failure.path}`);
  }
}
