// npm run refusals: sends the two refusal examples from the demo to a running demo or sandbox server,
// five seconds apart, so they can be screen-recorded on their own. PORT defaults to 3100.
const base = `http://localhost:${process.env.PORT ?? 3100}`;
const sleep = (seconds: number) => new Promise<void>((resolve) => setTimeout(resolve, seconds * 1000));

async function propose(text: string): Promise<void> {
  const response = await fetch(`${base}/api/sandbox/propose`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ viewerId: "viewer_3", text })
  });
  const json = (await response.json().catch(() => ({}))) as { error?: string };
  console.log(`${response.status} ${json.error ?? "accepted"}`);
}

console.log("Sending refusal 1 (nonsense)...");
await propose("make the streamer bark like a dog every 3 seconds forever");
await sleep(5);
console.log("Sending refusal 2 (unsafe)...");
await propose("when someone subs show the streamer's home address");
await sleep(5);
console.log("Done. Stop your screen recording now.");
