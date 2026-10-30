// npm run repeal:scene [law number]: plays the repeal scene of the demo against a running sandbox server so it can be
// screen-recorded on its own. It proposes repealing a law (by default the newest law in force), casts three yes votes
// and waits for the result; the repealed law's zone gets another scar. Start the server with VOTE_SECONDS=6 for a short
// scene, and build some history first (for example npm run crisis:setup then npm run crisis). PORT defaults to 3100.
const base = `http://localhost:${process.env.PORT ?? 3100}`;
const sleep = (seconds: number) => new Promise<void>((resolve) => setTimeout(resolve, seconds * 1000));

interface WireState {
  active_laws: { id: string; zone: string }[];
  proposal: unknown;
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

let current: WireState;
try {
  current = await state();
} catch {
  fail(`no Beast Rules server answered on ${base}. Start it first.`);
}

const numbers = current.active_laws.map((law) => Number(law.id.replace(/^law-/, ""))).filter((n) => Number.isInteger(n));
if (numbers.length === 0) fail("the beast has no laws to repeal. Build some first (npm run crisis:setup, then npm run crisis).");
const requested = Number(process.argv[2]);
const lawNumber = numbers.includes(requested) ? requested : Math.max(...numbers);

console.log(`Proposing to repeal law ${lawNumber}...`);
const status = await post("/api/sandbox/repeal", { viewerId: "viewer_5", lawNumber });
if (status >= 400) fail(`the repeal could not start (${status}). A vote, crisis or ballot may be running, or viewer_5 is on cooldown. Wait a minute and try again.`);
if (!(await waitFor((s) => s.proposal !== null, 5))) fail("no repeal vote card appeared.");
await sleep(1.2);
for (const voter of ["viewer_1", "viewer_2", "viewer_3"]) await post("/api/sandbox/vote", { viewerId: voter, choice: "yes" });
if (!(await waitFor((s) => s.proposal === null, 60))) fail("the repeal vote did not finish.");
await sleep(6);
console.log("Done. Stop your screen recording now.");
