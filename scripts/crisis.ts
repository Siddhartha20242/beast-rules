// npm run crisis:setup, then npm run crisis: plays the constitutional crisis scene of the demo against a running
// sandbox server, so it can be screen-recorded on its own. Start the server with
// `VOTE_SECONDS=6 CRISIS_SECONDS=8` for a short scene (the scripts also work with the defaults, just slower).
// "setup" passes the first law (horns) quietly; the main run proposes the competing law (red eyes), runs the
// crisis and waits for the verdict. Both watch the server instead of using fixed delays, and stop with a clear
// message if something is missing. PORT defaults to 3100.
const base = `http://localhost:${process.env.PORT ?? 3100}`;
const sleep = (seconds: number) => new Promise<void>((resolve) => setTimeout(resolve, seconds * 1000));

interface WireState {
  active_laws: { id: string; zone: string }[];
  proposal: unknown;
  crisis: unknown;
}

async function state(): Promise<WireState> {
  const response = await fetch(`${base}/api/state`);
  return (await response.json()) as WireState;
}

async function post(path: string, body: unknown): Promise<number> {
  const response = await fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return response.status;
}

async function waitFor(check: (current: WireState) => boolean, seconds: number): Promise<boolean> {
  const until = Date.now() + seconds * 1000;
  while (Date.now() < until) {
    if (check(await state())) return true;
    await sleep(0.25);
  }
  return false;
}

function fail(message: string): never {
  console.error(`\nStopped: ${message}`);
  process.exit(1);
}

async function propose(viewer: string, text: string): Promise<void> {
  const status = await post("/api/sandbox/propose", { viewerId: viewer, text });
  if (status >= 400) fail(`the proposal was refused (${status}). A vote may already be running, or ${viewer} is on its one-minute cooldown. Stop the server, delete its data folder and start again.`);
  if (!(await waitFor((s) => s.proposal !== null, 5))) fail("no vote card appeared. Is the overlay server running on this port?");
}

async function voteYes(voters: string[]): Promise<void> {
  for (const voter of voters) await post("/api/sandbox/vote", { viewerId: voter, choice: "yes" });
}

try {
  await state();
} catch {
  fail(`no Beast Rules server answered on ${base}. Start it first (see the commands in the recording guide).`);
}

if (process.argv[2] === "setup") {
  if ((await state()).active_laws.length > 0) fail("the beast already has laws. Stop the server, delete its data folder and start again.");
  console.log("Setting up: passing the first law (horns). Do not record yet.");
  await propose("viewer_1", "every follow gives the beast horns");
  await voteYes(["viewer_2", "viewer_3", "viewer_4"]);
  if (!(await waitFor((s) => s.active_laws.some((law) => law.zone === "head"), 60))) fail("the horns law did not pass.");
  console.log("Ready. Start your screen recording, then run: npm run crisis");
} else {
  if (!(await state()).active_laws.some((law) => law.zone === "head")) fail("the beast has no head law yet, so there would be no crisis. Run `npm run crisis:setup` first.");
  console.log("Proposing the competing law (red eyes)...");
  await propose("viewer_4", "follows make the beast grow red eyes");
  await voteYes(["viewer_1", "viewer_2", "viewer_3"]);
  if (!(await waitFor((s) => s.crisis !== null, 60))) fail("the crisis never opened, so the new law did not reach a crisis vote. Stop the server, delete its data folder and start again.");
  console.log("Constitutional crisis is open. Casting votes...");
  await sleep(1.5);
  for (const voter of ["viewer_1", "viewer_2", "viewer_3"]) await post("/api/sandbox/crisis-vote", { viewerId: voter, choice: "proposed" });
  await post("/api/sandbox/crisis-vote", { viewerId: "viewer_5", choice: "existing" });
  if (!(await waitFor((s) => s.crisis === null, 60))) fail("the crisis did not finish.");
  await sleep(6);
  console.log("Done. Stop your screen recording now.");
}
