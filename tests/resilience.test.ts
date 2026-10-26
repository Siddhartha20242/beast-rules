import { describe, expect, it, vi } from "vitest";
import { buildHealthResponse } from "../src/health.js";
import {
  ReconnectSupervisor,
  handleProcessError,
  installProcessGuards,
  isRecoverableNetworkError,
  type ConnectionStatus
} from "../src/twitch/resilience.js";

// The error that actually crashed the server: ws emitted an 'error' on a socket that was still
// connecting when Twurple's keepalive timer fired.
function crashError(): Error {
  const error = new Error("WebSocket was closed before the connection was established");
  error.stack = [
    "Error: WebSocket was closed before the connection was established",
    "    at WebSocket.close (/app/node_modules/ws/lib/websocket.js:285:7)",
    "    at EventSubWsSocket._handleKeepaliveTimeout (/app/node_modules/@twurple/eventsub-ws/lib/EventSubWsSocket.js:168:26)"
  ].join("\n");
  return error;
}

function appError(): Error {
  const error = new TypeError("Cannot read properties of undefined (reading 'zone')");
  error.stack = ["TypeError: Cannot read properties of undefined (reading 'zone')", "    at RuleEngine.add (/app/src/engine.ts:120:15)"].join("\n");
  return error;
}

describe("isRecoverableNetworkError", () => {
  it("recognises the real keepalive crash", () => {
    expect(isRecoverableNetworkError(crashError())).toBe(true);
  });

  it("recognises plain network failures by code", () => {
    const error = Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
    expect(isRecoverableNetworkError(error)).toBe(true);
    expect(isRecoverableNetworkError(Object.assign(new Error("lookup failed"), { code: "ENOTFOUND" }))).toBe(true);
  });

  it("recognises errors whose first stack frame is in the Twitch, OBS or ws packages", () => {
    const obs = new Error("Socket closed");
    obs.stack = "Error: Socket closed\n    at OBSWebSocket.onClose (/app/node_modules/obs-websocket-js/dist/json.js:10:5)";
    expect(isRecoverableNetworkError(obs)).toBe(true);
  });

  it("never treats this project's own bugs as recoverable", () => {
    expect(isRecoverableNetworkError(appError())).toBe(false);
    const callback = new Error("handler blew up");
    callback.stack = "Error: handler blew up\n    at handleTwitchEvent (/app/src/server.ts:300:9)\n    at EventSubWsListener.emit (/app/node_modules/@twurple/eventsub-ws/lib/x.js:1:1)";
    expect(isRecoverableNetworkError(callback)).toBe(false);
    expect(isRecoverableNetworkError("some string")).toBe(false);
  });
});

describe("process guards", () => {
  it("keeps the process alive for the keepalive crash and logs it", () => {
    const exit = vi.fn();
    const log = vi.fn();
    expect(handleProcessError(crashError(), "uncaughtException", { log, exit })).toBe("recovered");
    expect(exit).not.toHaveBeenCalled();
    expect(log.mock.calls[0]?.[0]).toContain("keeps running");
  });

  it("exits non-zero for errors from application code", () => {
    const exit = vi.fn();
    const log = vi.fn();
    expect(handleProcessError(appError(), "unhandledRejection", { log, exit })).toBe("fatal");
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("registers both handlers and routes errors through them", () => {
    const handlers = new Map<string, (value: unknown) => void>();
    const target = { on: (event: string, handler: (value: unknown) => void) => { handlers.set(event, handler); return target; } };
    const exit = vi.fn();
    installProcessGuards({ log: () => undefined, exit }, target as unknown as Pick<NodeJS.Process, "on">);
    expect([...handlers.keys()].sort()).toEqual(["uncaughtException", "unhandledRejection"]);
    handlers.get("uncaughtException")?.(crashError());
    handlers.get("unhandledRejection")?.(crashError());
    expect(exit).not.toHaveBeenCalled();
    handlers.get("uncaughtException")?.(appError());
    expect(exit).toHaveBeenCalledTimes(1);
  });
});

function fakeScheduler() {
  const timers: Array<{ callback: () => void; delayMs: number; cancelled: boolean }> = [];
  return {
    timers,
    schedule: (callback: () => void, delayMs: number) => {
      const timer = { callback, delayMs, cancelled: false };
      timers.push(timer);
      return timer;
    },
    cancel: (handle: unknown) => { (handle as { cancelled: boolean }).cancelled = true; },
    async fireNext() {
      const timer = timers.filter((item) => !item.cancelled).at(-1);
      if (!timer) return false;
      timer.cancelled = true;
      timer.callback();
      await Promise.resolve();
      await Promise.resolve();
      return true;
    }
  };
}

describe("ReconnectSupervisor", () => {
  const fixedNow = () => new Date("2026-10-27T12:00:00.000Z");

  it("restarts the listener while disconnected, with growing waits capped at 30s", async () => {
    const scheduler = fakeScheduler();
    const restart = vi.fn();
    const supervisor = new ReconnectSupervisor({ isConnected: () => false, restart, now: fixedNow, schedule: scheduler.schedule, cancel: scheduler.cancel });
    supervisor.notifyDisconnected();
    expect(supervisor.status()).toMatchObject({ connected: false, reconnecting: true, lastDisconnectAt: "2026-10-27T12:00:00.000Z", reconnectAttempts: 0 });
    const delays: number[] = [scheduler.timers[0]!.delayMs];
    for (let i = 0; i < 5; i += 1) {
      await scheduler.fireNext();
      delays.push(scheduler.timers.at(-1)!.delayMs);
    }
    expect(restart).toHaveBeenCalledTimes(5);
    expect(delays).toEqual([5_000, 10_000, 20_000, 30_000, 30_000, 30_000]);
    expect(supervisor.status().reconnectAttempts).toBe(5);
  });

  it("stops restarting and resets the attempt count once Twitch reconnects", async () => {
    const scheduler = fakeScheduler();
    const restart = vi.fn();
    const supervisor = new ReconnectSupervisor({ isConnected: () => false, restart, now: fixedNow, schedule: scheduler.schedule, cancel: scheduler.cancel });
    supervisor.notifyDisconnected();
    await scheduler.fireNext();
    supervisor.notifyConnected();
    expect(supervisor.status()).toMatchObject({ connected: true, reconnecting: false, reconnectAttempts: 0, lastDisconnectAt: "2026-10-27T12:00:00.000Z" });
    expect(await scheduler.fireNext()).toBe(false);
    expect(restart).toHaveBeenCalledTimes(1);
  });

  it("keeps trying when a restart itself throws", async () => {
    const scheduler = fakeScheduler();
    const log = vi.fn();
    const restart = vi.fn(() => { throw new Error("network is down"); });
    const supervisor = new ReconnectSupervisor({ isConnected: () => false, restart, log, schedule: scheduler.schedule, cancel: scheduler.cancel });
    supervisor.notifyDisconnected();
    await scheduler.fireNext();
    expect(log.mock.calls.some(([message]) => String(message).includes("network is down"))).toBe(true);
    expect(await scheduler.fireNext()).toBe(true);
    expect(restart).toHaveBeenCalledTimes(2);
  });

  it("does not restart if the listener recovered by itself before the timer fires", async () => {
    const scheduler = fakeScheduler();
    const restart = vi.fn();
    let connected = false;
    const supervisor = new ReconnectSupervisor({ isConnected: () => connected, restart, schedule: scheduler.schedule, cancel: scheduler.cancel });
    supervisor.notifyDisconnected();
    connected = true;
    await scheduler.fireNext();
    expect(restart).not.toHaveBeenCalled();
  });

  it("supervises the first connection without recording a disconnect", () => {
    const scheduler = fakeScheduler();
    const changes: ConnectionStatus[] = [];
    const supervisor = new ReconnectSupervisor({ isConnected: () => false, restart: vi.fn(), onChange: (status) => changes.push(status), schedule: scheduler.schedule, cancel: scheduler.cancel });
    supervisor.watch();
    expect(supervisor.status().lastDisconnectAt).toBeNull();
    expect(changes.at(-1)).toMatchObject({ connected: false, reconnecting: true });
  });

  it("stops for good when the runtime stops", async () => {
    const scheduler = fakeScheduler();
    const restart = vi.fn();
    const supervisor = new ReconnectSupervisor({ isConnected: () => false, restart, schedule: scheduler.schedule, cancel: scheduler.cancel });
    supervisor.notifyDisconnected();
    supervisor.stop();
    expect(await scheduler.fireNext()).toBe(false);
    supervisor.notifyDisconnected();
    expect(restart).not.toHaveBeenCalled();
  });
});

describe("/health during a Twitch outage", () => {
  it("reports reconnect state and defaults the new fields", async () => {
    const reachable = vi.fn(async () => ({ ok: true }) as Response);
    const outage = await buildHealthResponse(
      { twitchConnected: false, twitchReconnecting: true, lastDisconnectAt: "2026-10-27T12:00:00.000Z", reconnectAttempts: 2, broadcasterId: "1", subscriptions: [], compilerMode: "auto", activeLaws: 3, obsConnected: false },
      "http://localhost:11434",
      reachable as unknown as typeof fetch
    );
    expect(outage).toMatchObject({ twitchConnected: false, twitchReconnecting: true, lastDisconnectAt: "2026-10-27T12:00:00.000Z", reconnectAttempts: 2, activeLaws: 3 });
    const plain = await buildHealthResponse(
      { twitchConnected: true, broadcasterId: "1", subscriptions: [], compilerMode: "auto", activeLaws: 0, obsConnected: false },
      "http://localhost:11434",
      reachable as unknown as typeof fetch
    );
    expect(plain).toMatchObject({ twitchReconnecting: false, lastDisconnectAt: null, reconnectAttempts: 0 });
  });
});
