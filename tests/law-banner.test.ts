import { describe, expect, it } from "vitest";
import { createLawBannerPayload, lawBannerForSnapshot } from "../src/law-banner.js";

const law = {
  id: "law-12",
  raw_text: "when someone subs grow wings and shake the screen",
  mutation: { part_id: "wings" as const, color: "yellow" as const },
  zone: "back" as const,
  proposer_name: "viewer_one"
};

describe("law passed snapshot banner", () => {
  it("includes the winning law, part display data, replacement context, and four-second expiry", () => {
    const payload = createLawBannerPayload("crisis_resolved", law, {
      now: 1000,
      headline: "NEW LAW SURVIVES",
      relatedLawText: "follows grow tail",
      relatedLawRelation: "overruled"
    });

    expect(payload).toMatchObject({
      banner_id: "crisis_resolved:law-12:1000",
      event: "crisis_resolved",
      headline: "NEW LAW SURVIVES",
      law_id: "law-12",
      law_text: "when someone subs grow wings and shake the screen",
      part_id: "wings",
      color: "yellow",
      zone: "back",
      proposer_name: "viewer_one",
      related_law_text: "follows grow tail",
      related_law_relation: "overruled",
      ends_at: 5000
    });
    expect(lawBannerForSnapshot(payload, 4999)).toEqual(payload);
    expect(lawBannerForSnapshot(payload, 5000)).toBeNull();
  });

  it("marks a passed replacement as a challenge until the crisis vote resolves", () => {
    const payload = createLawBannerPayload("passed", law, {
      now: 0,
      relatedLawText: "old law text",
      relatedLawRelation: "challenged"
    });
    expect(payload).toMatchObject({ event: "passed", related_law_relation: "challenged", ends_at: 4000 });
  });

  it("omits the proposer attribution for a legacy law without a recorded proposer", () => {
    const payload = createLawBannerPayload("passed", { ...law, proposer_name: undefined }, { now: 1000 });
    expect(payload).not.toHaveProperty("proposer_name");
  });
});
