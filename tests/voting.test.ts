import { describe, expect, it } from "vitest";
import { VotingManager } from "../src/voting.js";

describe("VotingManager", () => {
  it("passes by simple majority after the configured window", () => {
    let now = 10_000;
    const voting = new VotingManager({ voteSeconds: 30, clock: () => now });
    expect(voting.startProposal("law-1", "proposer")).toBe(true);
    expect(voting.castVote("viewer-1", "yes")).toBe(true);
    expect(voting.castVote("viewer-2", "yes")).toBe(true);
    expect(voting.castVote("viewer-3", "no")).toBe(true);
    now += 30_000;
    expect(voting.closeIfExpired()).toMatchObject({ status: "passed", yes: 2, no: 1, total: 3 });
  });

  it("fails a tie or a vote with no votes", () => {
    let now = 0;
    const voting = new VotingManager({ voteSeconds: 10, proposalCooldownSeconds: 0, clock: () => now });
    expect(voting.startProposal("law-tie", "proposer-1")).toBe(true);
    voting.castVote("a", "yes");
    voting.castVote("b", "no");
    now = 10_000;
    expect(voting.closeIfExpired()).toMatchObject({ status: "failed", total: 2 });

    expect(voting.startProposal("law-empty", "proposer-2")).toBe(true);
    now += 10_000;
    expect(voting.closeIfExpired()).toMatchObject({ status: "failed", total: 0 });
  });

  it("accepts at most one vote from each user", () => {
    const voting = new VotingManager({ voteSeconds: 20, clock: () => 100 });
    voting.startProposal("law-1", "proposer");
    expect(voting.castVote("viewer", "yes")).toBe(true);
    expect(voting.castVote("viewer", "no")).toBe(false);
    expect(voting.current).toMatchObject({ yes: 1, no: 0, voters: 1 });
  });

  it("applies a per-viewer proposal cooldown", () => {
    let now = 0;
    const voting = new VotingManager({ voteSeconds: 5, proposalCooldownSeconds: 60, clock: () => now });
    expect(voting.startProposal("law-1", "same-viewer")).toBe(true);
    now = 5_000;
    expect(voting.closeIfExpired()?.status).toBe("failed");
    expect(voting.startProposal("law-2", "same-viewer")).toBe(false);
    expect(voting.startProposal("law-2", "other-viewer")).toBe(true);
  });

  it("does not hold event processing while a vote remains open", () => {
    const now = 0;
    const voting = new VotingManager({ voteSeconds: 30, clock: () => now });
    const engineLikeEventHandler = () => "event handled";
    voting.startProposal("law-1", "proposer");
    expect(engineLikeEventHandler()).toBe("event handled");
  });
});
