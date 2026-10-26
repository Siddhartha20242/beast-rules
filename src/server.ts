import express from "express";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import OBSWebSocket from "obs-websocket-js";
import { config } from "./config.js";
import { createHealthHandler, type HealthSubscription } from "./health.js";
import { RuleEngine, type EngineEvent } from "./engine.js";
import { AutoCompiler, type CompilerPath } from "./compiler/auto.js";
import { OllamaCompiler } from "./compiler/ollama.js";
import { TemplateCompiler } from "./compiler/template.js";
import type { Rule } from "./compiler/types.js";
import { VotingManager, type VoteChoice } from "./voting.js";
import { chatMessageDetails, eventActorName, translateTwitchEvent } from "./twitch/events.js";
import { hasModeratorBadge, parseStreamerCommand, streamerRole, StreamerControlState } from "./twitch/streamer-controls.js";
import { startTwitchRuntime, type TwitchRuntime } from "./twitch/runtime.js";
import { formatDecisionLogLine } from "./twitch/logging.js";
import { createLawBannerPayload, lawBannerForSnapshot, type LawBannerPayload } from "./law-banner.js";
import { createVoteTickerEntry, voteTickerForSnapshot, type VoteTickerChoice, type VoteTickerEntry } from "./vote-ticker.js";
import { ObsSceneSwitcher, type ObsClient } from "./obs/scene-switcher.js";
import { crowdCrisisVoteChoice, crowdVoteChoice } from "./crowd.js";
import { describeRule, displayUsername, lawForDisplay } from "./describe.js";
import { createLawToast, lawToastsForSnapshot, pushLawToast, type LawToast } from "./law-toast.js";
import { loadContractExamples } from "./law-hints.js";
import { refusalForStatus, type RefusalStatus } from "./refusals.js";

const app = express();
const server = createServer(app);
const sockets = new WebSocketServer({ server });
const engine = new RuleEngine();
const templateCompiler = new TemplateCompiler();
const ollamaCompiler = new OllamaCompiler();
const autoCompiler = new AutoCompiler({ template: templateCompiler, ollama: ollamaCompiler });
const voting = new VotingManager({ voteSeconds: config.voteSeconds });
const streamerControls = new StreamerControlState();
const obsClient = new OBSWebSocket();
const obsSwitcher = new ObsSceneSwitcher({
  url: config.obsWsUrl,
  password: config.obsWsPassword,
  scenes: config.obsScenes,
  returnSeconds: config.sceneReturnSeconds,
  client: obsClient as unknown as ObsClient,
  log: (event, detail) => logDecision(`obs_${event}`, { detail })
});
const clients = new Set<WebSocket>();
let pendingLaw: { id: string; text: string; proposerId: string; proposerName: string; rule: Rule; compilerPath: CompilerPath } | undefined;
let lastConflict: ReturnType<RuleEngine["add"]>["conflict"];
let twitchRuntime: TwitchRuntime | undefined;
let twitchConnected = false;
let twitchBroadcasterId: string | null = config.twitchBroadcasterId || null;
let eventSubSubscriptions: HealthSubscription[] = [];
let lawBanner: LawBannerPayload | undefined;
let proposalSequence = 0;
const voteTicker: VoteTickerEntry[] = [];
let lawToasts: LawToast[] = [];
const lawHints = loadContractExamples();
const crowdScheduledFor = new Set<string>();
const crisisProposalMessage = "A constitutional crisis is underway. Wait for it to resolve before proposing another law.";
const logDecision = (decision: string, fields: Record<string, string | number | boolean | undefined> = {}) => {
  console.info(formatDecisionLogLine(decision, fields));
};

app.use(express.json({ limit: "8kb" }));
app.use(express.static(resolve("public")));

function makeSnapshot() {
  const current = voting.current;
  return {
    type: "snapshot",
    paused: streamerControls.paused,
    laws_passed_count: engine.lawHistory.length + engine.activeLaws.length,
    active_laws: engine.activeLaws.map((law) => lawForDisplay(law)),
    beast_parts: Object.fromEntries(engine.activeLaws.map((law) => [law.zone, {
      part_id: law.mutation.part_id,
      color: law.mutation.color,
      law_id: law.id
    }])),
    proposal: current ? {
      ...current,
      text: pendingLaw ? describeRule(pendingLaw.rule) : undefined,
      compiler_path: pendingLaw?.compilerPath,
      proposer_name: pendingLaw ? displayUsername(pendingLaw.proposerName) : undefined,
      yes: current.yes,
      no: current.no,
      total: current.voters
    } : null,
    crisis: engine.currentCrisis ? {
      ...engine.currentCrisis,
      existing: lawForDisplay(engine.currentCrisis.existing),
      proposed: lawForDisplay(engine.currentCrisis.proposed)
    } : null,
    conflict: lastConflict ?? null,
    law_banner: lawBannerForSnapshot(lawBanner),
    vote_ticker: voteTickerForSnapshot(voteTicker),
    law_toasts: lawToastsForSnapshot(lawToasts),
    law_hints: lawHints
  };
}

async function compileLaw(text: string): Promise<{ rule: Rule; path: CompilerPath }> {
  if (config.compiler === "template") return { rule: await templateCompiler.compile(text), path: "parser" };
  return autoCompiler.compileWithPath(text);
}

function compilerLabel(path: CompilerPath): string {
  return path;
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

function triggerLawAction(action: string, sim = false): void {
  if (action.startsWith("obs_scene_")) void obsSwitcher.handleAction(action);
  else broadcastEffect(action, sim);
}

function broadcastSound(cue: string): void {
  broadcastMessage({ type: "sound", cue });
}

function recordVote(username: string, choice: VoteTickerChoice, crisis: boolean, simulated = false): void {
  voteTicker.push(createVoteTickerEntry(username, choice, Date.now(), { crisis, simulated }));
  if (voteTicker.length > 20) voteTicker.splice(0, voteTicker.length - 20);
  broadcastSound("vote_cast");
}

function broadcastMessage(message: Record<string, unknown>): void {
  const wire = JSON.stringify(message);
  for (const socket of clients) if (socket.readyState === socket.OPEN) socket.send(wire);
}

function showRefusal(status: RefusalStatus): void {
  broadcastMessage({ type: "notice", message: refusalForStatus(status), kind: "refusal", duration_ms: 4000 });
}

function showNotice(message: string): void {
  broadcastMessage({ type: "notice", message, kind: "info" });
}

async function handleTwitchChat(userId: string, userName: string, text: string, messageId: string): Promise<void> {
  const command = text.trim();
  if (/^!law$/i.test(command)) {
    logDecision("law_proposal", { user: userName, user_id: userId, status: "missing_law_text", message_id: messageId });
    showRefusal("too_vague");
    return;
  }
  const highlight = command.match(/^!law\s+(\d+)\s*$/i);
  if (highlight) {
    const law = engine.activeLaws.find((item) => item.id === `law-${Number(highlight[1])}`);
    logDecision("law_highlight", { user: userName, user_id: userId, law_number: Number(highlight[1]), found: Boolean(law), message_id: messageId });
    if (law) broadcastMessage({ type: "highlight", lawId: law.id });
    return;
  }
  const proposal = command.match(/^!law\s+(.+)$/i);
  if (proposal) {
    const lawText = proposal[1]!.trim();
    if (!lawText) return;
    if (streamerControls.paused) {
      logDecision("law_proposal", { user: userName, user_id: userId, status: "rejected_paused", compiler_path: "not_run", text: lawText, message_id: messageId });
      showNotice("The beast is paused. New laws are disabled until the broadcaster resumes it.");
      twitchRuntime?.sendChatReply("The beast is paused. New laws are disabled.");
      return;
    }
    if (engine.currentCrisis) {
      logDecision("law_proposal", { user: userName, user_id: userId, status: "rejected_crisis_active", compiler_path: "not_run", text: lawText, message_id: messageId });
      showNotice(crisisProposalMessage);
      twitchRuntime?.sendChatReply(crisisProposalMessage);
      return;
    }
    let rule: Rule;
    let compilerPath: CompilerPath;
    try {
      ({ rule, path: compilerPath } = await compileLaw(lawText));
    } catch {
      logDecision("law_proposal", { user: userName, user_id: userId, status: "compile_error", compiler_path: "unknown", text: lawText, message_id: messageId });
      showRefusal("too_vague");
      return;
    }
    logDecision("law_proposal", { user: userName, user_id: userId, status: rule.status, compiler_path: compilerPath, text: lawText, message_id: messageId });
    if (rule.status !== "ok") {
      showRefusal(rule.status);
      twitchRuntime?.sendChatReply(refusalForStatus(rule.status));
      return;
    }
    const proposalId = `twitch-proposal-${Date.now()}-${++proposalSequence}`;
    if (engine.currentCrisis) {
      logDecision("law_proposal", { user: userName, user_id: userId, status: "rejected_crisis_started_during_compile", compiler_path: compilerPath, text: lawText, message_id: messageId });
      showNotice(crisisProposalMessage);
      twitchRuntime?.sendChatReply(crisisProposalMessage);
      return;
    }
    if (!voting.startProposal(proposalId, userId)) {
      logDecision("law_proposal", { user: userName, user_id: userId, status: "vote_already_active_or_cooldown", compiler_path: compilerPath, text: lawText, message_id: messageId });
      const message = "A vote is active or this viewer is on proposal cooldown.";
      showNotice(message);
      twitchRuntime?.sendChatReply(message);
      return;
    }
    pendingLaw = { id: proposalId, text: lawText, proposerId: userId, proposerName: userName, rule, compilerPath };
    logDecision("law_proposed", { user: userName, user_id: userId, proposal_id: proposalId, compiler_path: compilerPath, status: rule.status, text: lawText });
    lastConflict = undefined;
    broadcastSound("vote_open");
    broadcastSnapshot();
    twitchRuntime?.sendChatReply("Law proposed. Vote yes or no in chat.");
    return;
  }
  if (engine.currentCrisis && /^(1|2)$/.test(command)) {
    const counted = engine.castCrisisVote(userId, command === "1" ? "existing" : "proposed");
    logDecision("vote_cast", { kind: "crisis", user: userName, user_id: userId, choice: command, counted, message_id: messageId });
    if (counted) {
      recordVote(userName, command as "1" | "2", true);
      broadcastSnapshot();
    }
    return;
  }
  const choice: VoteChoice | undefined = /^(1|yes)$/i.test(command) ? "yes" : /^(2|no)$/i.test(command) ? "no" : undefined;
  if (choice) {
    const counted = voting.current ? voting.castVote(userId, choice) : false;
    logDecision("vote_cast", { kind: "proposal", user: userName, user_id: userId, choice, counted, message_id: messageId });
    if (counted) {
      recordVote(userName, choice, false);
      broadcastSnapshot();
      twitchRuntime?.sendChatReply("Vote counted.");
    }
  }
}

function handleTwitchEvent(name: Parameters<typeof translateTwitchEvent>[0], payload: unknown): void {
  const internal = translateTwitchEvent(name, payload);
  let chatDetails: ReturnType<typeof chatMessageDetails> | undefined;
  if (name === "chat") {
    chatDetails = chatMessageDetails(payload);
    const control = parseStreamerCommand(chatDetails.message);
    if (control) {
      const role = streamerRole(chatDetails.userId, twitchBroadcasterId ?? "", hasModeratorBadge(payload));
      handleStreamerCommand(control, chatDetails.userId, chatDetails.userName, role);
      return;
    }
  }
  const actorName = eventActorName(name, payload);
  const result = streamerControls.paused
    ? { ignored: false, fired: [] as ReturnType<RuleEngine["handleEvent"]>["fired"] }
    : engine.handleEvent(internal);
  if (result.ignored) return;
  for (const law of result.fired) {
    triggerLawAction(law.action.type);
    lawToasts = pushLawToast(lawToasts, createLawToast(law, actorName, false));
  }
  if (name === "chat" && chatDetails) {
    const { userId, userName, message, messageId } = chatDetails;
    if (/^!law\b|^(?:1|2|yes|no)$/i.test(message.trim())) {
      logDecision("chat_command_received", { user: userName, user_id: userId, message });
    }
    void handleTwitchChat(userId, userName, message, messageId);
  }
  broadcastSnapshot();
}

function handleStreamerCommand(command: NonNullable<ReturnType<typeof parseStreamerCommand>>, userId: string, userName: string, role: "broadcaster" | "moderator" | "viewer"): void {
  const authorized = role === "broadcaster" || role === "moderator";
  const logCommand = (status: string) => logDecision("streamer_command", { command, user: userName, user_id: userId, role, authorized, status });
  if (!authorized) {
    logCommand("denied");
    showNotice("Only the broadcaster or a moderator can use streamer controls.");
    return;
  }
  if (command === "pause" || command === "resume") {
    const paused = command === "pause";
    const changed = streamerControls.setPaused(paused);
    logCommand(changed ? "applied" : "already_set");
    showNotice(paused ? "The beast is paused." : "The beast has resumed.");
    broadcastSnapshot();
    return;
  }
  if (command === "reset") {
    streamerControls.requestReset(userId);
    logCommand("confirmation_requested");
    showNotice("Type !beast reset confirm within 15 seconds to clear all laws.");
    return;
  }
  if (command === "reset_confirm") {
    if (!streamerControls.confirmReset(userId)) {
      logCommand("confirmation_rejected");
      showNotice("Reset confirmation expired or belongs to another user.");
      return;
    }
    engine.clearAllLaws();
    voting.cancelCurrent();
    crowdScheduledFor.clear();
    pendingLaw = undefined;
    lastConflict = undefined;
    lawBanner = undefined;
    logCommand("reset_applied");
    showNotice("All beast laws have been reset.");
    broadcastSnapshot();
    return;
  }
  const proposal = voting.cancelCurrent();
  const currentCrisis = engine.currentCrisis;
  const crisis = engine.cancelCrisis();
  if (proposal) crowdScheduledFor.delete(proposal.proposalId);
  if (currentCrisis) crowdScheduledFor.delete(`crisis:${currentCrisis.proposed.id}`);
  const canceled = Boolean(proposal || crisis);
  if (canceled) pendingLaw = undefined;
  logCommand(canceled ? "vote_or_crisis_canceled" : "nothing_to_cancel");
  showNotice(canceled ? "The active vote or crisis was canceled." : "There is no active vote or crisis.");
  broadcastSnapshot();
}

sockets.on("connection", (socket) => {
  clients.add(socket);
  sendSnapshot(socket);
  socket.on("close", () => clients.delete(socket));
});

app.get("/", (_request, response) => response.sendFile(resolve("public/sandbox.html")));
app.get("/api/state", (_request, response) => response.json(makeSnapshot()));
app.get("/health", createHealthHandler(() => ({
  twitchConnected,
  broadcasterId: twitchBroadcasterId,
  subscriptions: eventSubSubscriptions,
  compilerMode: config.compiler,
  activeLaws: engine.activeLaws.length,
  obsConnected: obsSwitcher.isConnected
}), config.ollamaUrl));

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
  if (streamerControls.paused) {
    response.status(409).json({ error: "The beast is paused. New laws are disabled until it resumes." });
    return;
  }

  try {
    const { rule, path: compilerPath } = await compileLaw(text);
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
    pendingLaw = { id: proposalId, text, proposerId, proposerName: proposerId, rule, compilerPath };
    lastConflict = undefined;
    broadcastSound("vote_open");
    broadcastSnapshot();
    response.json({ ok: true, proposalId });
  } catch {
    response.status(500).json({ error: "Could not compile proposal." });
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
  recordVote(viewerId, choice, false);
  broadcastSnapshot();
  response.json({ ok: true });
});

app.post("/api/sandbox/crowd", (request, response) => {
  const rawBias = request.body?.yesBias;
  const yesBias = typeof rawBias === "number" && Number.isFinite(rawBias) ? Math.min(100, Math.max(0, rawBias)) : 80;
  const crisis = engine.currentCrisis;
  const proposal = voting.current;
  if (!proposal && !crisis) {
    response.status(409).json({ error: "Start a proposal vote before simulating the crowd." });
    return;
  }
  const voteKey = crisis ? `crisis:${crisis.proposed.id}` : proposal!.proposalId;
  if (crowdScheduledFor.has(voteKey)) {
    response.status(409).json({ error: "The simulated crowd is already voting on this proposal." });
    return;
  }
  crowdScheduledFor.add(voteKey);
  const remainingMs = Math.max(1, crisis ? crisis.ends_at - Date.now() : proposal!.endsAt - Date.now());
  const safeWindowMs = Math.max(0, remainingMs - 350);
  for (let index = 1; index <= 8; index += 1) {
    const username = `sim_viewer_${index}`;
    const delay = Math.floor(Math.random() * safeWindowMs);
    setTimeout(() => {
      if (crisis) {
        if (engine.currentCrisis?.proposed.id !== crisis.proposed.id) return;
        const choice = crowdCrisisVoteChoice(yesBias);
        if (!engine.castCrisisVote(username, choice)) return;
        recordVote(username, choice === "existing" ? "1" : "2", true, true);
      } else {
        if (voting.current?.proposalId !== proposal!.proposalId) return;
        const choice: VoteChoice = crowdVoteChoice(yesBias);
        if (!voting.castVote(username, choice)) return;
        recordVote(username, choice, false, true);
      }
      broadcastSnapshot();
    }, delay);
  }
  response.json({ ok: true, message: `Eight SIM viewers will vote at random times before this ${crisis ? "crisis" : "vote"} closes (${yesBias}% yes bias).` });
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
  recordVote(viewerId, choice === "existing" ? "1" : "2", true);
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
    const result = streamerControls.paused ? { fired: [] as ReturnType<RuleEngine["handleEvent"]>["fired"] } : engine.handleEvent({
      event_type: eventType,
      timestamp: now,
      message_id: `sim-${eventName}-${now}-${index}`
    });
    fired.push(...result.fired);
  }

  for (const law of fired) {
    triggerLawAction(law.action.type, true);
    lawToasts = pushLawToast(lawToasts, createLawToast(law, undefined, true));
  }
  broadcastEffect("sim_event", true);
  broadcastSnapshot();
  response.json({ ok: true, event: eventName, fired: fired.map((law) => law.id) });
});

app.post("/api/sandbox/effect", (request, response) => {
  const allowedEffects = new Set(["screen_shake", "screen_flash", "confetti", "beast_roar"]);
  const effect = typeof request.body?.effect === "string" ? request.body.effect : "";
  if (!allowedEffects.has(effect)) {
    response.status(400).json({ error: "Unsupported sandbox effect." });
    return;
  }
  broadcastEffect(effect, true);
  response.json({ ok: true, effect });
});

setInterval(() => {
  const crisisOutcome = engine.resolveCrisisIfExpired();
  if (crisisOutcome) {
    crowdScheduledFor.delete(`crisis:${crisisOutcome.winner_choice === "proposed" ? crisisOutcome.winner.id : crisisOutcome.loser.id}`);
    broadcastSound("crisis_resolved");
    const newLawWon = crisisOutcome.winner_choice === "proposed";
    lawBanner = createLawBannerPayload("crisis_resolved", crisisOutcome.winner, {
      headline: newLawWon ? "NEW LAW SURVIVES" : "EXISTING LAW SURVIVES",
      relatedLaw: crisisOutcome.loser,
      relatedLawRelation: "overruled"
    });
    logDecision("crisis_ended", {
      zone: crisisOutcome.winner.zone,
      winner_id: crisisOutcome.winner.id,
      loser_id: crisisOutcome.loser.id,
      winner_choice: crisisOutcome.winner_choice,
      existing_votes: crisisOutcome.existing_votes,
      proposed_votes: crisisOutcome.proposed_votes
    });
    if (newLawWon) logDecision("law_enacted", { id: crisisOutcome.winner.id, zone: crisisOutcome.winner.zone, part: crisisOutcome.winner.mutation.part_id });
    if (newLawWon) triggerLawAction(crisisOutcome.winner.action.type, true);
    showNotice(newLawWon ? "The new law survives the constitutional crisis." : "The existing law survives the constitutional crisis.");
    broadcastSnapshot();
    return;
  }

  const outcome = voting.closeIfExpired();
  if (!outcome) return;
  crowdScheduledFor.delete(outcome.proposalId);
  if (outcome.status === "passed") broadcastSound("law_passed");
  logDecision("vote_result", { proposal_id: outcome.proposalId, status: outcome.status, yes: outcome.yes, no: outcome.no, total: outcome.total });
  if (outcome.status === "passed" && pendingLaw) {
    const result = engine.beginCrisis(pendingLaw.rule, pendingLaw.text, config.crisisSeconds, pendingLaw.compilerPath, pendingLaw.proposerName);
    if (result.status === "added") {
      lawBanner = createLawBannerPayload("passed", result.law);
      console.info(`Compiler ${compilerLabel(pendingLaw.compilerPath)} handled ${result.law.id}`);
      logDecision("law_enacted", { id: result.law.id, zone: result.law.zone, part: result.law.mutation.part_id });
      triggerLawAction(result.law.action.type, true);
    } else if (result.status === "started") {
      broadcastSound("vote_open");
      broadcastSound("crisis_start");
      lawBanner = createLawBannerPayload("passed", result.crisis.proposed, {
        headline: "LAW PASSED · CRISIS VOTE",
        relatedLaw: result.crisis.existing,
        relatedLawRelation: "challenged"
      });
      console.info(`Compiler ${compilerLabel(pendingLaw.compilerPath)} handled ${result.crisis.proposed.id}`);
      logDecision("crisis_started", {
        zone: result.crisis.zone,
        existing_id: result.crisis.existing.id,
        proposed_id: result.crisis.proposed.id,
        existing_text: result.crisis.existing.raw_text,
        proposed_text: result.crisis.proposed.raw_text
      });
    }
  }
  pendingLaw = undefined;
  broadcastSnapshot();
  twitchRuntime?.sendChatReply(outcome.status === "passed" ? "The law passed." : "The law did not pass.");
}, 200);

server.listen(config.port, "127.0.0.1", () => {
  console.log(`Beast Rules sandbox is ready: http://localhost:${config.port}/sandbox.html`);
  console.log(`Beast Rules overlay browser source: http://localhost:${config.port}/overlay.html`);
  void obsSwitcher.start();
  void startTwitchRuntime({
    onEvent: handleTwitchEvent,
    onStatus: (message) => console.log(message),
    onConnectionChange: (connected, id) => { twitchConnected = connected; twitchBroadcasterId = id; },
    onSubscriptionsChange: (subscriptions) => { eventSubSubscriptions = subscriptions; }
  })
    .then((runtime) => {
      twitchRuntime = runtime;
      if (runtime) {
        twitchBroadcasterId = runtime.broadcasterId;
        twitchConnected = runtime.isConnected;
        eventSubSubscriptions = runtime.getSubscriptions();
      }
    })
    .catch(() => console.error("Could not start Twitch EventSub. Check credentials, token scopes, and broadcaster configuration."));
});
