import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { exchangeCode } from "@twurple/auth";
import { config } from "../config.js";

const scopes = ["user:read:chat", "moderator:read:followers", "channel:read:subscriptions", "bits:read", "channel:read:hype_train"];
if (config.chatReplies === "on") scopes.push("user:write:chat");

if (!config.twitchClientId || !config.twitchClientSecret) {
  throw new Error("Set TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET in .env before running twitch:auth.");
}

const redirect = new URL(config.twitchRedirectUri);
if (redirect.hostname !== "localhost" && redirect.hostname !== "127.0.0.1") {
  throw new Error("The one-time auth helper requires a localhost redirect URL.");
}
const callbackPath = redirect.pathname;
const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", redirect.origin);
  if (url.pathname !== callbackPath) {
    response.writeHead(404).end("Not found");
    return;
  }
  const code = url.searchParams.get("code");
  if (!code) {
    response.writeHead(400).end("Missing OAuth code. Re-run npm run twitch:auth.");
    return;
  }
  try {
    const token = await exchangeCode(config.twitchClientId, config.twitchClientSecret, code, config.twitchRedirectUri);
    await mkdir(resolve("data"), { recursive: true });
    await writeFile(resolve("data/twitch-token.json"), `${JSON.stringify(token, null, 2)}\n`, { mode: 0o600 });
    response.writeHead(200, { "content-type": "text/plain" }).end("Twitch authorization saved. You can close this tab.");
    console.log("Saved Twitch token to data/twitch-token.json. Restart the server to connect EventSub.");
  } catch (error) {
    response.writeHead(500).end("OAuth exchange failed. Check the terminal output.");
    console.error("Twitch OAuth exchange failed:", error);
  } finally {
    server.close();
  }
});

server.listen(Number(redirect.port || 80), redirect.hostname, () => {
  const authorize = new URL("https://id.twitch.tv/oauth2/authorize");
  authorize.searchParams.set("client_id", config.twitchClientId);
  authorize.searchParams.set("redirect_uri", config.twitchRedirectUri);
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("scope", scopes.join(" "));
  console.log(`Open this URL to authorize the streamer:\n${authorize.toString()}`);
});
