import { readFileSync } from "node:fs";
import { Ajv } from "ajv";

const ruleSchema = JSON.parse(readFileSync(new URL("../schema/rule.schema.json", import.meta.url), "utf8"));

export const partZones = {
  horns: "head", eyes: "head", crown: "head",
  spikes: "torso", armor: "torso", scales: "torso",
  wings: "back", tail: "back", shell: "back",
  tentacles: "limbs", claws: "limbs", extra_arms: "limbs",
  flames: "aura", runes: "aura", lightning: "aura"
} as const;

export type PartId = keyof typeof partZones;
export type Zone = (typeof partZones)[PartId];

const ajv = new Ajv({ allErrors: true, strict: false });
const validate = ajv.compile(ruleSchema);

export function validateRule(obj: unknown): boolean {
  return validate(obj);
}

export function zoneForPart(partId: string): Zone {
  if (!(partId in partZones)) throw new Error(`Unsupported part_id: ${partId}`);
  return partZones[partId as PartId];
}
