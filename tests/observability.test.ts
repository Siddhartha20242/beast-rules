import { describe, expect, it } from "vitest";
import { createHealthHandler } from "../src/health.js";
import { formatEventSubLogLine } from "../src/twitch/logging.js";

describe("EventSub log formatter", () => {
  it("prints a one-line colored record with a shortened id and bounded chat text", () => {
    const line = formatEventSubLogLine("chat", {
      metadata: { message_id: "message-id-123456789" },
      event: { chatter_user_name: "viewerBee", message: { text: "A chat message that is deliberately long enough to be cut off after eighty characters exactly!" } }
    }, new Date("2026-01-02T03:04:05.000Z"));
    expect(line).toContain("2026-01-02T03:04:05.000Z");
    expect(line).toContain("channel.chat.message");
    expect(line).toContain("id=message-id-1…");
    expect(line).toContain('user="viewerBee"');
    expect(line).not.toContain("\n");
    const text = line.match(/ text="([^"]*)"/)?.[1];
    expect(text?.length).toBeLessThanOrEqual(80);
  });

  it("redacts token and Authorization-like strings rather than logging them", () => {
    const line = formatEventSubLogLine("chat", {
      event: {
        chatter_user_name: "viewerBee",
        message: { text: "Authorization: Bearer top-secret-value oauth:another-secret access_token=third-secret client_secret=fourth-secret" }
      }
    });
    for (const secret of ["top-secret-value", "another-secret", "third-secret", "fourth-secret", "Authorization:"]) {
      expect(line).not.toContain(secret);
    }
  });
});

describe("health handler", () => {
  it("returns mocked Twitch, subscription, compiler, Ollama, and law state without credentials", async () => {
    const state = {
      twitchConnected: true,
      broadcasterId: "123456",
      subscriptions: [{ type: "channel.chat.message", status: "active" }, { type: "channel.follow", status: "pending" }],
      compilerMode: "auto" as const,
      activeLaws: 4,
      obsConnected: true
    };
    let result: unknown;
    let fetchedUrl = "";
    const handler = createHealthHandler(() => state, "http://localhost:11434", async (input) => {
      fetchedUrl = String(input);
      return new Response("{}", { status: 200 });
    });
    const response = { json(value: unknown) { result = value; return this; } };
    await handler({} as never, response as never, (() => undefined) as never);

    expect(fetchedUrl).toBe("http://localhost:11434/api/tags");
    expect(result).toEqual({ ...state, twitchReconnecting: false, lastDisconnectAt: null, reconnectAttempts: 0, ollamaReachable: true });
    expect(JSON.stringify(result)).not.toMatch(/token|secret|authorization/i);
  });

  it("reports Ollama unreachable without failing the health response", async () => {
    let result: unknown;
    const handler = createHealthHandler(() => ({
      twitchConnected: false, broadcasterId: null, subscriptions: [], compilerMode: "template", activeLaws: 0, obsConnected: false
    }), "http://localhost:11434", async () => { throw new Error("offline"); });
    const response = { json(value: unknown) { result = value; return this; } };
    await handler({} as never, response as never, (() => undefined) as never);
    expect(result).toMatchObject({ twitchConnected: false, ollamaReachable: false });
  });
});
