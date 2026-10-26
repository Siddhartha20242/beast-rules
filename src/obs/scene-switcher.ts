export type ObsSceneAction = "obs_scene_1" | "obs_scene_2" | "obs_scene_3";
export type ObsRequest = "GetCurrentProgramScene" | "SetCurrentProgramScene";

export interface ObsClient {
  on(event: string, listener: (...args: unknown[]) => void): void;
  connect(url: string, password?: string): Promise<unknown>;
  disconnect(): Promise<void>;
  call(request: ObsRequest, args?: { sceneName?: string }): Promise<Record<string, unknown>>;
}

export interface SceneSwitcherOptions {
  url: string;
  password: string;
  scenes: Record<ObsSceneAction, string>;
  returnSeconds: number;
  client: ObsClient;
  log?: (event: string, detail: string) => void;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
}

export class ObsSceneSwitcher {
  private readonly client: ObsClient;
  private readonly options: SceneSwitcherOptions;
  private readonly log: (event: string, detail: string) => void;
  private readonly setTimer: typeof setTimeout;
  private readonly clearTimer: typeof clearTimeout;
  private connected = false;
  private previousScene: string | undefined;
  private returnTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(options: SceneSwitcherOptions) {
    this.options = options;
    this.client = options.client;
    this.log = options.log ?? (() => undefined);
    this.setTimer = options.setTimer ?? setTimeout;
    this.clearTimer = options.clearTimer ?? clearTimeout;
    this.client.on("ConnectionOpened", () => { this.connected = true; });
    this.client.on("ConnectionClosed", () => { this.connected = false; });
    this.client.on("ConnectionError", () => { this.connected = false; });
  }

  get isConnected(): boolean { return this.connected; }

  async start(): Promise<void> {
    try {
      await this.client.connect(this.options.url, this.options.password || undefined);
      this.connected = true;
      this.log("connected", "OBS WebSocket connected");
    } catch {
      this.connected = false;
      this.log("connect_skipped", "OBS WebSocket is unavailable");
    }
  }

  async handleAction(action: string): Promise<void> {
    if (!isSceneAction(action)) return;
    const sceneName = this.options.scenes[action].trim();
    if (!sceneName) {
      this.log("scene_unmapped", action);
      return;
    }
    if (!this.connected) {
      this.log("scene_skipped_disconnected", action);
      return;
    }
    try {
      if (!this.previousScene) {
        const current = await this.client.call("GetCurrentProgramScene");
        const name = current.currentProgramSceneName;
        if (typeof name === "string") this.previousScene = name;
      }
      await this.client.call("SetCurrentProgramScene", { sceneName });
      this.log("scene_switched", action);
      if (this.returnTimer) this.clearTimer(this.returnTimer);
      this.returnTimer = this.setTimer(() => { void this.returnToPrevious(); }, Math.max(1, this.options.returnSeconds) * 1000);
    } catch {
      this.log("scene_switch_failed", action);
    }
  }

  async stop(): Promise<void> {
    if (this.returnTimer) this.clearTimer(this.returnTimer);
    this.returnTimer = undefined;
    this.previousScene = undefined;
    this.connected = false;
    try { await this.client.disconnect(); } catch { /* shutdown is best effort */ }
  }

  private async returnToPrevious(): Promise<void> {
    const previous = this.previousScene;
    this.returnTimer = undefined;
    this.previousScene = undefined;
    if (!previous || !this.connected) return;
    try {
      await this.client.call("SetCurrentProgramScene", { sceneName: previous });
      this.log("scene_returned", previous);
    } catch {
      this.log("scene_return_failed", "previous scene");
    }
  }
}

function isSceneAction(action: string): action is ObsSceneAction {
  return action === "obs_scene_1" || action === "obs_scene_2" || action === "obs_scene_3";
}
