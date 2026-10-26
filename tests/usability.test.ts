import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { ActiveLaw } from "../src/engine.js";
import { examplesFromContract } from "../src/law-hints.js";
import { createLawToast, lawToastsForSnapshot, pushLawToast } from "../src/law-toast.js";
import { refusalForStatus } from "../src/refusals.js";

const rule: ActiveLaw = {
  status: "ok",
  id: "law-7",
  raw_text: "when someone subs grow yellow wings and shake the screen OffensiveUnwantedText",
  trigger: { event_type: "channel.subscribe", threshold: 1 },
  action: { type: "screen_shake", intensity: "low" },
  mutation: { part_id: "wings", color: "yellow" },
  zone: "back",
  timestamp: 1,
  compiler_path: "parser"
};

describe("usability payloads", () => {
  it("creates canonical, capped, expiring toast payloads without raw law text", () => {
    const toast = createLawToast({ ...rule, proposer_name: "unused" }, "<viewer-name-that-is-longer-than-24-chars>", false, 1000);
    expect(toast).toMatchObject({
      law_id: "law-7",
      description: "When someone subscribes: grow yellow wings + screen shake",
      triggered_by: "<viewer-name-that-is-longer-than-24-chars".slice(0, 24),
      simulated: false,
      ends_at: 4000
    });
    expect(JSON.stringify(toast)).not.toContain("OffensiveUnwantedText");
    expect(toast).not.toHaveProperty("raw_text");
    expect(createLawToast(rule, "viewer", true, 1000)).toMatchObject({ simulated: true, ends_at: 4000 });
    expect(createLawToast(rule, "viewer", true, 1000)).not.toHaveProperty("triggered_by");
  });

  it("keeps at most two non-expired law toasts in snapshot order", () => {
    const first = createLawToast(rule, "a", false, 100);
    const second = createLawToast(rule, "b", false, 200);
    const third = createLawToast(rule, "c", false, 300);
    expect(pushLawToast([first, second], third, 300)).toEqual([second, third]);
    expect(lawToastsForSnapshot([first, second, third], 301)).toEqual([second, third]);
    expect(lawToastsForSnapshot([first], 3100)).toEqual([]);
  });

  it("loads rotating hints from the first eight passing contract cases", () => {
    const contract = JSON.parse(readFileSync(new URL("./laws.json", import.meta.url), "utf8")) as unknown;
    const expected = (contract as { compile: Array<{ text: string; expect: { status: string } }> }).compile
      .filter((test) => test.expect.status === "ok").slice(0, 8).map((test) => test.text);
    expect(examplesFromContract(contract)).toEqual(expected);
    expect(expected).toHaveLength(8);
  });

  it("uses fixed status-only refusal copy", () => {
    expect(refusalForStatus("unsupported_trigger")).toBe("I only know: follow, sub, gift sub, cheer, raid, hype train, chat activity.");
    expect(refusalForStatus("unsupported_effect")).toBe("Effects: shake, flash, confetti, roar, scene 1-3, dare 1-3.");
    expect(refusalForStatus("unsupported_part")).toBe("Parts: horns, eyes, crown, spikes, armor, scales, wings, tail, shell, tentacles, claws, extra arms, flames, runes, lightning.");
    expect(refusalForStatus("too_vague")).toBe("Say what triggers it and what the beast gets, e.g. when someone subs grow wings.");
    expect(refusalForStatus("unsafe")).toBe("That one is not allowed.");
  });
});
