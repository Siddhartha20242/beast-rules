# Demo script, crowd plan and recording day

Target: under 3:00 on YouTube. Record with `VOTE_SECONDS=8` and `CRISIS_SECONDS=10`. Label every simulated event "SIM" (the overlay already does this). Real = typed by a real account in real Twitch chat.

## Pre-flight (30 minutes before)
- [ ] `npm run sandbox`, then `curl localhost:3000/health` shows `twitchConnected: true` and 7 active subscriptions
- [ ] Ollama running, model warmed: `ollama run gemma3:4b "ready"` once
- [ ] Reset the beast: stop the server, delete `data/beast.json`, start again. Beast starts blank.
- [ ] OBS browser source = `http://localhost:3000/overlay.html`, 1920x1080, transparent background
- [ ] Terminal window visible in a corner, `LOG_EVENTS=on` (shows real EventSub lines)
- [ ] 5 to 10 friends in `twitch.tv/siddhartha2026` chat, each with the cheat sheet below

## Crowd cheat sheet (send to friends)
You are in chat for a stream where chat writes the laws. Type exactly these when told:
- To propose: `!law <idea>` (only the person assigned to that line)
- To vote: `yes` or `no`
- During a crisis vote: `1` keeps the old law, `2` keeps the new one
Assigned laws (all verified to compile):
1. Friend A: `!law when someone subs grow wings and shake the screen`
2. Friend B: `!law every follow gives the beast horns`
3. Friend C: `!law follows make the beast grow red eyes`  (same zone as horns, so it triggers the crisis)
4. Friend D: `!law if chat hits 30 messages a minute flash the screen and grow spikes`
5. Everyone: spam any chat messages when told (this is the real chat-activity trigger)
6. Friend E: `!law make the beast rob a bank` (shows the refusal)

## Shot list (about 2:50)
| Time | Screen | Narration (read it, do not improvise) |
|---|---|---|
| 0:00-0:10 | Cold open: overlay full screen. A law banner reads the law text and a part grows (wings). No title card. | (silence, then) "Chat just wrote a law. And the law became part of the creature." |
| 0:10-0:25 | Overlay plus Twitch chat side by side. | "This is Constitution Beast. Viewers type a law in plain English. Chat votes. If it passes, it fires on real Twitch events and grows a part on the beast." |
| 0:25-0:55 | Friend A proposes the wings law in real chat. Terminal corner shows the EventSub line. Vote bar fills, friends type yes, wings grow. | "That message came through Twitch EventSub. A compiler turns it into a strict rule, with no free text and no code. Chat votes, and the law is enacted." |
| 0:55-1:20 | Friend B proposes horns, passes. Press the SIM subscribe button. Screen shakes, SIM tag shows. | "Now the law runs. A sub, simulated here and labeled, triggers the shake." |
| 1:20-1:45 | Friend D proposes the 30-messages law. Everyone spams chat. Spikes law fires from real chat activity. | "This one needs no subs or raids. It fires from chat activity, so it works for small streams too." |
| 1:45-2:10 | Friend E proposes the bank law. Refusal appears. Then show the log line with `status="unsafe"` or unsupported. | "The compiler only knows a fixed vocabulary. Anything outside it is refused, and the model can never write text onto the screen." |
| 2:10-2:35 | Friend C proposes red eyes (head zone, conflicts with horns). Crisis banner, both laws, vote 1 or 2, winner applied. | "Two laws want the same body zone. That is a constitutional crisis, and chat votes on which survives." |
| 2:35-2:50 | Stop and restart the server. Overlay returns with the same beast and laws. Flash the Codex build log or green tests for 3 seconds. | "The beast persists across streams. Codex built the whole project, driven by a test suite, and the log is in the repo." |
| 2:50-3:00 | Title card: name, repo URL. | "Constitution Beast. Chat writes the laws, and the laws are the creature." |

## Cutting rules
- If the crisis or the refusal does not record cleanly in two takes, cut it. Do not mention anything not shown.
- Do not show tokens, `.env`, or the Twitch developer console. Do not show other people's names without their OK; use their handles only if they agree.
- No copyrighted music. Sound effects only if they are made in the app.
- Build footage: 10 to 15 seconds of Codex or the green test run at the start of the video, not the end. The rules require showing how it was built with Codex.

## Common failures
| Problem | Fix |
|---|---|
| Vote closes before friends type | Raise `VOTE_SECONDS` to 12 for rehearsal, 8 only when everyone is ready |
| Same friend proposes twice and is blocked | Per-viewer cooldown; rotate proposers as above |
| Parser misreads a law | Use only the exact sentences above |
| Chat blocked | Check the channel allows chat while offline in Creator Dashboard |
