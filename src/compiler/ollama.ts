import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { config } from "../config.js";
import { validateRule } from "../schema.js";
import type { Compiler, Rule } from "./types.js";

const systemPrompt = `Convert the viewer's law idea into exactly one JSON rule matching the supplied schema. Use only the listed enum values. Do not add keys or prose. Code will validate every result.

Trigger mapping: sub, subs, subscribe, subscribed -> channel.subscribe; follow/follower -> channel.follow; raid -> channel.raid; cheer/bits -> channel.cheer; gift -> channel.subscription.gift; hype -> channel.hype_train.begin; chat/messages -> channel.chat.message. For chat, use the stated messages-per-minute threshold when present, otherwise 1. Gift takes precedence over sub when both words appear. Hype maps to channel.hype_train.begin.

Use defaults when the idea names no effect or part: confetti with low intensity, and runes in yellow. Golden/gold means yellow. Set status to the appropriate refusal enum for unsafe requests or unsupported triggers, effects, or parts. Do not invent a trigger, part, color, or effect.

Worked examples from the supported law contract:
Input: when someone subs grow wings and shake the screen
Output: {"status":"ok","trigger":{"event_type":"channel.subscribe","threshold":1},"action":{"type":"screen_shake","intensity":"low"},"mutation":{"part_id":"wings","color":"yellow"}}
Input: every follow gives the beast horns
Output: {"status":"ok","trigger":{"event_type":"channel.follow","threshold":1},"action":{"type":"confetti","intensity":"low"},"mutation":{"part_id":"horns","color":"yellow"}}
Input: on a raid make the beast roar and grow flames
Output: {"status":"ok","trigger":{"event_type":"channel.raid","threshold":1},"action":{"type":"beast_roar","intensity":"low"},"mutation":{"part_id":"flames","color":"yellow"}}
Input: when someone cheers bits give it purple lightning
Output: {"status":"ok","trigger":{"event_type":"channel.cheer","threshold":1},"action":{"type":"confetti","intensity":"low"},"mutation":{"part_id":"lightning","color":"purple"}}
Input: if chat hits 30 messages a minute flash the screen and grow spikes
Output: {"status":"ok","trigger":{"event_type":"channel.chat.message","threshold":30},"action":{"type":"screen_flash","intensity":"low"},"mutation":{"part_id":"spikes","color":"yellow"}}
Input: gift subs make the beast grow a golden crown
Output: {"status":"ok","trigger":{"event_type":"channel.subscription.gift","threshold":1},"action":{"type":"confetti","intensity":"low"},"mutation":{"part_id":"crown","color":"yellow"}}
Input: when a hype train starts throw confetti and grow extra arms
Output: {"status":"ok","trigger":{"event_type":"channel.hype_train.begin","threshold":1},"action":{"type":"confetti","intensity":"low"},"mutation":{"part_id":"extra_arms","color":"yellow"}}
Input: every 5 subs switch to scene 2 and grow armor
Output: {"status":"ok","trigger":{"event_type":"channel.subscribe","threshold":5},"action":{"type":"obs_scene_2","intensity":"low"},"mutation":{"part_id":"armor","color":"yellow"}}
Input: when chat gets loud trigger dare 1
Output: {"status":"ok","trigger":{"event_type":"channel.chat.message","threshold":1},"action":{"type":"dare_1","intensity":"low"},"mutation":{"part_id":"runes","color":"yellow"}}
Input: follows make the beast grow red eyes
Output: {"status":"ok","trigger":{"event_type":"channel.follow","threshold":1},"action":{"type":"confetti","intensity":"low"},"mutation":{"part_id":"eyes","color":"red"}}

Now compile this new input. Return JSON only.`;

export class OllamaOutputError extends Error {
  readonly kind = "output";

  constructor(message: string) {
    super(message);
    this.name = "OllamaOutputError";
  }
}

export class OllamaRequestError extends Error {
  readonly kind = "request";

  constructor(message: string) {
    super(message);
    this.name = "OllamaRequestError";
  }
}

export interface OllamaCompileOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface OllamaCompilerOptions {
  url?: string;
  model?: string;
  schemaPath?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

interface OllamaChatResponse {
  message?: { content?: unknown };
}

export class OllamaCompiler implements Compiler {
  private readonly url: string;
  private readonly model: string;
  private readonly schema: unknown;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: OllamaCompilerOptions = {}) {
    this.url = (options.url ?? config.ollamaUrl).replace(/\/+$/, "");
    this.model = options.model ?? config.ollamaModel;
    this.schema = JSON.parse(readFileSync(options.schemaPath ?? resolve("schema/rule.schema.json"), "utf8")) as unknown;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = Math.max(1, options.timeoutMs ?? 5000);
  }

  async compile(text: string, options: OllamaCompileOptions = {}): Promise<Rule> {
    const timeoutMs = Math.max(1, options.timeoutMs ?? this.timeoutMs);
    const controller = new AbortController();
    let timedOut = false;
    const onAbort = () => controller.abort(options.signal?.reason);
    if (options.signal?.aborted) onAbort();
    else options.signal?.addEventListener("abort", onAbort, { once: true });
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error("Ollama request timed out"));
    }, timeoutMs);

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.url}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          model: this.model,
          stream: false,
          format: this.schema,
          options: { temperature: 0 },
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: text }
          ]
        })
      });
    } catch (error) {
      if (timedOut) throw new OllamaRequestError(`Ollama call exceeded ${timeoutMs}ms`);
      if (options.signal?.aborted) throw new OllamaRequestError("Ollama call was cancelled");
      throw new OllamaRequestError(error instanceof Error ? error.message : "Ollama is unreachable");
    } finally {
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", onAbort);
    }

    if (!response.ok) throw new OllamaRequestError(`Ollama returned HTTP ${response.status}`);
    let body: OllamaChatResponse;
    try {
      body = await response.json() as OllamaChatResponse;
    } catch {
      throw new OllamaOutputError("Ollama returned invalid response JSON");
    }

    const content = body.message?.content;
    let parsed: unknown;
    try {
      parsed = typeof content === "string" ? JSON.parse(content) as unknown : content;
    } catch {
      throw new OllamaOutputError("Ollama returned invalid rule JSON");
    }
    if (!validateRule(parsed)) throw new OllamaOutputError("Ollama rule failed schema validation");
    return parsed as Rule;
  }
}
