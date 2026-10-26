import { describe, expect, it } from "vitest";
import { chatMessageDetails, translateTwitchEvent } from "../src/twitch/events.js";
import fixtures from "./fixtures/twitch-events.json";

describe("Twitch EventSub translation", () => {
  it.each(fixtures.cases)("translates $name into the engine event format", ({ name, payload, expected }) => {
    expect(translateTwitchEvent(name, payload, Date.parse("2025-01-01T00:00:00Z"))).toEqual(expected);
  });

  it("extracts chat commands from raw Twitch fixtures", () => {
    expect(chatMessageDetails(fixtures.chatCommand)).toEqual({
      userId: "viewer-7",
      userName: "viewer-7",
      message: "!law when someone subs grow wings",
      messageId: "chat-message-123"
    });
  });
});
