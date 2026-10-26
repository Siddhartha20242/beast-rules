import { describe, expect, it } from "vitest";
import { parseChatCommand } from "../src/chat-commands.js";
import { parseStreamerCommand } from "../src/twitch/streamer-controls.js";

describe("parseChatCommand: proposals", () => {
  it("reads !law text, ignoring case and surrounding spaces", () => {
    expect(parseChatCommand("!law when someone subs grow wings")).toEqual({ kind: "law_propose", text: "when someone subs grow wings" });
    expect(parseChatCommand("  !LAW   every follow gives the beast horns  ")).toEqual({ kind: "law_propose", text: "every follow gives the beast horns" });
  });

  it("treats a bare !law as missing text", () => {
    expect(parseChatCommand("!law")).toEqual({ kind: "law_missing" });
    expect(parseChatCommand("   !Law   ")).toEqual({ kind: "law_missing" });
  });

  it("treats !law <number> as a highlight request, but !law 3 something as a proposal", () => {
    expect(parseChatCommand("!law 3")).toEqual({ kind: "law_highlight", lawNumber: 3 });
    expect(parseChatCommand("!law   12 ")).toEqual({ kind: "law_highlight", lawNumber: 12 });
    expect(parseChatCommand("!law 3 grows wings")).toEqual({ kind: "law_propose", text: "3 grows wings" });
  });

  it("does not mistake look-alike commands for !law", () => {
    for (const text of ["!lawsuit", "!lawn mower", "law when someone subs", "! law subs grow wings", "!!law subs grow wings"]) {
      expect(parseChatCommand(text).kind, text).toBe("none");
    }
  });

  it("passes odd text through unchanged so the compiler can refuse it", () => {
    expect(parseChatCommand("!law <script>alert(1)</script>")).toEqual({ kind: "law_propose", text: "<script>alert(1)</script>" });
    expect(parseChatCommand("!law ban everyone")).toEqual({ kind: "law_propose", text: "ban everyone" });
    const long = "x".repeat(5000);
    expect(parseChatCommand(`!law ${long}`)).toEqual({ kind: "law_propose", text: long });
  });
});

describe("parseChatCommand: !laws", () => {
  it("recognises the laws panel command only when it stands alone", () => {
    expect(parseChatCommand("!laws")).toEqual({ kind: "laws" });
    expect(parseChatCommand("  !LAWS ")).toEqual({ kind: "laws" });
    expect(parseChatCommand("!laws please").kind).toBe("none");
    expect(parseChatCommand("!laws 3").kind).toBe("none");
  });
});

describe("parseChatCommand: !repeal", () => {
  it("accepts a plain number or law-N", () => {
    expect(parseChatCommand("!repeal 3")).toEqual({ kind: "repeal", lawNumber: 3 });
    expect(parseChatCommand("!repeal law-3")).toEqual({ kind: "repeal", lawNumber: 3 });
    expect(parseChatCommand("  !REPEAL    12  ")).toEqual({ kind: "repeal", lawNumber: 12 });
    expect(parseChatCommand("!repeal 0")).toEqual({ kind: "repeal", lawNumber: 0 });
    expect(parseChatCommand("!repeal 9999")).toEqual({ kind: "repeal", lawNumber: 9999 });
  });

  it("rejects missing, non-numeric, oversized and negative numbers", () => {
    for (const text of ["!repeal", "!repeal abc", "!repeal 99999", "!repeal -3", "!repeal 3 4", "!repeal law-", "!repeal 3.5", "!repeal law 3", "!repealall"]) {
      expect(parseChatCommand(text).kind, text).toBe("none");
    }
  });
});

describe("parseChatCommand: vote tokens", () => {
  it("recognises 1, 2, 3, yes and no", () => {
    expect(parseChatCommand("1")).toEqual({ kind: "vote_token", token: "1" });
    expect(parseChatCommand("2")).toEqual({ kind: "vote_token", token: "2" });
    expect(parseChatCommand("3")).toEqual({ kind: "vote_token", token: "3" });
    expect(parseChatCommand("yes")).toEqual({ kind: "vote_token", token: "yes" });
    expect(parseChatCommand(" YES ")).toEqual({ kind: "vote_token", token: "yes" });
    expect(parseChatCommand("No")).toEqual({ kind: "vote_token", token: "no" });
  });

  it("ignores everything else, including near misses that must not count as votes", () => {
    for (const text of ["0", "4", "12", "11", "yes please", "y", "n", "nope", "yess", "1 2", "1!", "!1", "-1", "", "   ", "hello"]) {
      expect(parseChatCommand(text).kind, JSON.stringify(text)).toBe("none");
    }
  });
});

describe("parseChatCommand and streamer commands do not overlap", () => {
  it("leaves !beast commands to the streamer-controls parser", () => {
    for (const text of ["!beast pause", "!beast resume", "!beast reset", "!beast reset confirm", "!beast veto"]) {
      expect(parseStreamerCommand(text), text).toBeDefined();
      expect(parseChatCommand(text).kind, text).toBe("none");
    }
  });

  it("never lets a regular chat command be taken for a streamer command", () => {
    for (const text of ["!law", "!laws", "!repeal 3", "yes", "1"]) expect(parseStreamerCommand(text), text).toBeUndefined();
  });
});

describe("parseChatCommand robustness", () => {
  it("never throws and always returns a known kind for arbitrary chat text", () => {
    let seed = 12345;
    const next = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
    const alphabet = ["!", "l", "a", "w", "s", " ", "\t", "\n", "1", "2", "3", "9", "-", "repeal", "law", "laws", "yes", "no", "é", "😀", "\u0000", "‮", "<", ">", "&", "\"", "'", "\\"];
    const kinds = new Set(["laws", "repeal", "law_missing", "law_highlight", "law_propose", "vote_token", "none"]);
    for (let i = 0; i < 5000; i += 1) {
      const length = Math.floor(next() * 14);
      let text = "";
      for (let j = 0; j < length; j += 1) text += alphabet[Math.floor(next() * alphabet.length)];
      const result = parseChatCommand(text);
      expect(kinds.has(result.kind), JSON.stringify(text)).toBe(true);
      if (result.kind === "repeal" || result.kind === "law_highlight") {
        expect(Number.isInteger(result.lawNumber)).toBe(true);
        expect(result.lawNumber).toBeGreaterThanOrEqual(0);
      }
      if (result.kind === "law_propose") expect(result.text.length).toBeGreaterThan(0);
    }
  });
});
