# Constitution Beast

An interactive Twitch overlay where chat proposes laws that mutate a shared SVG beast. Start the local sandbox with `npm run sandbox`, then open `http://localhost:3000/sandbox.html` and use `http://localhost:3000/overlay.html` as an OBS browser source.

## Twitch layer

### Create and authorize the Twitch app

1. Create an app in the [Twitch Developer Console](https://dev.twitch.tv/console/apps). Choose **Confidential** and **Chat Bot** (the streamer account authorizes and sends replies).
2. Add this exact OAuth redirect URL to the app: `http://localhost:3001/auth/callback`.
3. Copy its client ID and client secret to `.env` as `TWITCH_CLIENT_ID` and `TWITCH_CLIENT_SECRET`. Keep the secret private. Set `TWITCH_REDIRECT_URI=http://localhost:3001/auth/callback`.
4. Run `npm run twitch:auth` and open the printed URL while logged in as the streamer. The helper exchanges the authorization code and saves the refreshable token to `data/twitch-token.json` (ignored by Git).
5. Start the server with `npm run sandbox`. Set `TWITCH_BROADCASTER_ID` only if you want to explicitly pin the broadcaster; otherwise it is read from the authorized token.

### Scopes

The streamer token needs exactly these scopes for the subscribed events and chat commands:

- `user:read:chat` — receive `channel.chat.message` and identify chatters.
- `moderator:read:followers` — required by `channel.follow` version 2. The streamer is the moderator for their own channel.
- `channel:read:subscriptions` — receive `channel.subscribe` and `channel.subscription.gift`.
- `bits:read` — receive `channel.cheer`.
- `channel:read:hype_train` — receive `channel.hype_train.begin` version 2.
- `channel.raid` requires no OAuth scope.

When `CHAT_REPLIES=on`, the auth helper also requests the optional `user:write:chat` scope. Chat replies are off by default. After changing scopes, run the auth helper again to replace the token.

### Twitch CLI mock events

Install and authenticate the [Twitch CLI](https://dev.twitch.tv/docs/cli/), then start its local EventSub mock server:

```sh
twitch event websocket start-server --port 8080
```

Set `TWURPLE_MOCK_API_PORT=8080` in the environment used to start Constitution Beast. Twurple then points both its WebSocket and mock EventSub subscription API at the CLI. Keep the streamer token and scopes configured as above; the CLI mock server replaces the EventSub connection and subscription API, not the app's OAuth login. The application logs the EventSub session ID once the mock socket is ready. Start `npm run sandbox` in a second terminal after the CLI server is ready. (For an alternate WebSocket endpoint, `TWITCH_EVENTSUB_WS_URL` can set the socket URL.)

Trigger one of the registered mock events in another terminal, using the session ID printed by the app:

```sh
twitch event trigger channel.follow -T websocket --session SESSION_ID -u BROADCASTER_ID
twitch event trigger channel.subscribe -T websocket --session SESSION_ID -u BROADCASTER_ID
twitch event trigger channel.subscription.gift -T websocket --session SESSION_ID -u BROADCASTER_ID
twitch event trigger channel.cheer -T websocket --session SESSION_ID -u BROADCASTER_ID
twitch event trigger channel.raid -T websocket --session SESSION_ID -u BROADCASTER_ID
twitch event trigger channel.hype_train.begin -T websocket --session SESSION_ID -u BROADCASTER_ID
twitch event trigger channel.chat.message -T websocket --session SESSION_ID -u BROADCASTER_ID
```

Replace `BROADCASTER_ID` with the authorized broadcaster's numeric ID and `SESSION_ID` with the current session printed at startup. Mock event support can vary by installed Twitch CLI version; run `twitch event trigger --help` for its installed command syntax. The chat trigger can supply the `!law`, vote, and highlight text in its mock payload.

Chat commands are `!law <idea>` to propose, `yes`/`1` or `no`/`2` to vote, and `!law <number>` to highlight an active `law-N`. Message IDs are deduplicated before commands run. Failed proposals show a fixed refusal banner on the overlay.
