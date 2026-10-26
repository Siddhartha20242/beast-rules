import type { RequestHandler } from "express";

export interface HealthSubscription {
  type: string;
  status: string;
}

export interface HealthState {
  twitchConnected: boolean;
  twitchReconnecting?: boolean;
  lastDisconnectAt?: string | null;
  reconnectAttempts?: number;
  broadcasterId: string | null;
  subscriptions: HealthSubscription[];
  compilerMode: "auto" | "ollama" | "template";
  activeLaws: number;
  obsConnected: boolean;
}

export interface HealthResponse extends HealthState {
  twitchReconnecting: boolean;
  lastDisconnectAt: string | null;
  reconnectAttempts: number;
  ollamaReachable: boolean;
}

export async function buildHealthResponse(
  state: HealthState,
  ollamaUrl: string,
  fetcher: typeof fetch = fetch,
  timeoutMs = 1200
): Promise<HealthResponse> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let ollamaReachable = false;
  try {
    const endpoint = new URL("/api/tags", ollamaUrl);
    const response = await fetcher(endpoint, { method: "GET", signal: controller.signal });
    ollamaReachable = response.ok;
  } catch {
    ollamaReachable = false;
  } finally {
    clearTimeout(timeout);
  }
  return {
    ...state,
    twitchReconnecting: state.twitchReconnecting ?? false,
    lastDisconnectAt: state.lastDisconnectAt ?? null,
    reconnectAttempts: state.reconnectAttempts ?? 0,
    subscriptions: state.subscriptions.map((item) => ({ ...item })),
    ollamaReachable
  };
}

export function createHealthHandler(getState: () => HealthState, ollamaUrl: string, fetcher: typeof fetch = fetch): RequestHandler {
  return async (_request, response) => {
    response.json(await buildHealthResponse(getState(), ollamaUrl, fetcher));
  };
}
