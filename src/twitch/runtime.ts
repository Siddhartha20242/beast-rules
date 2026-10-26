import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { ApiClient } from "@twurple/api";
import { RefreshingAuthProvider, type AccessToken } from "@twurple/auth";
import { EventSubWsListener } from "@twurple/eventsub-ws";
import { config } from "../config.js";
import type { HealthSubscription } from "../health.js";
import { formatEventSubLogLine } from "./logging.js";
import type { TwitchEventName } from "./events.js";

const tokenPath = resolve("data/twitch-token.json");
const requiredScopes = ["user:read:chat", "moderator:read:followers", "channel:read:subscriptions", "bits:read", "channel:read:hype_train"];

export interface TwitchRuntimeOptions {
  onEvent: (name: TwitchEventName, event: unknown) => void;
  onStatus?: (message: string) => void;
  onConnectionChange?: (connected: boolean, broadcasterId: string) => void;
  onSubscriptionsChange?: (subscriptions: HealthSubscription[]) => void;
}

export interface TwitchRuntime {
  stop: () => void;
  sendChatReply: (message: string) => void;
  readonly broadcasterId: string;
  readonly isConnected: boolean;
  getSubscriptions: () => HealthSubscription[];
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
  auth.onRefreshFailure(() => options.onStatus?.("Twitch token refresh failed. Re-run npm run twitch:auth."));
  const tokenUserId = await auth.addUserForToken(token);
  const broadcasterId = config.twitchBroadcasterId || tokenUserId;
  const apiClient = new ApiClient({ authProvider: auth });
  const scopes = await auth.getCurrentScopesForUser(broadcasterId);
  const missing = requiredScopes.filter((scope) => !scopes.includes(scope));
  if (config.chatReplies === "on" && !scopes.includes("user:write:chat")) missing.push("user:write:chat (CHAT_REPLIES=on)");
  if (missing.length) options.onStatus?.(`Twitch token is missing scopes: ${missing.join(", ")}. Re-run npm run twitch:auth.`);

  const listener = new EventSubWsListener({ apiClient, ...(config.twitchEventSubWsUrl ? { url: config.twitchEventSubWsUrl } : {}) });
  let connected = false;
  const subscriptions: Array<{ type: string; status: string; handle: ReturnType<EventSubWsListener["onChannelFollow"]> }> = [];
  const getSubscriptions = () => subscriptions.map(({ type, status }) => ({ type, status }));
  const publishSubscriptions = () => options.onSubscriptionsChange?.(getSubscriptions());
  const register = (type: string, handle: ReturnType<EventSubWsListener["onChannelFollow"]>) => {
    subscriptions.push({ type, status: "pending", handle });
  };
  listener.onSubscriptionActivate((subscription) => {
    const record = subscriptions.find((item) => item.handle === subscription);
    if (record) { record.status = "active"; publishSubscriptions(); }
  });
  listener.onSubscriptionCreateSuccess((subscription) => {
    const record = subscriptions.find((item) => item.handle === subscription);
    if (record) { record.status = "active"; publishSubscriptions(); }
  });
  listener.onSubscriptionDeactivate((subscription) => {
    const record = subscriptions.find((item) => item.handle === subscription);
    if (record) { record.status = "pending"; publishSubscriptions(); }
  });
  listener.onSubscriptionCreateFailure((subscription) => {
    const record = subscriptions.find((item) => item.handle === subscription);
    if (record) { record.status = "failed"; publishSubscriptions(); }
    options.onStatus?.(`EventSub subscription failed: ${record?.type ?? "unknown type"}. Check scopes and broadcaster access.`);
  });
  listener.onRevoke((subscription, status) => {
    const record = subscriptions.find((item) => item.handle === subscription);
    if (record) { record.status = `revoked:${status}`; publishSubscriptions(); }
  });
  listener.onUserSocketReady((userId) => {
    connected = true;
    options.onConnectionChange?.(true, broadcasterId);
    options.onStatus?.(`EventSub WebSocket connected for broadcaster ${broadcasterId}.`);
    void userId;
  });
  listener.onUserSocketDisconnect((_userId, error) => {
    connected = false;
    for (const item of subscriptions) if (item.status === "active") item.status = "reconnecting";
    publishSubscriptions();
    options.onConnectionChange?.(false, broadcasterId);
    options.onStatus?.(error ? "EventSub WebSocket disconnected unexpectedly." : "EventSub WebSocket disconnected.");
  });
  const on = (name: TwitchEventName) => (event: unknown) => {
    if (config.logEvents === "on") console.info(formatEventSubLogLine(name, event));
    options.onEvent(name, event);
  };
  register("channel.chat.message", listener.onChannelChatMessage(broadcasterId, broadcasterId, on("chat")));
  register("channel.follow", listener.onChannelFollow(broadcasterId, broadcasterId, on("follow")));
  register("channel.subscribe", listener.onChannelSubscription(broadcasterId, on("subscribe")));
  register("channel.subscription.gift", listener.onChannelSubscriptionGift(broadcasterId, on("gift")));
  register("channel.cheer", listener.onChannelCheer(broadcasterId, on("cheer")));
  register("channel.raid", listener.onChannelRaidTo(broadcasterId, on("raid")));
  register("channel.hype_train.begin", listener.onChannelHypeTrainBeginV2(broadcasterId, on("hype_train")));
  publishSubscriptions();
  listener.start();
  options.onStatus?.("Subscribed to the broadcaster's own chat messages; broadcaster !law commands and votes are processed.");

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
    } catch {
      options.onStatus?.("Twitch chat reply failed. Check the chat scope and broadcaster permissions.");
    } finally {
      sending = false;
      void pump();
    }
  };

  options.onStatus?.(`Twitch EventSub starting for broadcaster ${broadcasterId}.`);
  return {
    stop: () => listener.stop(),
    get broadcasterId() { return broadcasterId; },
    get isConnected() { return connected; },
    getSubscriptions,
    sendChatReply: (message) => {
      if (config.chatReplies !== "on") return;
      if (queue.length < 25) queue.push(message.slice(0, 500));
      void pump();
    }
  };
}

export { requiredScopes };
