// npm run demo: plays the whole Beast Rules story by itself against an isolated copy of the app.
// It starts its own server on its own port with its own empty data folder (your real beast is never touched),
// does not connect to Twitch, and drives the same sandbox endpoints the sandbox page uses.
// Open the printed overlay URL in a browser (or OBS), start recording, and press Enter.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

const port = Number(process.env.DEMO_PORT ?? 3100);
const base = `http://localhost:${port}`;
const voteSeconds = 6;
const crisisSeconds = 8;
const ballotSeconds = 8;
const dataDir = mkdtempSync(join(tmpdir(), "beast-rules-demo-"));
let server: ChildProcess | undefined;

const sleep = (seconds: number) => new Promise<void>((resolve) => setTimeout(resolve, seconds * 1000));

async function call(path: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await fetch(`${base}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  const json = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: response.status, json };
}

function say(title: string, lookFor: string): void {
  console.log(`\n▶ ${title}\n   Watch for: ${lookFor}`);
}

async function expectOk(label: string, path: string, body?: unknown): Promise<void> {
  const result = await call(path, body);
  if (result.status >= 400) console.log(`   (note: ${label} returned ${result.status}: ${String(result.json.error ?? "no detail")})`);
}

async function vote(viewer: string, choice: "yes" | "no"): Promise<void> {
  await call("/api/sandbox/vote", { viewerId: viewer, choice });
}

async function lawPasses(viewer: string, text: string, yes: string[], no: string[]): Promise<void> {
  await expectOk(`proposal by ${viewer}`, "/api/sandbox/propose", { viewerId: viewer, text });
  await sleep(1.2);
  for (const voter of yes) await vote(voter, "yes");
  for (const voter of no) await vote(voter, "no");
  await sleep(voteSeconds + 1.5);
}

async function waitForServer(): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`${base}/health`);
      if (response.ok) return;
    } catch {
      // not up yet
    }
    await sleep(0.5);
  }
  throw new Error("The demo server did not start. Is something else using port " + port + "?");
}

function shutdown(code = 0): never {
  server?.kill("SIGTERM");
  try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* temp folder, best effort */ }
  process.exit(code);
}

async function main(): Promise<void> {
  server = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
    env: {
      ...process.env,
      PORT: String(port),
      DATA_DIR: dataDir,
      VOTE_SECONDS: String(voteSeconds),
      CRISIS_SECONDS: String(crisisSeconds),
      BALLOT_SECONDS: String(ballotSeconds),
      BALLOT_MINUTES: "0",
      LOG_EVENTS: "off",
      COMPILER: "template",
      // Empty values keep Twitch switched off for the demo, even if a .env file exists.
      TWITCH_CLIENT_ID: "",
      TWITCH_CLIENT_SECRET: ""
    },
    stdio: "ignore"
  });
  server.on("exit", (code) => { if (code && code !== 143) console.log(`\n(demo server stopped with code ${code})`); });
  process.on("SIGINT", () => shutdown(0));
  process.on("SIGTERM", () => shutdown(0));

  await waitForServer();
  console.log("Beast Rules demo");
  console.log("================");
  console.log(`Overlay for recording (open in a browser or OBS):\n  ${base}/overlay.html?obs=1&sound=on&bg=dark`);
  console.log(`Constitution page (shown at the end):\n  ${base}/constitution.html`);
  console.log("\nEverything here is simulated: the viewers are viewer_1 to viewer_5 and follow/sub events are labelled SIM on screen.");
  console.log("Say so in the video. Your real beast and your Twitch connection are not used.\n");

  const autoStartSeconds = Number(process.env.DEMO_DELAY ?? 0);
  if (autoStartSeconds > 0) {
    console.log(`Starting by itself in ${autoStartSeconds} seconds. Open the overlay and start your screen recording now.`);
    await sleep(autoStartSeconds);
  } else if (process.stdin.isTTY) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    await new Promise<void>((resolve) => rl.question("Start recording, then press Enter to begin... ", () => { rl.close(); resolve(); }));
  } else {
    console.log("Starting in 5 seconds...");
    await sleep(5);
  }

  say("1. Chat proposes a law and votes", "a banner with the Article number, the law's title and the vote result (for example 'passed 3-1'), and a horns part growing on the beast");
  await lawPasses("viewer_1", "every follow gives the beast horns", ["viewer_2", "viewer_3", "viewer_4"], ["viewer_5"]);

  say("2. A follow fires the law", "a SIM follow, a toast naming the law and its sponsor, confetti");
  await expectOk("follow event", "/api/sandbox/event", { event: "follow" });
  await sleep(4);

  say("3. A second law: subs shake the screen", "wings growing, then a screen shake when a SIM sub arrives");
  await lawPasses("viewer_2", "when someone subs grow wings and shake the screen", ["viewer_1", "viewer_3", "viewer_4"], []);
  await expectOk("sub event", "/api/sandbox/event", { event: "sub" });
  await sleep(4);

  say("4. The beast refuses nonsense", "the beast answering in character, 'The beast cannot hear that' or 'The beast refuses', with nothing the viewer typed shown on screen");
  await expectOk("refusal 1", "/api/sandbox/propose", { viewerId: "viewer_3", text: "make the streamer bark like a dog every 3 seconds forever" });
  await sleep(5);
  await expectOk("refusal 2", "/api/sandbox/propose", { viewerId: "viewer_3", text: "when someone subs show the streamer's home address" });
  await sleep(5);

  say("5. A constitutional crisis", "two laws fighting over the head, a countdown, then the loser cracking the beast with a thud");
  await expectOk("crisis proposal", "/api/sandbox/propose", { viewerId: "viewer_4", text: "follows make the beast grow red eyes" });
  await sleep(1.2);
  for (const voter of ["viewer_1", "viewer_2", "viewer_3"]) await vote(voter, "yes");
  await sleep(voteSeconds + 1.5);
  await sleep(2);
  for (const voter of ["viewer_1", "viewer_2", "viewer_3"]) await expectOk("crisis vote", "/api/sandbox/crisis-vote", { viewerId: voter, choice: "proposed" });
  await expectOk("crisis vote", "/api/sandbox/crisis-vote", { viewerId: "viewer_5", choice: "existing" });
  await sleep(crisisSeconds + 3);

  say("6. A ballot: chat types one digit", "three suggested laws, vote bars, and the winner becoming a new part");
  await expectOk("ballot", "/api/sandbox/ballot/open", {});
  await sleep(1.5);
  for (const voter of ["viewer_1", "viewer_2", "viewer_3"]) await expectOk("ballot vote", "/api/sandbox/ballot/vote", { viewerId: voter, option: 2 });
  await expectOk("ballot vote", "/api/sandbox/ballot/vote", { viewerId: "viewer_4", option: 1 });
  await sleep(ballotSeconds + 3);

  say("7. Chat repeals a law", "a repeal vote and a LAW REPEALED banner, then a second scar");
  await expectOk("repeal", "/api/sandbox/repeal", { viewerId: "viewer_5", lawNumber: 2 });
  await sleep(1.2);
  for (const voter of ["viewer_1", "viewer_2", "viewer_3"]) await vote(voter, "yes");
  await sleep(voteSeconds + 3);

  say("8. Chat names the beast", "three names from a fixed list, then the name next to the tier label");
  await expectOk("name vote", "/api/sandbox/name/open", {});
  await sleep(1.5);
  for (const voter of ["viewer_1", "viewer_2", "viewer_3"]) await expectOk("name vote", "/api/sandbox/ballot/vote", { viewerId: voter, option: 1 });
  await sleep(ballotSeconds + 3);

  say("9. The constitution", "the laws on screen, each with its title, sponsor and status. Then open the constitution page");
  await expectOk("panel", "/api/sandbox/panel", { kind: "constitution" });
  await sleep(10);

  console.log(`\nDone. Open ${base}/constitution.html to show the printable constitution, with its cover.`);
  console.log("Press Ctrl+C when you are finished; the demo data is deleted automatically.");
  await new Promise<void>(() => undefined);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  shutdown(1);
});
