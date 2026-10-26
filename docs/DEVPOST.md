# Devpost draft (edit the [brackets] after recording; delete anything not working)

## Project name
Beast Rules

## Tagline
Chat writes the laws of the stream, and the laws are the creature.

## Description

**What it does.** Viewers type a law in plain English (`!law when someone subs grow wings and shake the screen`). A compiler turns the sentence into a strict rule built only from a fixed vocabulary of Twitch events, overlay effects and body parts. Chat votes. If the law passes, it fires on real Twitch events and grows one visible part on a creature in the stream overlay. The beast has five body zones; a new law in an occupied zone triggers a "constitutional crisis" in which chat votes on which of the two laws survives. The beast and its laws persist across restarts, so the creature is the channel's history.

**Why it is different.** The rule system is the visual system: every law you can read is a part you can see. The compiler is safe by construction. It can only emit enum values from the schema, so no model-written text ever reaches the screen, and anything outside the vocabulary gets a fixed refusal.

**How it connects to Twitch.** EventSub over WebSocket (chat messages, follows, subs, gifted subs, cheers, raids, hype train). Laws can also fire from chat activity (for example, 30 messages a minute), which works for small channels with no subs or raids. [Subs, raids and cheers in the demo are simulated with a labeled SIM tag; chat and chat-activity laws are live.]

**Compiler design.** A deterministic parser runs first. Only when it cannot decide does a local model (Ollama, gemma3:4b) try, and a verifier accepts the model's answer only if the trigger, part, color and effect actually appear in the law text. Measured on 30 unseen phrasings: parser alone 76.7%, parser plus verified model rescue 80 to 83% (varies by run). The 28-case contract test set and both held-out sets are in `tests/`. [Update numbers if you rerun.]

**How we used Codex.** Codex built the entire project in one thread, driven by a spec (`AGENTS.md`), a JSON Schema and a 28-case contract test set that every compiler must pass. Each roadmap step was one prompt and ended with tests, build and lint. The log of prompts, results and every failure Codex hit is in `docs/CODEX_LOG.md`. Runtime does not call Codex: the model at runtime is a local Ollama model, so the project runs at no cost. [Add one concrete Codex mistake and how the spec fixed it, from the log.]

**Try it in 60 seconds, no Twitch account needed.** `npm install && npm run sandbox`, open the sandbox page, act as viewer_1 to viewer_5, propose a law, vote, and fire simulated events.

**Tech.** TypeScript, Node, Express, ws, Twurple (EventSub WebSocket), Ajv, Vitest, Ollama, plain SVG overlay for OBS.

**What is not built.** [List honestly, for example: OBS scene switching, numbered ballot, audio.]

## Built with
typescript, node.js, twitch-eventsub, twurple, ollama, openai-codex, svg

## Links
- Repo: [URL] (shared with testing@devpost.com if private)
- Video: [YouTube URL]
- Codex session ID: [from /status in the build thread]
