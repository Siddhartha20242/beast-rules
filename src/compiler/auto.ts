import { OllamaCompiler, OllamaOutputError, OllamaRequestError } from "./ollama.js";
import { TemplateCompiler } from "./template.js";
import { verifyModelRule } from "./verify.js";
import type { Compiler, Rule } from "./types.js";

export type CompilerPath = "parser" | "model (verified)" | "parser (model rejected)";

export interface CompiledRule {
  rule: Rule;
  path: CompilerPath;
}

export interface AutoCompilerOptions {
  ollama?: OllamaCompiler;
  template?: Compiler;
  timeoutMs?: number;
  queueDepth?: () => number;
}

export class AutoCompiler implements Compiler {
  private readonly ollama: OllamaCompiler;
  private readonly template: Compiler;
  private readonly timeoutMs: number;
  private readonly queueDepth: () => number;
  private ollamaRunning = false;

  constructor(options: AutoCompilerOptions = {}) {
    this.ollama = options.ollama ?? new OllamaCompiler();
    this.template = options.template ?? new TemplateCompiler();
    this.timeoutMs = Math.max(1, options.timeoutMs ?? 5000);
    this.queueDepth = options.queueDepth ?? (() => 0);
  }

  async compile(text: string): Promise<Rule> {
    return (await this.compileWithPath(text)).rule;
  }

  async compileWithPath(text: string): Promise<CompiledRule> {
    const parserRule = await this.template.compile(text);
    if (parserRule.status === "unsafe" || parserRule.status === "ok") {
      return { rule: parserRule, path: "parser" };
    }
    if (this.ollamaRunning || this.queueDepth() > 2) return { rule: parserRule, path: "parser" };

    this.ollamaRunning = true;
    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const controller = new AbortController();
        let timeout: ReturnType<typeof setTimeout> | undefined;
        try {
          const request = this.ollama.compile(text, { signal: controller.signal, timeoutMs: this.timeoutMs });
          const timedOut = new Promise<never>((_resolve, reject) => {
            timeout = setTimeout(() => {
              controller.abort();
              reject(new OllamaRequestError(`Ollama call exceeded ${this.timeoutMs}ms`));
            }, this.timeoutMs);
          });
          const rule = await Promise.race([request, timedOut]);
          if (verifyModelRule(text, rule)) return { rule, path: "model (verified)" };
          return { rule: parserRule, path: "parser (model rejected)" };
        } catch (error) {
          if (error instanceof OllamaOutputError && attempt === 0) continue;
          return { rule: parserRule, path: "parser (model rejected)" };
        } finally {
          if (timeout) clearTimeout(timeout);
        }
      }
      return { rule: parserRule, path: "parser (model rejected)" };
    } finally {
      this.ollamaRunning = false;
    }
  }

}
