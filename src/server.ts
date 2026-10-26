import express from "express";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { config } from "./config.js";
import { RuleEngine, type EngineEvent } from "./engine.js";
import { TemplateCompiler } from "./compiler/template.js";
import { VotingManager, type VoteChoice } from "./voting.js";
import { chatMessageDetails, translateTwitchEvent } from "./twitch/events.js";
import { startTwitchRuntime, type TwitchRuntime } from "./twitch/runtime.js";

const app = express();
const server = createServer(app);
const sockets = new WebSocketServer({ server });
const engine = new RuleEngine();
const compiler = new TemplateCompiler();
const voting = new VotingManager({ voteSeconds: config.voteSeconds });
const clients = new Set<WebSocket>();
let pendingLaw: { id: string; text: string; proposerId: string; rule: Awaited<ReturnType<TemplateCompiler["compile"]>> } | undefined;
let lastConflict: ReturnType<RuleEngine["add"]>["conflict"];
let twitchRuntime: TwitchRuntime | undefined;
let proposalSequence = 0;
const crisisProposalMessage = "A constitutional crisis is underway. Wait for it to resolve before proposing another law.";

app.use(express.json({ limit: "8kb" }));
app.use(express.static(resolve("public")));

function makeSnapshot() {
  const current = voting.current;
  return {
    type: "snapshot",
    active_laws: engine.activeLaws.map(({ id, raw_text, zone, timestamp, ...rule }) => ({
      id, raw_text, zone, timestamp, trigger: rule.trigger, action: rule.action, mutation: rule.mutation
    })),
    beast_parts: Object.fromEntries(engine.activeLaws.map((law) => [law.zone, {
      part_id: law.mutation.part_id,
      color: law.mutation.color,
      law_id: law.id
    }])),
    proposal: current ? {
      ...current,
      text: pendingLaw?.text,
      yes: current.yes,
      no: current.no,
      total: current.voters
    } : null,
    crisis: engine.currentCrisis ?? null,
    conflict: lastConflict ?? null
  };
}

function sendSnapshot(socket: WebSocket): void {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(makeSnapshot()));
}

function broadcastSnapshot(): void {
  const message = JSON.stringify(makeSnapshot());
  for (const socket of clients) if (socket.readyState === socket.OPEN) socket.send(message);
}

function broadcastEffect(effect: string, sim = false): void {
  const message = JSON.stringify({ type: "effect", effect, sim });
  for (const socket of clients) if (socket.readyState === socket.OPEN) socket.send(message);
}

function broadcastMessage(message: Record<string, unknown>): void {
  const wire = JSON.stringify(message);
  for (const socket of clients) if (socket.readyState === socket.OPEN) socket.send(wire);
}

const refusalText: Record<string, string> = {
  unsupported_trigger: "That trigger is not supported.",
  unsupported_effect: "That effect is not supported.",
  unsupported_part: "That beast part is not supported.",
  too_vague: "Please make the law more specific.",
  unsafe: "That law was refused for safety."
};

function showRefusal(status: keyof typeof refusalText): void {
  broadcastMessage({ type: "notice", message: refusalText[status], kind: "refusal" });
}

function showNotice(message: string): void {
  broadcastMessage({ type: "notice", message, kind: "info" });
}

async function handleTwitchChat(userId: string, text: string, messageId: string): Promise<void> {
  const command = text.trim();
  const highlight = command.match(/^!law\s+(\d+)\s*$/i);
  if (highlight) {
    const law = engine.activeLaws.find((item) => item.id === `law-${Number(highlight[1])}`);
    if (law) broadcastMessage({ type: "highlight", lawId: law.id });
    return;
  }
  const proposal = command.match(/^!law\s+(.+)$/i);
  if (proposal) {
    const lawText = proposal[1]!.trim();
    if (!lawText) return;
    if (engine.currentCrisis) {
      showNotice(crisisProposalMessage);
      twitchRuntime?.sendChatReply(crisisProposalMessage);
      return;
    }
    let rule: Awaited<ReturnType<TemplateCompiler["compile"]>>;
    try {
      rule = await compiler.compile(lawText);
    } catch {
      showRefusal("too_vague");
      return;
    }
    if (rule.status !== "ok") {
      showRefusal(rule.status);
      twitchRuntime?.sendChatReply(refusalText[rule.status]);
      return;
    }
    const proposalId = `twitch-proposal-${Date.now()}-${++proposalSequence}`;
    if (engine.currentCrisis) {
      showNotice(crisisProposalMessage);
      twitchRuntime?.sendChatReply(crisisProposalMessage);
      return;
    }
    if (!voting.startProposal(proposalId, userId)) {
      const message = "A vote is active or this viewer is on proposal cooldown.";
      showNotice(message);
      twitchRuntime?.sendChatReply(message);
      return;
    }
    pendingLaw = { id: proposalId, text: lawText, proposerId: userId, rule };
    lastConflict = undefined;
    broadcastSnapshot();
    twitchRuntime?.sendChatReply("Law proposed. Vote yes or no in chat.");
    return;
  }
  if (engine.currentCrisis && /^(1|2)$/.test(command)) {
    const counted = engine.castCrisisVote(userId, command === "1" ? "existing" : "proposed");
    if (counted) broadcastSnapshot();
    return;
  }
  const choice: VoteChoice | undefined = /^(1|yes)$/i.test(command) ? "yes" : /^(2|no)$/i.test(command) ? "no" : undefined;
  if (choice && voting.current) {
    if (voting.castVote(userId, choice)) {
      broadcastSnapshot();
      twitchRuntime?.sendChatReply("Vote counted.");
    }
  }
  void messageId;
}

function handleTwitchEvent(name: Parameters<typeof translateTwitchEvent>[0], payload: unknown): void {
  const internal = translateTwitchEvent(name, payload);
  const result = engine.handleEvent(internal);
  if (result.ignored) return;
  for (const law of result.fired) broadcastEffect(law.action.type);
  if (name === "chat") {
    const { userId, message, messageId } = chatMessageDetails(payload);
    void handleTwitchChat(userId, message, messageId);
  }
  broadcastSnapshot();
}

sockets.on("connection", (socket) => {
  clients.add(socket);
  sendSnapshot(socket);
  socket.on("close", () => clients.delete(socket));
});

app.get("/", (_request, response) => response.sendFile(resolve("public/sandbox.html")));
app.get("/api/state", (_request, response) => response.json(makeSnapshot()));

app.post("/api/sandbox/propose", async (request, response) => {
  const text = typeof request.body?.text === "string" ? request.body.text.trim() : "";
  const proposerId = typeof request.body?.viewerId === "string" ? request.body.viewerId : "";
  if (!text || !/^viewer_[1-5]$/.test(proposerId)) {
    response.status(400).json({ error: "Choose viewer_1 to viewer_5 and enter a law." });
    return;
  }
  if (engine.currentCrisis) {
    response.status(409).json({ error: crisisProposalMessage });
    return;
  }

  try {
    const rule = await compiler.compile(text);
    if (rule.status !== "ok") {
      response.status(422).json({ error: `Proposal rejected: ${rule.status}` });
      return;
    }
    if (engine.currentCrisis) {
      response.status(409).json({ error: crisisProposalMessage });
      return;
    }
    const proposalId = `proposal-${Date.now()}`;
    if (!voting.startProposal(proposalId, proposerId)) {
      response.status(409).json({ error: "A vote is already active or this viewer is on cooldown." });
      return;
    }
    pendingLaw = { id: proposalId, text, proposerId, rule };
    lastConflict = undefined;
    broadcastSnapshot();
    response.json({ ok: true, proposalId });
  } catch (error) {
    response.status(500).json({ error: error instanceof Error ? error.message : "Could not compile proposal." });
  }
});

app.post("/api/sandbox/vote", (request, response) => {
  const viewerId = typeof request.body?.viewerId === "string" ? request.body.viewerId : "";
  const choice = request.body?.choice as VoteChoice;
  if (!/^viewer_[1-5]$/.test(viewerId) || (choice !== "yes" && choice !== "no")) {
    response.status(400).json({ error: "Choose a viewer and yes or no." });
    return;
  }
  if (!voting.castVote(viewerId, choice)) {
    response.status(409).json({ error: "No active vote, vote already used, or vote window closed." });
    return;
  }
  broadcastSnapshot();
  response.json({ ok: true });
});

app.post("/api/sandbox/crisis-vote", (request, response) => {
  const viewerId = typeof request.body?.viewerId === "string" ? request.body.viewerId : "";
  const choice = request.body?.choice;
  if (!/^viewer_[1-5]$/.test(viewerId) || (choice !== "existing" && choice !== "proposed")) {
    response.status(400).json({ error: "Choose a viewer and vote 1 or 2." });
    return;
  }
  if (!engine.castCrisisVote(viewerId, choice)) {
    response.status(409).json({ error: "Your crisis vote could not be counted." });
    return;
  }
  broadcastSnapshot();
  response.json({ ok: true });
});

const sandboxEventTypes: Record<string, EngineEvent["event_type"]> = {
  follow: "channel.follow",
  sub: "channel.subscribe",
  raid: "channel.raid",
  cheer: "channel.cheer",
  "chat-spike": "channel.chat.message"
};

app.post("/api/sandbox/event", (request, response) => {
  const eventName = typeof request.body?.event === "string" ? request.body.event : "";
  const eventType = sandboxEventTypes[eventName];
  if (!eventType) {
    response.status(400).json({ error: "Unsupported sandbox event." });
    return;
  }

  const now = Date.now();
  const count = eventName === "chat-spike" ? 30 : 1;
  const fired = [];
  for (let index = 0; index < count; index += 1) {
    const result = engine.handleEvent({
      event_type: eventType,
      timestamp: now,
      message_id: `sim-${eventName}-${now}-${index}`
    });
    fired.push(...result.fired);
  }

  for (const law of fired) broadcastEffect(law.action.type, true);
  broadcastEffect("sim_event", true);
  broadcastSnapshot();
  response.json({ ok: true, event: eventName, fired: fired.map((law) => law.id) });
});

setInterval(() => {
  const crisisOutcome = engine.resolveCrisisIfExpired();
  if (crisisOutcome) {
    const newLawWon = crisisOutcome.winner_choice === "proposed";
    if (newLawWon) broadcastEffect(crisisOutcome.winner.action.type, true);
    showNotice(newLawWon ? "The new law survives the constitutional crisis." : "The existing law survives the constitutional crisis.");
    broadcastSnapshot();
    return;
  }

  const outcome = voting.closeIfExpired();
  if (!outcome) return;
  if (outcome.status === "passed" && pendingLaw) {
    const result = engine.beginCrisis(pendingLaw.rule, pendingLaw.text, config.crisisSeconds);
    if (result.status === "added") broadcastEffect(result.law.action.type, true);
  }
  pendingLaw = undefined;
  broadcastSnapshot();
  twitchRuntime?.sendChatReply(outcome.status === "passed" ? "The law passed." : "The law did not pass.");
}, 200);

server.listen(config.port, "127.0.0.1", () => {
  console.log(`Constitution Beast sandbox is ready: http://localhost:${config.port}/sandbox.html`);
  console.log(`Overlay browser source: http://localhost:${config.port}/overlay.html`);
  void startTwitchRuntime({ onEvent: handleTwitchEvent, onStatus: (message) => console.log(message) })
    .then((runtime) => { twitchRuntime = runtime; })
    .catch((error: unknown) => console.error("Could not start Twitch EventSub:", error));
});
