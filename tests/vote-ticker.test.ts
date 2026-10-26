import { describe, expect, it } from "vitest";
import { createVoteTickerEntry, voteTickerForSnapshot } from "../src/vote-ticker.js";

describe("vote ticker payload", () => {
  it("keeps only five recent entries and emits username plus vote choice", () => {
    const entries = Array.from({ length: 7 }, (_, index) => createVoteTickerEntry(`viewer_${index + 1}`, index % 2 ? "no" : "yes", 1000 + index));
    expect(voteTickerForSnapshot(entries, 1007)).toEqual(entries.slice(-5));
  });

  it("labels crisis and simulated votes without adding user identifiers", () => {
    const entry = createVoteTickerEntry("sim_viewer_1", "2", 500, { crisis: true, simulated: true });
    expect(entry).toEqual({ username: "sim_viewer_1", choice: "2", at: 500, crisis: true, simulated: true });
  });

  it("strips control characters and expires after four seconds", () => {
    const old = createVoteTickerEntry("alice\n<script>", "yes", 100);
    expect(old.username).toBe("alice<script>");
    expect(voteTickerForSnapshot([old], 4100)).toEqual([]);
  });
});
