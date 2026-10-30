// npm run live:guide: a prompter for the live Twitch recording. It watches the running server and prints, in the
// terminal, what the people in chat should type at each moment (a vote opens, a law passes, a crisis opens).
// It only reads /api/state and never changes anything. PORT defaults to 3000.
const base = `http://localhost:${process.env.PORT ?? 3000}`;
const sleep = (seconds: number) => new Promise<void>((resolve) => setTimeout(resolve, seconds * 1000));

interface WireState {
  active_laws: { id: string; zone: string; mutation: { part_id: string } }[];
  proposal: { text?: string; proposer_name?: string } | null;
  crisis: unknown;
  ballot: unknown;
}

const stamp = () => new Date().toLocaleTimeString();
const say = (message: string) => console.log(`[${stamp()}] ${message}`);

async function state(): Promise<WireState | undefined> {
  try {
    const response = await fetch(`${base}/api/state`);
    return (await response.json()) as WireState;
  } catch {
    return undefined;
  }
}

console.log("Live recording guide. Leave this window open next to the others. Press Ctrl+C to stop.\n");
say("Waiting. Start recording, then have the first person type: !law follows give horns");

let lastProposal = false;
let lastCrisis = false;
let announcedLaws = -1;
let sawFollowPrompt = false;

while (true) {
  const current = await state();
  if (!current) {
    say("The server is not answering. Is `npm run live` running?");
    await sleep(3);
    continue;
  }
  const proposalOpen = current.proposal !== null;
  const crisisOpen = current.crisis !== null;
  if (proposalOpen && !lastProposal && !crisisOpen) say("VOTE OPEN: everyone types yes or no NOW (about 15 seconds).");
  if (crisisOpen && !lastCrisis) say("CRISIS OPEN: type 2 to keep the NEW law, or 1 to keep the OLD law, NOW (about 15 seconds).");
  if (!crisisOpen && lastCrisis) say("Crisis over. Wait for the verdict and the crack, then let the screen sit for 5 seconds.");
  const lawCount = current.active_laws.length;
  if (announcedLaws === -1) announcedLaws = lawCount;
  if (lawCount > announcedLaws && !proposalOpen && !crisisOpen) {
    announcedLaws = lawCount;
    if (!sawFollowPrompt) {
      say("LAW PASSED. When the banner is gone, the iPad can tap Follow. Then the second person types: !law follows give red eyes");
      sawFollowPrompt = true;
    } else {
      say("Law passed. Let the screen sit for 5 seconds.");
    }
  }
  lastProposal = proposalOpen;
  lastCrisis = crisisOpen;
  await sleep(0.4);
}
