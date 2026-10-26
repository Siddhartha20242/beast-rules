export interface ConnectionStatus {
  connected: boolean;
  reconnecting: boolean;
  lastDisconnectAt: string | null;
  reconnectAttempts: number;
}

const networkLayerPaths = [
  /node_modules[\\/]@twurple[\\/]/,
  /node_modules[\\/]@d-fischer[\\/]/,
  /node_modules[\\/]ws[\\/]/,
  /node_modules[\\/]obs-websocket-js[\\/]/
];
const networkErrorCodes = new Set(["ECONNRESET", "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ETIMEDOUT", "ENETUNREACH", "EHOSTUNREACH", "EPIPE", "ENETDOWN"]);
const networkMessages = [
  /WebSocket was closed before the connection was established/i,
  /socket hang up/i,
  /getaddrinfo/i,
  /keepalive/i
];

// An error is "recoverable" when it comes from the Twitch, OBS or WebSocket layer
// (top stack frame inside one of those packages) or is a plain network failure.
// Errors thrown from this project's own code are never treated as recoverable.
export function isRecoverableNetworkError(error: unknown): boolean {
  if (!(error instanceof Error)) return typeof error === "string" && networkMessages.some((pattern) => pattern.test(error));
  const code = (error as NodeJS.ErrnoException).code;
  if (typeof code === "string" && networkErrorCodes.has(code)) return true;
  if (networkMessages.some((pattern) => pattern.test(error.message))) return true;
  const firstFrame = (error.stack ?? "").split("\n").find((line) => line.trim().startsWith("at "));
  return firstFrame !== undefined && networkLayerPaths.some((pattern) => pattern.test(firstFrame));
}

export interface ProcessGuardDeps {
  log: (message: string) => void;
  exit: (code: number) => void;
}

export function handleProcessError(error: unknown, kind: "uncaughtException" | "unhandledRejection", deps: ProcessGuardDeps): "recovered" | "fatal" {
  const summary = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  if (isRecoverableNetworkError(error)) {
    deps.log(`[resilience] ${kind} from the Twitch/OBS/network layer was contained and the server keeps running: ${summary}`);
    return "recovered";
  }
  deps.log(`[resilience] ${kind} from application code is fatal: ${error instanceof Error ? (error.stack ?? summary) : summary}`);
  deps.exit(1);
  return "fatal";
}

export function installProcessGuards(deps: ProcessGuardDeps, target: Pick<NodeJS.Process, "on"> = process): void {
  target.on("uncaughtException", (error) => handleProcessError(error, "uncaughtException", deps));
  target.on("unhandledRejection", (reason) => handleProcessError(reason, "unhandledRejection", deps));
}

export interface SupervisorOptions {
  isConnected: () => boolean;
  restart: () => void | Promise<void>;
  onChange?: (status: ConnectionStatus) => void;
  log?: (message: string) => void;
  now?: () => Date;
  schedule?: (callback: () => void, delayMs: number) => unknown;
  cancel?: (handle: unknown) => void;
  delaysMs?: number[];
}

// Twurple already retries forever on its own. This supervisor is the second safety net:
// if the listener is still down after a delay, stop() and start() it again, with growing waits.
export class ReconnectSupervisor {
  private readonly isConnected: () => boolean;
  private readonly restart: () => void | Promise<void>;
  private readonly onChange: ((status: ConnectionStatus) => void) | undefined;
  private readonly log: (message: string) => void;
  private readonly now: () => Date;
  private readonly schedule: (callback: () => void, delayMs: number) => unknown;
  private readonly cancel: (handle: unknown) => void;
  private readonly delaysMs: number[];
  private timer: unknown;
  private connected = false;
  private lastDisconnectAt: string | null = null;
  private attempts = 0;
  private stopped = false;

  constructor(options: SupervisorOptions) {
    this.isConnected = options.isConnected;
    this.restart = options.restart;
    this.onChange = options.onChange;
    this.log = options.log ?? (() => undefined);
    this.now = options.now ?? (() => new Date());
    this.schedule = options.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.cancel = options.cancel ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
    this.delaysMs = options.delaysMs ?? [5_000, 10_000, 20_000, 30_000];
  }

  status(): ConnectionStatus {
    return {
      connected: this.connected,
      reconnecting: !this.connected && this.timer !== undefined,
      lastDisconnectAt: this.lastDisconnectAt,
      reconnectAttempts: this.attempts
    };
  }

  notifyConnected(): void {
    this.connected = true;
    this.attempts = 0;
    this.clearTimer();
    this.emit();
  }

  // Start supervising the first connection attempt without recording it as a disconnect.
  watch(): void {
    if (this.stopped) return;
    this.connected = false;
    if (this.timer === undefined) this.scheduleNext();
    this.emit();
  }

  notifyDisconnected(): void {
    if (this.stopped) return;
    this.connected = false;
    this.lastDisconnectAt = this.now().toISOString();
    if (this.timer === undefined) this.scheduleNext();
    this.emit();
  }

  stop(): void {
    this.stopped = true;
    this.clearTimer();
  }

  private scheduleNext(): void {
    const delay = this.delaysMs[Math.min(this.attempts, this.delaysMs.length - 1)] ?? 30_000;
    this.timer = this.schedule(() => void this.tick(), delay);
  }

  private async tick(): Promise<void> {
    this.timer = undefined;
    if (this.stopped || this.isConnected() || this.connected) return;
    this.attempts += 1;
    this.log(`[resilience] Twitch still disconnected; restarting the EventSub listener (attempt ${this.attempts}).`);
    try {
      await this.restart();
    } catch (error) {
      this.log(`[resilience] EventSub restart failed and will be retried: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!this.stopped && !this.connected) this.scheduleNext();
    this.emit();
  }

  private clearTimer(): void {
    if (this.timer !== undefined) this.cancel(this.timer);
    this.timer = undefined;
  }

  private emit(): void {
    this.onChange?.(this.status());
  }
}
