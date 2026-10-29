// npm run ballot:scene: plays the numbered-ballot scene of the demo against a running sandbox server so it can be
// screen-recorded on its own. Start the server with `BALLOT_MINUTES=0 BALLOT_SECONDS=8` for a short scene.
// It opens a ballot, casts simulated votes (three for option 2, one for option 1) and waits for the winner.
// PORT defaults to 3100.
const base = `http://localhost:${process.env.PORT ?? 3100}`;
const sleep = (seconds: number) => new Promise<void>((resolve) => setTimeout(resolve, seconds * 1000));

interface WireState {
  ballot: unknown;
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

try {
  await state();
} catch {
  fail(`no Beast Rules server answered on ${base}. Start it first.`);
}

console.log("Opening a ballot...");
const status = await post("/api/sandbox/ballot/open", {});
if (status >= 400) fail(`the ballot could not open (${status}). A vote, crisis or ballot may already be running. Wait for it to end and try again.`);
if (!(await waitFor((s) => s.ballot !== null, 5))) fail("no ballot card appeared.");
await sleep(1.5);
console.log("Ballot is open. Casting votes...");
for (const voter of ["viewer_1", "viewer_2", "viewer_3"]) await post("/api/sandbox/ballot/vote", { viewerId: voter, option: 2 });
await post("/api/sandbox/ballot/vote", { viewerId: "viewer_4", option: 1 });
if (!(await waitFor((s) => s.ballot === null, 60))) fail("the ballot did not finish.");
await sleep(6);
console.log("Done. Stop your screen recording now.");
