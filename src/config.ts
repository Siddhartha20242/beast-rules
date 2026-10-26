import "dotenv/config";

function positiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

const compilerValue = process.env.COMPILER;

export const config = {
  port: positiveInteger(process.env.PORT, 3000),
  voteSeconds: positiveInteger(process.env.VOTE_SECONDS, 30),
  crisisSeconds: positiveInteger(process.env.CRISIS_SECONDS, 20),
  compiler: compilerValue === "ollama" || compilerValue === "template" ? compilerValue : "auto",
  ollamaUrl: process.env.OLLAMA_URL ?? "http://localhost:11434",
  ollamaModel: process.env.OLLAMA_MODEL ?? "gemma3:4b",
  chatReplies: process.env.CHAT_REPLIES === "on" ? "on" : "off",
  twitchClientId: process.env.TWITCH_CLIENT_ID ?? "",
  twitchClientSecret: process.env.TWITCH_CLIENT_SECRET ?? "",
  twitchRedirectUri: process.env.TWITCH_REDIRECT_URI ?? "http://localhost:3001/auth/callback",
  twitchBroadcasterId: process.env.TWITCH_BROADCASTER_ID ?? "",
  twitchEventSubWsUrl: process.env.TWITCH_EVENTSUB_WS_URL ?? ""
} as const;
