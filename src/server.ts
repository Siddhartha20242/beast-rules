import express from "express";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
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
import { installProcessGuards, type ConnectionStatus } from "./twitch/resilience.js";
import { formatDecisionLogLine } from "./twitch/logging.js";
import { createLawBannerPayload, lawBannerForSnapshot, type LawBannerPayload } from "./law-banner.js";
import { createVoteTickerEntry, voteTickerForSnapshot, type VoteTickerChoice, type VoteTickerEntry } from "./vote-ticker.js";
import { ObsSceneSwitcher, type ObsClient } from "./obs/scene-switcher.js";
import { crowdCrisisVoteChoice, crowdVoteChoice } from "./crowd.js";
import { describeRule, displayUsername, lawForDisplay } from "./describe.js";
import { createLawToast, lawToastsForSnapshot, pushLawToast, type LawToast } from "./law-toast.js";
import { loadContractExamples } from "./law-hints.js";
import { refusalForStatus, type RefusalStatus } from "./refusals.js";
import { parseChatCommand } from "./chat-commands.js";
import { BeastProfile, NameVote, beastNameOptions, nameVoteForSnapshot, type NameVoteOutcome } from "./beast-profile.js";
import { computeTemperament } from "./temperament.js";
import { computeDesire, satisfiesDesire } from "./desire.js";
import { buildConstitution, constitutionPanel, scarsByZone, type InfoPanel } from "./constitution.js";
import { beastTongue } from "./refusals.js";
import { BallotManager, ballotForSnapshot, shouldOpenBallot, suggestLaws, type BallotOutcome } from "./ballot.js";
import type { EventType } from "./compiler/types.js";

const app = express();
const server = createServer(app);
const sockets = new WebSocketServer({ server });
const engine = new RuleEngine({ filePath: join(config.dataDir, "beast.json") });
const templateCompiler = new TemplateCompiler();
const ollamaCompiler = new OllamaCompiler();
const autoCompiler = new AutoCompiler({ template: templateCompiler, ollama: ollamaCompiler });
const voting = new VotingManager({ voteSeconds: config.voteSeconds });
const streamerControls = new StreamerControlState(resolve(config.dataDir, "streamer-controls.json"));
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
let twitchStatus: ConnectionStatus = { connected: false, reconnecting: false, lastDisconnectAt: null, reconnectAttempts: 0 };
const twitchConfigured = Boolean(config.twitchClientId && config.twitchClientSecret);
let twitchBroadcasterId: string | null = config.twitchBroadcasterId || null;
let eventSubSubscriptions: HealthSubscription[] = [];
let lawBanner: LawBannerPayload | undefined;
let proposalSequence = 0;
const voteTicker: VoteTickerEntry[] = [];
let lawToasts: LawToast[] = [];
const lawHints = loadContractExamples();
const crowdScheduledFor = new Set<string>();
const ballot = new BallotManager({ ballotSeconds: config.ballotSeconds });
const profile = new BeastProfile({ filePath: join(config.dataDir, "beast-profile.json") });
const nameVote = new NameVote({ seconds: config.ballotSeconds });
let nameSequence = 0;
let infoPanel: (InfoPanel & { until: number }) | undefined;
let nextBallotAt = config.ballotMinutes > 0 ? Date.now() + config.ballotMinutes * 60_000 : Number.POSITIVE_INFINITY;
let ballotSequence = 0;
let ballotOpening = false;
let pendingRepeal: { proposalId: string; lawId: string; proposerName: string } | undefined;
let lawsPanelUntil = 0;
const recentEventTypes: EventType[] = [];
const ballotBusyMessage = "A ballot is open. Vote 1, 2 or 3.";
const crisisProposalMessage = "A constitutional crisis is underway. Wait for it to resolve before proposing another law.";
const logDecision = (decision: string, fields: Record<string, string | number | boolean | undefined> = {}) => {
  console.info(formatDecisionLogLine(decision, fields));
};

app.use(express.json({ limit: "8kb" }));
// Malformed or oversized request bodies get a short JSON error, never a stack trace.
app.use((error: unknown, _request: express.Request, response: express.Response, next: express.NextFunction) => {
  if (response.headersSent) { next(error); return; }
  const status = typeof (error as { status?: unknown })?.status === "number" ? (error as { status: number }).status : 400;
  response.status(status >= 400 && status < 500 ? status : 400).json({ error: "Invalid request." });
});
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
      text: pendingRepeal ? repealPrompt(pendingRepeal.lawId) : pendingLaw ? describeRule(pendingLaw.rule) : undefined,
      compiler_path: pendingRepeal ? "repeal" : pendingLaw?.compilerPath,
      proposer_name: pendingRepeal ? displayUsername(pendingRepeal.proposerName) : pendingLaw ? displayUsername(pendingLaw.proposerName) : undefined,
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
    law_hints: lawHints,
    ballot: ballotForSnapshot(ballot.current) ?? nameVoteForSnapshot(nameVote.current),
    beast_name: profile.name,
    temperament: computeTemperament(engine.activeLaws, engine.lawHistory.length),
    desire: currentDesire(),
    scars: scarsByZone(engine.lawHistory),
    info_panel: infoPanel && infoPanel.until > Date.now() ? { title: infoPanel.title, rows: infoPanel.rows, until: infoPanel.until } : null,
    laws_panel_until: lawsPanelUntil > Date.now() ? lawsPanelUntil : 0
  };
}

// Canonical text only: a repeal vote shows the law's description, never a viewer's words.
function repealPrompt(lawId: string): string {
  const law = engine.activeLaws.find((item) => item.id === lawId);
  return law ? `Repeal ${lawId}? ${describeRule({ status: law.status, trigger: law.trigger, action: law.action, mutation: law.mutation })}` : `Repeal ${lawId}?`;
}

async function compileLaw(text: string): Promise<{ rule: Rule; path: CompilerPath }> {
  if (config.compiler === "template") return { rule: await templateCompiler.compile(text), path: "parser" };
  return autoCompiler.compileWithPath(text);
}

function compilerLabel(path: CompilerPath): string {
  return path;
}

// While a crisis is about to resolve, the overlay is held on its last picture for a moment of silence.
const hushMs = 1500;
let lastSnapshotJson = "";
let holdSnapshotUntil = 0;

function snapshotWire(): string {
  if (Date.now() < holdSnapshotUntil && lastSnapshotJson) return lastSnapshotJson;
  lastSnapshotJson = JSON.stringify(makeSnapshot());
  return lastSnapshotJson;
}

function sendSnapshot(socket: WebSocket): void {
  if (socket.readyState === socket.OPEN) socket.send(snapshotWire());
}

function broadcastSnapshot(): void {
  const message = snapshotWire();
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

// Enact a law that passed a vote or won a ballot. A law that wants an occupied zone starts a crisis vote instead.
function enactLaw(pending: { rule: Rule; text: string; compilerPath: CompilerPath; proposerName: string; voteSummary?: string }): void {
  const desireBefore = currentDesire();
  const result = engine.beginCrisis(pending.rule, pending.text, config.crisisSeconds, pending.compilerPath, pending.proposerName);
  if (result.status === "added") {
    lawBanner = createLawBannerPayload("passed", result.law, pending.voteSummary ? { voteSummary: pending.voteSummary } : {});
    if (satisfiesDesire(desireBefore, result.law.trigger.event_type)) showNotice(`${profile.name ?? "The beast"} is pleased.`);
    console.info(`Compiler ${compilerLabel(pending.compilerPath)} handled ${result.law.id}`);
    logDecision("law_enacted", { id: result.law.id, zone: result.law.zone, part: result.law.mutation.part_id });
    triggerLawAction(result.law.action.type, true);
  } else if (result.status === "started") {
    broadcastSound("vote_open");
    broadcastSound("crisis_start");
    lawBanner = createLawBannerPayload("passed", result.crisis.proposed, {
      headline: "LAW PASSED · CRISIS VOTE",
      ...(pending.voteSummary ? { voteSummary: pending.voteSummary } : {}),
      relatedLaw: result.crisis.existing,
      relatedLawRelation: "challenged"
    });
    console.info(`Compiler ${compilerLabel(pending.compilerPath)} handled ${result.crisis.proposed.id}`);
    logDecision("crisis_started", {
      zone: result.crisis.zone,
      existing_id: result.crisis.existing.id,
      proposed_id: result.crisis.proposed.id,
      existing_text: result.crisis.existing.raw_text,
      proposed_text: result.crisis.proposed.raw_text
    });
  }
}

function scheduleNextBallot(): void {
  nextBallotAt = config.ballotMinutes > 0 ? Date.now() + config.ballotMinutes * 60_000 : Number.POSITIVE_INFINITY;
}

type StartResult = { ok: true } | { ok: false; message: string };

async function openBallot(): Promise<StartResult> {
  if (ballotOpening || anyBallotOpen()) return { ok: false, message: ballotBusyMessage };
  if (streamerControls.paused) return { ok: false, message: "The beast is paused. Ballots are disabled until the broadcaster resumes it." };
  if (engine.currentCrisis) return { ok: false, message: crisisProposalMessage };
  if (voting.current) return { ok: false, message: "A vote is already active." };
  ballotOpening = true;
  try {
    const options = await suggestLaws({
      activeParts: engine.activeLaws.map((law) => law.mutation.part_id),
      recentEvents: recentEventTypes,
      seed: ++ballotSequence,
      compiler: templateCompiler
    });
    // Things can change while suggestions compile.
    if (streamerControls.paused || engine.currentCrisis || voting.current) return { ok: false, message: "Something else started first; the ballot was skipped." };
    if (!ballot.open(options)) return { ok: false, message: "Could not build enough suggestions for a ballot." };
    pendingLaw = undefined;
    pendingRepeal = undefined;
    broadcastSound("vote_open");
    logDecision("ballot_opened", { ballot_id: ballot.current?.ballotId, options: options.length });
    broadcastSnapshot();
    return { ok: true };
  } finally {
    ballotOpening = false;
    scheduleNextBallot();
  }
}

function handleBallotOutcome(outcome: BallotOutcome): void {
  crowdScheduledFor.delete(`ballot:${outcome.ballotId}`);
  logDecision("ballot_result", { ballot_id: outcome.ballotId, winner: outcome.winner?.number ?? 0, votes: outcome.votes.join("/"), total: outcome.total });
  if (outcome.winner) {
    broadcastSound("law_passed");
    const winnerVotes = outcome.votes[outcome.winner.number - 1] ?? 0;
    enactLaw({ rule: outcome.winner.rule, text: outcome.winner.text, compilerPath: "parser", proposerName: "Ballot", voteSummary: `won the ballot ${winnerVotes} of ${outcome.total} votes` });
  } else {
    showNotice("The ballot closed with no votes.");
  }
  scheduleNextBallot();
  broadcastSnapshot();
}

function startRepeal(proposerId: string, proposerName: string, lawNumber: number): StartResult {
  if (streamerControls.paused) return { ok: false, message: "The beast is paused. Repeals are disabled until the broadcaster resumes it." };
  if (engine.currentCrisis) return { ok: false, message: crisisProposalMessage };
  if (anyBallotOpen()) return { ok: false, message: ballotBusyMessage };
  const law = engine.activeLaws.find((item) => item.id === `law-${lawNumber}`);
  if (!law) return { ok: false, message: `There is no active law-${lawNumber}.` };
  const proposalId = `repeal-${Date.now()}-${++proposalSequence}`;
  if (!voting.startProposal(proposalId, proposerId)) return { ok: false, message: "A vote is active or this viewer is on proposal cooldown." };
  pendingLaw = undefined;
  pendingRepeal = { proposalId, lawId: law.id, proposerName };
  lastConflict = undefined;
  logDecision("repeal_proposed", { user: proposerName, user_id: proposerId, law_id: law.id, proposal_id: proposalId });
  broadcastSound("vote_open");
  broadcastSnapshot();
  return { ok: true };
}

function anyBallotOpen(): boolean {
  return ballot.isOpen || nameVote.isOpen;
}

function openChoiceVote(): { kind: "law" | "name"; vote: (userId: string, number: number) => boolean } | undefined {
  if (ballot.isOpen) return { kind: "law", vote: (userId, number) => ballot.vote(userId, number) };
  if (nameVote.isOpen) return { kind: "name", vote: (userId, number) => nameVote.vote(userId, number) };
  return undefined;
}

function currentDesire() {
  return computeDesire(engine.activeLaws.map((law) => law.trigger.event_type), computeTemperament(engine.activeLaws, engine.lawHistory.length).mood, profile.name);
}

function constitutionDocument() {
  return buildConstitution({ beastName: profile.name, active: engine.activeLaws, history: engine.lawHistory, temperamentLabel: computeTemperament(engine.activeLaws, engine.lawHistory.length).label });
}

function showInfoPanel(panel: InfoPanel, seconds: number): void {
  infoPanel = { ...panel, until: Date.now() + seconds * 1000 };
  broadcastSnapshot();
}

function startNameVote(): StartResult {
  if (profile.name) return { ok: false, message: `The beast already has a name: ${profile.name}.` };
  if (streamerControls.paused) return { ok: false, message: "The beast is paused. Naming is disabled until the broadcaster resumes it." };
  if (engine.currentCrisis) return { ok: false, message: crisisProposalMessage };
  if (voting.current) return { ok: false, message: "A vote is already active." };
  if (anyBallotOpen()) return { ok: false, message: ballotBusyMessage };
  const names = beastNameOptions(++nameSequence);
  if (!nameVote.open(names)) return { ok: false, message: "Could not start a naming vote." };
  pendingLaw = undefined;
  pendingRepeal = undefined;
  broadcastSound("vote_open");
  logDecision("name_vote_opened", { vote_id: nameVote.current?.voteId, names: names.join("/") });
  broadcastSnapshot();
  return { ok: true };
}

function handleNameOutcome(outcome: NameVoteOutcome): void {
  logDecision("name_vote_result", { vote_id: outcome.voteId, winner: outcome.winner ?? "none", votes: outcome.votes.join("/"), total: outcome.total });
  if (outcome.winner && profile.setName(outcome.winner)) {
    broadcastSound("law_passed");
    showNotice(`The beast is named ${outcome.winner}.`);
  } else {
    showNotice("The naming vote closed with no votes.");
  }
  broadcastSnapshot();
}

function noteEventType(eventType: EventType): void {
  recentEventTypes.push(eventType);
  if (recentEventTypes.length > 12) recentEventTypes.splice(0, recentEventTypes.length - 12);
}

async function handleTwitchChat(userId: string, userName: string, text: string, messageId: string): Promise<void> {
  const command = text.trim();
  const parsed = parseChatCommand(command);
  if (parsed.kind === "constitution") {
    logDecision("constitution_panel", { user: userName, user_id: userId, message_id: messageId });
    showInfoPanel(constitutionPanel(constitutionDocument()), 9);
    return;
  }
  if (parsed.kind === "tongue") {
    logDecision("tongue_panel", { user: userName, user_id: userId, message_id: messageId });
    showInfoPanel({ title: "THE BEAST'S TONGUE", rows: beastTongue }, 9);
    return;
  }
  if (parsed.kind === "name_beast") {
    const started = startNameVote();
    logDecision("name_request", { user: userName, user_id: userId, started: started.ok, message_id: messageId });
    if (!started.ok) showNotice(started.message);
    return;
  }
  if (parsed.kind === "laws") {
    lawsPanelUntil = Date.now() + 6000;
    logDecision("laws_panel", { user: userName, user_id: userId, message_id: messageId });
    broadcastSnapshot();
    return;
  }
  if (parsed.kind === "repeal") {
    const started = startRepeal(userId, userName, parsed.lawNumber);
    logDecision("repeal_request", { user: userName, user_id: userId, law_number: parsed.lawNumber, started: started.ok, message_id: messageId });
    if (!started.ok) {
      showNotice(started.message);
      twitchRuntime?.sendChatReply(started.message);
    }
    return;
  }
  if (parsed.kind === "law_missing") {
    logDecision("law_proposal", { user: userName, user_id: userId, status: "missing_law_text", message_id: messageId });
    showRefusal("too_vague");
    return;
  }
  if (parsed.kind === "law_highlight") {
    const law = engine.activeLaws.find((item) => item.id === `law-${parsed.lawNumber}`);
    logDecision("law_highlight", { user: userName, user_id: userId, law_number: parsed.lawNumber, found: Boolean(law), message_id: messageId });
    if (law) broadcastMessage({ type: "highlight", lawId: law.id });
    return;
  }
  if (parsed.kind === "law_propose") {
    const lawText = parsed.text;
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
    if (anyBallotOpen()) {
      logDecision("law_proposal", { user: userName, user_id: userId, status: "rejected_ballot_open", compiler_path: "not_run", text: lawText, message_id: messageId });
      showNotice(ballotBusyMessage);
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
    if (anyBallotOpen()) {
      logDecision("law_proposal", { user: userName, user_id: userId, status: "rejected_ballot_opened_during_compile", compiler_path: compilerPath, text: lawText, message_id: messageId });
      showNotice(ballotBusyMessage);
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
    pendingRepeal = undefined;
    logDecision("law_proposed", { user: userName, user_id: userId, proposal_id: proposalId, compiler_path: compilerPath, status: rule.status, text: lawText });
    lastConflict = undefined;
    broadcastSound("vote_open");
    broadcastSnapshot();
    twitchRuntime?.sendChatReply("Law proposed. Vote yes or no in chat.");
    return;
  }
  const voteToken = parsed.kind === "vote_token" ? parsed.token : undefined;
  if (engine.currentCrisis && (voteToken === "1" || voteToken === "2")) {
    const counted = engine.castCrisisVote(userId, command === "1" ? "existing" : "proposed");
    logDecision("vote_cast", { kind: "crisis", user: userName, user_id: userId, choice: command, counted, message_id: messageId });
    if (counted) {
      recordVote(userName, command as "1" | "2", true);
      broadcastSnapshot();
    }
    return;
  }
  const openChoice = openChoiceVote();
  if (openChoice && (voteToken === "1" || voteToken === "2" || voteToken === "3")) {
    const counted = openChoice.vote(userId, Number(command));
    logDecision("vote_cast", { kind: openChoice.kind === "name" ? "name" : "ballot", user: userName, user_id: userId, choice: command, counted, message_id: messageId });
    if (counted) {
      recordVote(userName, command as "1" | "2" | "3", false);
      broadcastSnapshot();
    }
    return;
  }
  const choice: VoteChoice | undefined = voteToken === "1" || voteToken === "yes" ? "yes" : voteToken === "2" || voteToken === "no" ? "no" : undefined;
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
  if (!streamerControls.paused && name !== "chat") noteEventType(internal.event_type);
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
    if (/^!(?:law|laws|repeal|constitution|tongue|name)\b|^(?:1|2|3|yes|no)$/i.test(message.trim())) {
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
    ballot.cancel();
    nameVote.cancel();
    profile.clear();
    crowdScheduledFor.clear();
    pendingLaw = undefined;
    pendingRepeal = undefined;
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
  const openBallotId = ballot.current?.ballotId;
  const ballotCanceled = ballot.cancel() || nameVote.cancel();
  if (proposal) crowdScheduledFor.delete(proposal.proposalId);
  if (currentCrisis) crowdScheduledFor.delete(`crisis:${currentCrisis.proposed.id}`);
  if (openBallotId) crowdScheduledFor.delete(`ballot:${openBallotId}`);
  const canceled = Boolean(proposal || crisis || ballotCanceled);
  if (canceled) { pendingLaw = undefined; pendingRepeal = undefined; }
  if (ballotCanceled) scheduleNextBallot();
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
app.get("/api/constitution", (_request, response) => response.json(constitutionDocument()));
app.get("/api/twitch-status", (_request, response) => {
  response.json({ configured: twitchConfigured && (twitchRuntime !== undefined || twitchStatus.reconnecting), connected: twitchConnected, reconnecting: twitchStatus.reconnecting, reconnectAttempts: twitchStatus.reconnectAttempts });
});
app.get("/health", createHealthHandler(() => ({
  twitchConnected,
  twitchReconnecting: twitchStatus.reconnecting,
  lastDisconnectAt: twitchStatus.lastDisconnectAt,
  reconnectAttempts: twitchStatus.reconnectAttempts,
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
  if (anyBallotOpen()) {
    response.status(409).json({ error: ballotBusyMessage });
    return;
  }

  try {
    const { rule, path: compilerPath } = await compileLaw(text);
    if (rule.status !== "ok") {
      showRefusal(rule.status);
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
    pendingRepeal = undefined;
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
  const openBallotSnapshot = ballot.current;
  const openNameVote = nameVote.current;
  if (openNameVote && !openBallotSnapshot && !crisis && !proposal) {
    const nameKey = `name:${openNameVote.voteId}`;
    if (crowdScheduledFor.has(nameKey)) {
      response.status(409).json({ error: "The simulated crowd is already voting on this naming vote." });
      return;
    }
    crowdScheduledFor.add(nameKey);
    const windowMs = Math.max(0, openNameVote.endsAt - Date.now() - 350);
    for (let index = 1; index <= 8; index += 1) {
      const username = `sim_viewer_${index}`;
      const pick = 1 + Math.floor(Math.random() * openNameVote.names.length);
      setTimeout(() => {
        if (nameVote.current?.voteId !== openNameVote.voteId) return;
        if (!nameVote.vote(username, pick)) return;
        recordVote(username, String(pick) as "1" | "2" | "3", false, true);
        broadcastSnapshot();
      }, Math.floor(Math.random() * windowMs));
    }
    response.json({ ok: true, message: "Eight SIM viewers will vote on the name at random times before it closes." });
    return;
  }
  if (openBallotSnapshot && !crisis && !proposal) {
    const ballotKey = `ballot:${openBallotSnapshot.ballotId}`;
    if (crowdScheduledFor.has(ballotKey)) {
      response.status(409).json({ error: "The simulated crowd is already voting on this ballot." });
      return;
    }
    crowdScheduledFor.add(ballotKey);
    const windowMs = Math.max(0, openBallotSnapshot.endsAt - Date.now() - 350);
    const numbers = openBallotSnapshot.options.map((option) => option.number);
    for (let index = 1; index <= 8; index += 1) {
      const username = `sim_viewer_${index}`;
      const pick = numbers[Math.floor(Math.random() * numbers.length)]!;
      setTimeout(() => {
        if (ballot.current?.ballotId !== openBallotSnapshot.ballotId) return;
        if (!ballot.vote(username, pick)) return;
        recordVote(username, String(pick) as "1" | "2" | "3", false, true);
        broadcastSnapshot();
      }, Math.floor(Math.random() * windowMs));
    }
    response.json({ ok: true, message: "Eight SIM viewers will vote on the ballot at random times before it closes." });
    return;
  }
  if (!proposal && !crisis) {
    response.status(409).json({ error: "Start a proposal vote or a ballot before simulating the crowd." });
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

  if (!streamerControls.paused && eventName !== "chat-spike") noteEventType(eventType);
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

app.post("/api/sandbox/ballot/open", async (_request, response) => {
  const result = await openBallot();
  if (!result.ok) {
    response.status(409).json({ error: result.message });
    return;
  }
  response.json({ ok: true, message: "Ballot opened. Vote 1, 2 or 3 as a viewer." });
});

app.post("/api/sandbox/ballot/vote", (request, response) => {
  const viewerId = typeof request.body?.viewerId === "string" ? request.body.viewerId : "";
  const option = Number(request.body?.option);
  if (!/^viewer_[1-5]$/.test(viewerId) || ![1, 2, 3].includes(option)) {
    response.status(400).json({ error: "Choose a viewer and option 1, 2 or 3." });
    return;
  }
  if (!openChoiceVote()?.vote(viewerId, option)) {
    response.status(409).json({ error: "No open ballot, vote already used, or the ballot closed." });
    return;
  }
  recordVote(viewerId, String(option) as "1" | "2" | "3", false);
  broadcastSnapshot();
  response.json({ ok: true });
});

app.post("/api/sandbox/repeal", (request, response) => {
  const viewerId = typeof request.body?.viewerId === "string" ? request.body.viewerId : "";
  const lawNumber = Number(request.body?.lawNumber);
  if (!/^viewer_[1-5]$/.test(viewerId) || !Number.isInteger(lawNumber) || lawNumber < 1 || lawNumber > 9999) {
    response.status(400).json({ error: "Choose a viewer and a law number." });
    return;
  }
  const started = startRepeal(viewerId, viewerId, lawNumber);
  if (!started.ok) {
    response.status(409).json({ error: started.message });
    return;
  }
  response.json({ ok: true, message: `Repeal vote for law-${lawNumber} started. Vote yes or no.` });
});

app.post("/api/sandbox/name/open", (_request, response) => {
  const started = startNameVote();
  if (!started.ok) {
    response.status(409).json({ error: started.message });
    return;
  }
  response.json({ ok: true, message: "Naming vote opened. Vote 1, 2 or 3 as a viewer." });
});

app.post("/api/sandbox/panel", (request, response) => {
  const kind = request.body?.kind;
  if (kind === "constitution") showInfoPanel(constitutionPanel(constitutionDocument()), 9);
  else if (kind === "tongue") showInfoPanel({ title: "THE BEAST'S TONGUE", rows: beastTongue }, 9);
  else {
    response.status(400).json({ error: "Unknown panel." });
    return;
  }
  response.json({ ok: true, message: "Showing the panel on the overlay for 9 seconds." });
});

app.post("/api/sandbox/laws", (_request, response) => {
  lawsPanelUntil = Date.now() + 6000;
  broadcastSnapshot();
  response.json({ ok: true, message: "Showing the laws panel on the overlay for 6 seconds." });
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
    // The silence beat: freeze the overlay on the crisis cards and go quiet, then reveal the result.
    holdSnapshotUntil = Date.now() + hushMs;
    broadcastSound("crisis_hush");
    const newLawWon = crisisOutcome.winner_choice === "proposed";
    lawBanner = createLawBannerPayload("crisis_resolved", crisisOutcome.winner, {
      now: Date.now() + hushMs,
      headline: newLawWon ? "NEW LAW SURVIVES" : "EXISTING LAW SURVIVES",
      voteSummary: `survived ${newLawWon ? crisisOutcome.proposed_votes : crisisOutcome.existing_votes}-${newLawWon ? crisisOutcome.existing_votes : crisisOutcome.proposed_votes}`,
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
    setTimeout(() => {
      holdSnapshotUntil = 0;
      broadcastSound("crisis_resolved");
      if (newLawWon) triggerLawAction(crisisOutcome.winner.action.type, true);
      showNotice(newLawWon ? "The new law survives the constitutional crisis." : "The existing law survives the constitutional crisis.");
      broadcastSnapshot();
    }, hushMs);
    return;
  }

  const ballotOutcome = ballot.closeIfExpired();
  if (ballotOutcome) {
    handleBallotOutcome(ballotOutcome);
    return;
  }
  const nameOutcome = nameVote.closeIfExpired();
  if (nameOutcome) {
    handleNameOutcome(nameOutcome);
    return;
  }
  if (shouldOpenBallot({
    now: Date.now(),
    nextAt: nextBallotAt,
    ballotMinutes: config.ballotMinutes,
    voteActive: Boolean(voting.current),
    crisisActive: Boolean(engine.currentCrisis),
    paused: streamerControls.paused,
    ballotOpen: anyBallotOpen() || ballotOpening
  })) {
    void openBallot();
  }

  const outcome = voting.closeIfExpired();
  if (!outcome) return;
  crowdScheduledFor.delete(outcome.proposalId);
  logDecision("vote_result", { proposal_id: outcome.proposalId, status: outcome.status, yes: outcome.yes, no: outcome.no, total: outcome.total });
  if (pendingRepeal && pendingRepeal.proposalId === outcome.proposalId) {
    const target = pendingRepeal;
    pendingRepeal = undefined;
    if (outcome.status === "passed") {
      const removed = engine.repeal(target.lawId);
      if (removed) {
        broadcastSound("crisis_resolved");
        lawBanner = createLawBannerPayload("crisis_resolved", removed, { headline: "LAW REPEALED", voteSummary: `repealed ${outcome.yes}-${outcome.no}` });
        logDecision("law_repealed", { id: removed.id, zone: removed.zone, part: removed.mutation.part_id });
        showNotice(`${target.lawId} was repealed.`);
      } else {
        showNotice(`${target.lawId} is already gone.`);
      }
    } else {
      showNotice(`The vote to repeal ${target.lawId} did not pass.`);
    }
    broadcastSnapshot();
    return;
  }
  if (outcome.status === "passed") broadcastSound("law_passed");
  if (outcome.status === "passed" && pendingLaw) enactLaw({ ...pendingLaw, voteSummary: `passed ${outcome.yes}-${outcome.no}` });
  pendingLaw = undefined;
  broadcastSnapshot();
  twitchRuntime?.sendChatReply(outcome.status === "passed" ? "The law passed." : "The law did not pass.");
}, 200);

// A network hiccup in the Twitch, OBS or WebSocket layer must never take the overlay down.
// Errors from this project's own code still exit loudly.
installProcessGuards({ log: (message) => console.error(message), exit: (code) => process.exit(code) });

const twitchBootDelaysMs = [5_000, 10_000, 20_000, 30_000];
const bootTwitch = (attempt = 0): void => {
  startTwitchRuntime({
    onEvent: handleTwitchEvent,
    onStatus: (message) => console.log(message),
    onConnectionChange: (connected, id) => { twitchConnected = connected; twitchBroadcasterId = id; },
    onSubscriptionsChange: (subscriptions) => { eventSubSubscriptions = subscriptions; },
    onConnectionStatus: (status) => { twitchStatus = status; }
  })
    .then((runtime) => {
      twitchRuntime = runtime;
      if (runtime) {
        twitchBroadcasterId = runtime.broadcasterId;
        twitchConnected = runtime.isConnected;
        eventSubSubscriptions = runtime.getSubscriptions();
        twitchStatus = runtime.getConnectionStatus();
      }
    })
    .catch(() => {
      const delay = twitchBootDelaysMs[Math.min(attempt, twitchBootDelaysMs.length - 1)] ?? 30_000;
      twitchStatus = { ...twitchStatus, reconnecting: true, reconnectAttempts: attempt + 1 };
      console.error(`Could not start Twitch EventSub (attempt ${attempt + 1}). Check credentials, token scopes and the network; retrying in ${delay / 1000}s.`);
      setTimeout(() => bootTwitch(attempt + 1), delay);
    });
};

server.listen(config.port, "127.0.0.1", () => {
  console.log(`Beast Rules sandbox is ready: http://localhost:${config.port}/sandbox.html`);
  console.log(`Beast Rules overlay browser source: http://localhost:${config.port}/overlay.html`);
  void obsSwitcher.start();
  bootTwitch();
});
