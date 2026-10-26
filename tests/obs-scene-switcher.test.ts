import { describe, expect, it, vi } from "vitest";
import { ObsSceneSwitcher, type ObsClient, type ObsRequest } from "../src/obs/scene-switcher.js";

class MockObs implements ObsClient {
  listeners = new Map<string, (...args: unknown[]) => void>();
  calls: Array<{ request: ObsRequest; args?: { sceneName?: string } }> = [];
  connected = true;
  on(event: string, listener: (...args: unknown[]) => void): void { this.listeners.set(event, listener); }
  async connect(url: string, password?: string): Promise<void> { void url; void password; if (!this.connected) throw new Error("offline"); }
  async disconnect(): Promise<void> { this.connected = false; }
  async call(request: ObsRequest, args?: { sceneName?: string }): Promise<Record<string, unknown>> {
    this.calls.push({ request, args });
    return request === "GetCurrentProgramScene" ? { currentProgramSceneName: "Gameplay" } : {};
  }
}

describe("OBS scene switcher", () => {
  it("maps scene actions internally and restores the previous scene after the configured delay", async () => {
    vi.useFakeTimers();
    try {
      const client = new MockObs();
      const switcher = new ObsSceneSwitcher({
        url: "ws://127.0.0.1:4455", password: "test", scenes: { obs_scene_1: "Starting", obs_scene_2: "Intermission", obs_scene_3: "Ending" },
        returnSeconds: 6, client
      });
      await switcher.start();
      await switcher.handleAction("obs_scene_2");
      expect(client.calls.map((call) => call.args?.sceneName)).toEqual([undefined, "Intermission"]);
      await vi.advanceTimersByTimeAsync(6000);
      expect(client.calls.at(-1)).toEqual({ request: "SetCurrentProgramScene", args: { sceneName: "Gameplay" } });
      expect(switcher.isConnected).toBe(true);
    } finally { vi.useRealTimers(); }
  });

  it("silently skips unmapped scenes and logs when disconnected", async () => {
    const client = new MockObs();
    client.connected = false;
    const log = vi.fn();
    const switcher = new ObsSceneSwitcher({ url: "ws://localhost:4455", password: "", scenes: { obs_scene_1: "", obs_scene_2: "", obs_scene_3: "" }, returnSeconds: 6, client, log });
    await switcher.start();
    await switcher.handleAction("obs_scene_1");
    expect(client.calls).toEqual([]);
    expect(log).toHaveBeenCalledWith("connect_skipped", "OBS WebSocket is unavailable");
    expect(log).toHaveBeenCalledWith("scene_unmapped", "obs_scene_1");
  });

  it("does not call OBS for a mapped action while disconnected", async () => {
    const client = new MockObs();
    client.connected = false;
    const log = vi.fn();
    const switcher = new ObsSceneSwitcher({ url: "ws://localhost:4455", password: "", scenes: { obs_scene_1: "Start", obs_scene_2: "Break", obs_scene_3: "End" }, returnSeconds: 6, client, log });
    await switcher.start();
    await switcher.handleAction("obs_scene_1");
    expect(client.calls).toEqual([]);
    expect(log).toHaveBeenCalledWith("scene_skipped_disconnected", "obs_scene_1");
  });
});
