import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { ApiClient } from "@twurple/api";
import { RefreshingAuthProvider, type AccessToken } from "@twurple/auth";
import { EventSubWsListener } from "@twurple/eventsub-ws";
import { config } from "../config.js";
import type { TwitchEventName } from "./events.js";

const tokenPath = resolve("data/twitch-token.json");
const requiredScopes = ["user:read:chat", "moderator:read:followers", "channel:read:subscriptions", "bits:read", "channel:read:hype_train"];

export interface TwitchRuntimeOptions {
  onEvent: (name: TwitchEventName, event: unknown) => void;
  onStatus?: (message: string) => void;
}

export interface TwitchRuntime {
  stop: () => void;
  sendChatReply: (message: string) => void;
}

export async function startTwitchRuntime(options: TwitchRuntimeOptions): Promise<TwitchRuntime | undefined> {
  if (!config.twitchClientId || !config.twitchClientSecret) {
    options.onStatus?.("Twitch is not configured. Add app credentials and run npm run twitch:auth.");
    return undefined;
  }
  let token: AccessToken;
  try {
    token = JSON.parse(await readFile(tokenPath, "utf8")) as AccessToken;
  } catch {
    options.onStatus?.("Twitch token is missing. Run npm run twitch:auth after creating a Twitch app.");
    return undefined;
  }

  const auth = new RefreshingAuthProvider({ clientId: config.twitchClientId, clientSecret: config.twitchClientSecret });
  auth.onRefresh(async (_userId, refreshed) => writeFile(tokenPath, `${JSON.stringify(refreshed, null, 2)}\n`, { mode: 0o600 }));
  auth.onRefreshFailure((_userId, error) => options.onStatus?.(`Twitch token refresh failed: ${error.message}`));
  const tokenUserId = await auth.addUserForToken(token);
  const broadcasterId = config.twitchBroadcasterId || tokenUserId;
  const apiClient = new ApiClient({ authProvider: auth });
  const scopes = await auth.getCurrentScopesForUser(broadcasterId);
  const missing = requiredScopes.filter((scope) => !scopes.includes(scope));
  if (config.chatReplies === "on" && !scopes.includes("user:write:chat")) missing.push("user:write:chat (CHAT_REPLIES=on)");
  if (missing.length) options.onStatus?.(`Twitch token is missing scopes: ${missing.join(", ")}. Re-run npm run twitch:auth.`);

  const listener = new EventSubWsListener({ apiClient, ...(config.twitchEventSubWsUrl ? { url: config.twitchEventSubWsUrl } : {}) });
  listener.onUserSocketReady((userId, sessionId) => options.onStatus?.(`EventSub WebSocket ready for ${userId} (session ${sessionId}).`));
  listener.onUserSocketDisconnect((_userId, error) => {
    if (error) options.onStatus?.(`EventSub WebSocket disconnected: ${error.message}`);
  });
  const on = (name: TwitchEventName) => (event: unknown) => options.onEvent(name, event);
  listener.onChannelChatMessage(broadcasterId, broadcasterId, on("chat"));
  listener.onChannelFollow(broadcasterId, broadcasterId, on("follow"));
  listener.onChannelSubscription(broadcasterId, on("subscribe"));
  listener.onChannelSubscriptionGift(broadcasterId, on("gift"));
  listener.onChannelCheer(broadcasterId, on("cheer"));
  listener.onChannelRaidTo(broadcasterId, on("raid"));
  listener.onChannelHypeTrainBeginV2(broadcasterId, on("hype_train"));
  listener.start();

  const sentAt: number[] = [];
  let lastSentAt = 0;
  const queue: string[] = [];
  let sending = false;
  const pump = async (): Promise<void> => {
    if (sending || config.chatReplies !== "on" || !queue.length) return;
    const now = Date.now();
    while (sentAt.length && sentAt[0]! <= now - 30_000) sentAt.shift();
    if (now - lastSentAt < 2_000 || sentAt.length >= 10) {
      setTimeout(() => void pump(), Math.max(250, lastSentAt + 2_000 - now, sentAt.length >= 10 ? sentAt[0]! + 30_000 - now : 0));
      return;
    }
    const message = queue.shift();
    if (!message) return;
    sending = true;
    try {
      await apiClient.chat.sendChatMessage(broadcasterId, message);
      lastSentAt = Date.now();
      sentAt.push(lastSentAt);
    } catch (error) {
      options.onStatus?.(`Twitch chat reply failed: ${error instanceof Error ? error.message : "unknown error"}`);
    } finally {
      sending = false;
      void pump();
    }
  };

  options.onStatus?.(`Twitch EventSub connected for broadcaster ${broadcasterId}.`);
  return {
    stop: () => listener.stop(),
    sendChatReply: (message) => {
      if (config.chatReplies !== "on") return;
      if (queue.length < 25) queue.push(message.slice(0, 500));
      void pump();
    }
  };
}

export { requiredScopes };
