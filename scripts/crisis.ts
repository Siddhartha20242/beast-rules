// npm run crisis:setup, then npm run crisis: plays the constitutional crisis scene of the demo against a running
// sandbox server started with VOTE_SECONDS=6 CRISIS_SECONDS=8, so it can be screen-recorded on its own.
// "setup" passes the first law (horns) quietly; the main run proposes the competing law (red eyes) and runs the crisis.
// PORT defaults to 3100.
const base = `http://localhost:${process.env.PORT ?? 3100}`;
const sleep = (seconds: number) => new Promise<void>((resolve) => setTimeout(resolve, seconds * 1000));

async function post(path: string, body: unknown): Promise<number> {
  const response = await fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return response.status;
}

async function lawPasses(viewer: string, text: string, yes: string[]): Promise<void> {
  const status = await post("/api/sandbox/propose", { viewerId: viewer, text });
  if (status >= 400) throw new Error(`Proposal returned ${status}. Is a vote already running, or is the server not the crisis one?`);
  await sleep(1.2);
  for (const voter of yes) await post("/api/sandbox/vote", { viewerId: voter, choice: "yes" });
  await sleep(7.5);
}

const mode = process.argv[2] === "setup" ? "setup" : "run";

if (mode === "setup") {
  console.log("Setting up: passing the first law (horns). Takes about 10 seconds. Do not record yet.");
  await lawPasses("viewer_1", "every follow gives the beast horns", ["viewer_2", "viewer_3", "viewer_4"]);
  console.log("Ready. Start your screen recording, then run: npm run crisis");
} else {
  console.log("Proposing the competing law (red eyes)...");
  await lawPasses("viewer_4", "follows make the beast grow red eyes", ["viewer_1", "viewer_2", "viewer_3"]);
  await sleep(2);
  console.log("Crisis open. Casting votes...");
  for (const voter of ["viewer_1", "viewer_2", "viewer_3"]) await post("/api/sandbox/crisis-vote", { viewerId: voter, choice: "proposed" });
  await post("/api/sandbox/crisis-vote", { viewerId: "viewer_5", choice: "existing" });
  await sleep(12);
  console.log("Done. Stop your screen recording now.");
}
