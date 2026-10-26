import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hasModeratorBadge, parseStreamerCommand, streamerRole, StreamerControlState } from "../src/twitch/streamer-controls.js";

const dirs: string[] = [];
function stateFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "beast-controls-"));
  dirs.push(dir);
  return join(dir, "controls.json");
}
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("streamer controls", () => {
  it("parses supported commands and denies a normal mocked chat viewer", () => {
    const event = { event: { chatter_user_id: "viewer-1", badges: [], message: { text: "!beast pause" } } };
    const userId = event.event.chatter_user_id;
    const command = parseStreamerCommand(event.event.message.text);
    expect(command).toBe("pause");
    expect(streamerRole(userId, "broadcaster-1", hasModeratorBadge(event))).toBe("viewer");
  });

  it("authorizes the broadcaster and a chat event with moderator badge", () => {
    expect(streamerRole("broadcaster-1", "broadcaster-1", false)).toBe("broadcaster");
    expect(streamerRole("mod-1", "broadcaster-1", hasModeratorBadge({ event: { badges: [{ set_id: "moderator" }] } }))).toBe("moderator");
  });

  it("persists pause state across restart", () => {
    const file = stateFile();
    const first = new StreamerControlState(file);
    expect(first.setPaused(true)).toBe(true);
    expect(new StreamerControlState(file).paused).toBe(true);
  });

  it("requires same-user reset confirmation within 15 seconds", () => {
    const file = stateFile();
    let now = 1000;
    const controls = new StreamerControlState(file, () => now);
    controls.requestReset("broadcaster");
    expect(controls.confirmReset("viewer")).toBe(false);
    expect(controls.confirmReset("broadcaster")).toBe(true);
    controls.requestReset("broadcaster");
    now += 15_001;
    expect(controls.confirmReset("broadcaster")).toBe(false);
    controls.requestReset("broadcaster");
    expect(controls.confirmReset("broadcaster")).toBe(true);
  });
});
