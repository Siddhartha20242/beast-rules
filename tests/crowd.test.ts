import { describe, expect, it } from "vitest";
import { crowdCrisisVoteChoice, crowdVoteChoice } from "../src/crowd.js";

describe("simulated crowd bias", () => {
  it("uses the configured yes probability and clamps percentages", () => {
    expect(crowdVoteChoice(80, 0.79)).toBe("yes");
    expect(crowdVoteChoice(80, 0.8)).toBe("no");
    expect(crowdVoteChoice(0, 0)).toBe("no");
    expect(crowdVoteChoice(100, 0.999)).toBe("yes");
    expect(crowdVoteChoice(500, 0.999)).toBe("yes");
    expect(crowdVoteChoice(-10, 0)).toBe("no");
  });

  it("maps yes bias to the new law and no bias to the existing law during a crisis", () => {
    expect(crowdCrisisVoteChoice(80, 0.2)).toBe("proposed");
    expect(crowdCrisisVoteChoice(80, 0.9)).toBe("existing");
  });
});
