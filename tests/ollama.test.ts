import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { AutoCompiler } from "../src/compiler/auto.js";
import { OllamaCompiler } from "../src/compiler/ollama.js";
import type { Rule } from "../src/compiler/types.js";

const testRule: Rule = {
  status: "ok",
  trigger: { event_type: "channel.subscription.gift", threshold: 1 },
  action: { type: "confetti", intensity: "low" },
  mutation: { part_id: "horns", color: "red" }
};

const invalidSchemaRule = {
  ...testRule,
  mutation: { part_id: "laser_cannon", color: "red" }
};

const servers: Server[] = [];

async function serve(handler: (body: Record<string, unknown>, response: import("node:http").ServerResponse) => void | Promise<void>): Promise<string> {
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      void handler(body, response);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Mock Ollama server did not bind a TCP port");
  return `http://127.0.0.1:${address.port}`;
}

function respond(response: import("node:http").ServerResponse, content: unknown): void {
  response.writeHead(200, { "Content-Type": "application/json" });
  response.end(JSON.stringify({ message: { content: typeof content === "string" ? content : JSON.stringify(content) } }));
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }));
});

describe("OllamaCompiler and AutoCompiler", () => {
  it("accepts a verified rescue and sends the schema as Ollama's format", async () => {
    let requestBody: Record<string, unknown> | undefined;
    const url = await serve((body, response) => {
      requestBody = body;
      respond(response, testRule);
    });
    const compiler = new AutoCompiler({ ollama: new OllamaCompiler({ url, model: "test-model" }) });

    const result = await compiler.compileWithPath("a gift event grows red horns");
    expect(result).toEqual({ rule: testRule, path: "model (verified)" });
    expect(requestBody).toMatchObject({ model: "test-model", stream: false, format: expect.objectContaining({ title: "ConstitutionBeastRule" }) });
  });

  it("falls back after two invalid JSON responses", async () => {
    let calls = 0;
    const url = await serve((_body, response) => {
      calls += 1;
      respond(response, "not valid JSON");
    });
    const compiler = new AutoCompiler({ ollama: new OllamaCompiler({ url }) });

    const result = await compiler.compileWithPath("a gift event grows purple lightning");
    expect(result.path).toBe("parser (model rejected)");
    expect(result.rule.mutation).toMatchObject({ part_id: "lightning", color: "purple" });
    expect(calls).toBe(2);
  });

  it("falls back after two schema violations", async () => {
    let calls = 0;
    const url = await serve((_body, response) => {
      calls += 1;
      respond(response, invalidSchemaRule);
    });
    const compiler = new AutoCompiler({ ollama: new OllamaCompiler({ url }) });

    const result = await compiler.compileWithPath("a gift event grows red horns");
    expect(result.path).toBe("parser (model rejected)");
    expect(result.rule.status).toBe("unsupported_trigger");
    expect(calls).toBe(2);
  });

  it("falls back when the Ollama request exceeds five seconds", async () => {
    const url = await serve(async (_body, response) => {
      await new Promise((resolve) => setTimeout(resolve, 200));
      if (!response.destroyed) respond(response, testRule);
    });
    const compiler = new AutoCompiler({ ollama: new OllamaCompiler({ url }), timeoutMs: 30 });

    const result = await compiler.compileWithPath("a gift event grows red horns");
    expect(result.path).toBe("parser (model rejected)");
    expect(result.rule.mutation.part_id).toBe("horns");
  });

  it("falls back when Ollama is unreachable", async () => {
    const temporaryServer = createServer();
    await new Promise<void>((resolve) => temporaryServer.listen(0, "127.0.0.1", resolve));
    const address = temporaryServer.address();
    if (!address || typeof address === "string") throw new Error("Could not allocate a port for unreachable endpoint");
    await new Promise<void>((resolve) => temporaryServer.close(() => resolve()));
    temporaryServer.closeAllConnections();
    const compiler = new AutoCompiler({ ollama: new OllamaCompiler({ url: `http://127.0.0.1:${address.port}` }) });

    const result = await compiler.compileWithPath("a gift event grows red horns");
    expect(result.path).toBe("parser (model rejected)");
  });

  it("falls back immediately when another model call is running", async () => {
    let notifyStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { notifyStarted = resolve; });
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const url = await serve(async (_body, response) => {
      notifyStarted?.();
      await blocked;
      respond(response, testRule);
    });
    const compiler = new AutoCompiler({ ollama: new OllamaCompiler({ url }), timeoutMs: 1000 });

    const first = compiler.compileWithPath("a gift event grows red horns");
    await started;
    const second = await compiler.compileWithPath("a gift event grows blue eyes");
    expect(second.path).toBe("parser");
    expect(second.rule.mutation).toMatchObject({ part_id: "eyes", color: "blue" });
    release?.();
    expect((await first).path).toBe("model (verified)");
  });

  it("falls back immediately when the Ollama queue is over two deep", async () => {
    const url = await serve((_body, response) => respond(response, testRule));
    const compiler = new AutoCompiler({
      ollama: new OllamaCompiler({ url }),
      queueDepth: () => 3
    });

    const result = await compiler.compileWithPath("a gift event grows blue eyes");
    expect(result.path).toBe("parser");
    expect(result.rule.mutation).toMatchObject({ part_id: "eyes", color: "blue" });
  });

  it("never lets the model replace a successful parser answer", async () => {
    let calls = 0;
    const url = await serve((_body, response) => {
      calls += 1;
      respond(response, testRule);
    });
    const compiler = new AutoCompiler({ ollama: new OllamaCompiler({ url }) });

    const result = await compiler.compileWithPath("follows grow red horns");
    expect(result).toMatchObject({ path: "parser", rule: { status: "ok", trigger: { event_type: "channel.follow" } } });
    expect(calls).toBe(0);
  });

  it("rejects a model rescue with a trigger that contradicts the law text", async () => {
    const wrongTrigger: Rule = { ...testRule, trigger: { event_type: "channel.follow", threshold: 1 } };
    const url = await serve((_body, response) => respond(response, wrongTrigger));
    const compiler = new AutoCompiler({ ollama: new OllamaCompiler({ url }) });

    const result = await compiler.compileWithPath("a gift event grows red horns");
    expect(result.path).toBe("parser (model rejected)");
    expect(result.rule.status).toBe("unsupported_trigger");
  });

  it("rejects a dance-to-roar model result and returns parser unsupported_effect", async () => {
    const modelMistake: Rule = {
      ...testRule,
      trigger: { event_type: "channel.follow", threshold: 1 },
      action: { type: "beast_roar", intensity: "low" },
      mutation: { part_id: "horns", color: "blue" }
    };
    const url = await serve((_body, response) => respond(response, modelMistake));
    const compiler = new AutoCompiler({ ollama: new OllamaCompiler({ url }) });

    const result = await compiler.compileWithPath("follow, make the beast dance and grow blue horns");
    expect(result.path).toBe("parser (model rejected)");
    expect(result.rule.status).toBe("unsupported_effect");
  });

  it("never asks Ollama to override an unsafe parser result", async () => {
    let calls = 0;
    const url = await serve((_body, response) => {
      calls += 1;
      respond(response, testRule);
    });
    const compiler = new AutoCompiler({ ollama: new OllamaCompiler({ url }) });

    const result = await compiler.compileWithPath("ban every chatter when a gift arrives and grow horns");
    expect(result).toMatchObject({ path: "parser", rule: { status: "unsafe" } });
    expect(calls).toBe(0);
  });
});
