import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export function examplesFromContract(contract: unknown, count = 8): string[] {
  if (!contract || typeof contract !== "object") return [];
  const compile = (contract as { compile?: unknown }).compile;
  if (!Array.isArray(compile)) return [];
  return compile
    .filter((test): test is { text: string; expect: { status: string } } => Boolean(test && typeof test === "object"
      && typeof (test as { text?: unknown }).text === "string"
      && (test as { expect?: { status?: unknown } }).expect?.status === "ok"))
    .slice(0, count)
    .map((test) => test.text);
}

export function loadContractExamples(path = resolve("tests/laws.json"), count = 8): string[] {
  return examplesFromContract(JSON.parse(readFileSync(path, "utf8")), count);
}
