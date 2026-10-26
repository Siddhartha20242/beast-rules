# AGENTS.md — Beast Rules

## Mission
Beast Rules is a Twitch overlay where chat writes the laws of the stream and the laws are the creature. Viewers propose a law in plain English; a Codex-class model compiles it to a schema-validated rule; chat votes; a passed law fires on Twitch events AND grows one visible part on an SVG beast. Persistent across streams.

## Judging rules this project is built against (official)
Stage One is pass/fail: fits the theme and reasonably applies Codex. Stage Two has four equally weighted criteria: Innovation/Idea, Potential Impact (useful or entertaining for streamers and communities), Technological implementation (how well built, how well Codex is used), Design (easy to use, fun to watch). Ties break on Innovation first, then Impact. Judging may include automated AI analysis, so the README and Devpost text must be complete, plain and self-explanatory. Max score is 40.
- Innovation: lead with "the rule system is the visual system" everywhere.
- Impact: show it works for small streams (chat-activity triggers need no subs or raids) and for large ones.
- Technology: tests, safety gate, and a visible Codex workflow: use Codex to write code, then to review it (its own review pass) and to harden tests; log each step in `docs/CODEX_LOG.md`.
- Design: an always-visible "how to play" strip on the overlay (`!law <idea>`) so a new viewer knows what to type with no explanation.

## Scope tiers (read first)
Core idea: the rule system is the visual system. Every feature must serve that or be cut.
- **Tier 1, must demo cold (the submission is these five):** (1) `!law` text compiled to a schema-valid rule, (2) chat vote, (3) a passed law grows one part on the beast and fires on a Twitch event, (4) zone replacement (new law overrides the old one), (5) sandbox mode with fake viewers, plus the always-visible "how to play" strip on the overlay.
- **Tier 2, only after Tier 1 runs end to end and has been used by someone else:** numbered ballot (type 1/2/3, lowers friction), persistence, OBS scene switch, fallback parser polish, Law Book and `!law N` highlight, crisis vote, audio and animation polish.
- **Tier 3, cut unless there is spare time:** streamer dares, recap card, raid breeding.
Describe in the README and video only what is running. Do not mention anything from Tier 2 or 3 that is not demonstrably working.

## Stack
- Node.js + TypeScript, Express, `ws`
- Twitch: `@twurple/api`, `@twurple/eventsub-ws` (EventSub WebSocket transport: no public URL needed)
- Compiler: ZERO-COST constraint. The project must run with no paid API and no key. Define a `Compiler` interface with two implementations:
  1. `OllamaCompiler` (primary when Ollama is reachable): local model using Ollama's structured-output `format` option with `schema/rule.schema.json`. Schema-validate every result.
  2. `TemplateCompiler` (circuit-breaker fallback): deterministic pattern parser. Used automatically when Ollama is unreachable, times out (about 5s), or returns output that fails validation twice. Must pass the full test set on its own so the repo runs with nothing installed.
  Do not add paid-API dependencies. `COMPILER=auto|ollama|template`, default `auto`. Log which path handled each law and show it in the streamer panel.
- Overlay: plain HTML + SVG + vanilla JS or Alpine (OBS browser source). Keep it dependency-light.
- Storage: one JSON file (`data/beast.json`). No database.
- Secrets in `.env` only. Provide `.env.example`. Never commit keys.

## Architecture rules
1. The model only does one job at runtime: plain English -> schema-valid rule JSON. No free text from the model is ever shown on screen. Failure reasons are enum codes mapped to fixed messages by code.
2. `id`, `raw_text`, `zone`, timestamps are set by code. The model never emits them.
3. Zone is derived from `part_id` (deterministic map below). 5 zones, one active part each.
   - head: horns, eyes, crown
   - torso: spikes, armor, scales
   - back: wings, tail, shell
   - limbs: tentacles, claws, extra_arms
   - aura: flames, runes, lightning
4. A new law in an occupied zone REPLACES the old law entirely (old law is repealed, its trigger stops firing, it moves to the Law Book history as "overruled by Law N"). The beast must always equal the active laws.
4a. Backpressure: compile one proposal at a time, off the main thread. If the compile queue is more than 2 deep or a model call is still running, send the next proposal directly to `TemplateCompiler`. Never block voting or event handling on the model.
4b. Dare text lives only in `config.json`, written by the streamer. On load, validate dare text (length cap, no URLs, reject entries matching a small blocklist and warn the streamer). The compiler can only reference `dare_1..3`.
5. Validation failure -> one retry -> fixed "could not understand" state. Never parse corrupt output.
6. Server is the single source of truth. Overlay gets a full state snapshot on connect and on every change (no event replay). Overlay reconnects automatically.
7. Rule firing (confetti, shake) is immediate. Only the beast mutation animation is queued (about 3s each, queue depth max 3).
8. Voting pipeline: compile the next proposal while the current one is being voted on. Per-viewer cooldown, global queue cap, streamer veto and kill-switch (`!beast pause`).
9. Conflict detection is plain code (same trigger, opposing effect/zone). The model never decides conflicts.
10. Proposal input: chat command `!law <text>` always works; channel point redemption is an optional extra for affiliates.
11. Traceability is on screen, not clickable: `!law 7` highlights its part and shows its text; an idle spotlight cycles through parts.

## EventSub notes
- Real type names: `channel.chat.message` (not `channel.chat_message`), `channel.follow` v2 (needs `moderator:read:followers` scope), `channel.subscribe`, `channel.subscription.gift`, `channel.cheer`, `channel.raid`, `channel.hype_train.begin`.
- Dev loop: Twitch CLI mock events for repeatable demos.
- Dedupe: Twitch delivers at least once. Keep a bounded set of processed `message_id` values and skip repeats. Ignore events whose `message_timestamp` is older than 10 minutes.
- Chat send limits: a normal account may send 20 messages per 30s and 1 per second per channel; exceeding it gets the bot ignored for an hour. Show compile results, refusals and vote status on the overlay, not in chat. Any chat reply goes through a hard rate cap (at most 1 per 2s, 10 per 30s) and is optional (`CHAT_REPLIES=off` by default).
- This app is an "installed chatbot" (runs on the streamer's machine, streamer authenticates). The README must say so and list the scopes it needs.
- Tier 3 idea, verify scopes and account requirements first: create a stream marker when a law passes.

## Roadmap (do in order, commit after each)
- [ ] 1. Project skeleton, config, `.env.example`, lint, test runner.
- [ ] 2. `src/compiler/`: `Compiler` interface, `TemplateCompiler` first (all 30 cases in `tests/laws.json` pass: valid, unsupported, vague, unsafe, conflicting), then `OllamaCompiler` behind the same interface. Validate every output against the schema.
- [ ] 3. `src/engine.ts`: rule store, zone override, conflict detection, event matching, persistence.
- [ ] 4. Twitch layer: EventSub WS + chat reader, command parser, cooldowns.
- [ ] 5. Voting: Twitch-chat vote with 30s window, quorum rules, streamer override.
- [ ] 6. Overlay: SVG beast with 15 parts (flat style, one palette per color name), Law Book panel, gauge for vote, snapshot-based WebSocket client.
- [ ] 7. Streamer panel: pause, veto, clear beast, rename beast.
- [ ] 8. Demo harness: scripted events for recording; README with setup in under 5 minutes.

## Participation and stakes (build right after step 6)
- [ ] 6a. Numbered ballot: every N minutes (config) post 3 suggested laws built by deterministic templates from recent events. Chat votes by typing `1`, `2` or `3`. `!law <text>` stays as the freeform path.
- [ ] 6b. Streamer dares: `dare_1..3` actions show the streamer-written dare text from `config.json` (trusted, streamer-authored, never chat-authored) as an on-screen banner for a set duration.
- [ ] 6c. Constitutional crisis: when the engine detects two conflicting laws, enter a 20-second crisis state (overlay warning, beast flickers) and run a chat vote on which law survives. Deterministic, no model.

## Demo mode and polish (required, not optional)
- [ ] D1. Sandbox mode (`npm run sandbox`): a local control page with buttons that act as several fake viewers (names like viewer_1..5) to propose laws, vote, and fire follow/sub/raid/cheer/chat-spike events. No Twitch credentials needed. Every simulated event shows a small "SIM" tag in the overlay. A judge must be able to clone the repo, run one command, and see the beast change within 60 seconds.
- [ ] D2. `npm run demo`: a scripted replay following DEMO.md, deterministic, with `VOTE_SECONDS` configurable.
- [ ] D3. Polish: beast idle animation (breathing), a distinct mutation flash, a gavel animation on pass, a crisis effect, and short synthesized audio cues using Web Audio (no audio files, no copyright). Mutation transition about 1s.
- [ ] D4. `docs/CODEX_LOG.md`: after each roadmap step, append the prompt used, what Codex produced, and what you changed by hand. Keep it honest. The README links to it in a "How Codex built this" section.
- [ ] D5. Test contract: `tests/laws.json` must pass for every compiler (compile cases and conflict cases). Run it in CI-style `npm test`.

## README and submission docs (required)
- [ ] R1. README opens with sandbox: `npm install && npm run sandbox`, no credentials, beast visible in 60 seconds. Twitch setup comes after.
- [ ] R2. Safety gate diagram in the README (Mermaid or ASCII): `chat input -> Ollama (enum-only schema) -> schema validation -> [fail] -> template parser -> deterministic rule engine -> overlay`. One sentence under it: the model cannot output anything the schema does not list.
- [ ] R3. "How Codex built this" section: link `docs/CODEX_LOG.md`, show the test set going red to green, and include at least one REAL failure Codex produced and how the spec or prompt was changed. Do not invent examples. State plainly that no model call runs through Codex at runtime.
- [ ] R4. Text-only comparison with node-based automation tools (no screenshots or logos of third-party products). Use laws the engine really supports as examples.

## Upgrades (after step 8 works end to end)
- [ ] 9. OBS control via obs-websocket: `obs_scene_1..3` actions switch to scenes the streamer maps in config. Chat never names a scene. Auto-return to the previous scene after a few seconds. Streamer kill-switch applies.
- [ ] 10. Recap card: at stream end, render a shareable PNG of the beast plus the top laws.
- [ ] 11. STRETCH, only if steps 1-10 are solid by day 6: Raid Breeding. On `channel.raid` from a streamer running the app, fetch their public beast snapshot, build an offspring (zones from each parent, deterministic by raid id), save for both channels. Needs a tiny shared endpoint. Cut first if time is short.

## Out of scope
Twitch Extension, accounts/login on a website, fossil gallery site, arbitrary code generation by chat.
