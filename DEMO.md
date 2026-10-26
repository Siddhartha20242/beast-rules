# DEMO.md — 3-minute video plan (and what is real vs simulated)

Rule: label every simulated event on screen with a small "SIM" tag. Real events get no tag. Vote window is set to 8s for recording (`VOTE_SECONDS=8`).

| Time | Shot | Real or SIM |
|---|---|---|
| 0:00-0:10 | Cold open: beast with 3 parts, a sub fires, wings grow, screen shakes. No talking. | SIM sub |
| 0:10-0:30 | Codex thread: show the prompt, the test run going green (30 laws), then the SVG renderer appearing | Real |
| 0:30-1:00 | Real chat (your second account) types `!law when someone subs grow wings`. Terminal corner shows the EventSub WebSocket payload. Compile result appears, 8s vote, beast mutates. | Real chat, real EventSub |
| 1:00-1:20 | (Cut: ballot is not shown in the video. Keep one arc: propose, mutate, trigger, conflict.) | n/a |
| 1:20-1:45 | A sub fires the law: shake, confetti, a dare banner, an OBS scene switch | SIM sub, real OBS |
| 1:45-2:10 | Rejected law (`!law make the beast rob a bank` gives the fixed refusal), then kill Ollama and show the fallback parser handle the next law | Real |
| 2:10-2:30 | Conflict: a new law lands in an occupied zone, so crisis state and a vote | Real chat |
| 2:30-2:45 | Restart the app: the beast and Law Book persist (recap card not shown) | Real |
| 2:45-3:00 | One-line pitch and repo URL | n/a |

## Pitch line
"Chat writes the laws, the laws are the creature, and a local model compiles plain English into a validated rule, with a deterministic parser as a safety net."

## Do not mention in the video
Raid breeding, or anything not working on camera.

## Checklist before recording
- [ ] 30 compile tests and 2 conflict tests pass
- [ ] Sandbox mode and `npm run demo` work with no Twitch credentials
- [ ] Real Twitch connection tested with 2 accounts
- [ ] OBS scenes 1-3 mapped, dares written
- [ ] SIM tag shows on all mocked events
