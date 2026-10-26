// npm run recap [output.png]: saves the recap card (the beast, its name, laws and top lawmakers) as a 1200x630 PNG
// from a running Beast Rules server, ready to post to Discord or Twitch. Uses headless Chrome, so Chrome (or Chromium/Edge)
// must be installed; set CHROME_PATH if it is somewhere unusual. PORT picks the server port (default 3000).
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const port = process.env.PORT ?? "3000";
const output = resolve(process.argv[2] ?? "recap.png");
const candidates = [
  process.env.CHROME_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe"
].filter((path): path is string => Boolean(path));
const chrome = candidates.find((path) => existsSync(path));

async function main(): Promise<void> {
  if (!chrome) {
    console.error("Could not find Chrome, Chromium or Edge. Install one, or set CHROME_PATH to its executable.");
    process.exit(1);
  }
  try {
    const health = await fetch(`http://localhost:${port}/health`);
    if (!health.ok) throw new Error(String(health.status));
  } catch {
    console.error(`No Beast Rules server answered on port ${port}. Start it with npm run sandbox, then run npm run recap again.`);
    process.exit(1);
  }
  const result = spawnSync(chrome, [
    "--headless=new", "--disable-gpu", "--hide-scrollbars", "--force-device-scale-factor=2",
    "--window-size=1200,630", "--virtual-time-budget=6000", `--screenshot=${output}`,
    `http://localhost:${port}/recap.html`
  ], { stdio: "ignore" });
  if (result.status !== 0 || !existsSync(output)) {
    console.error("Chrome could not save the card. Open /recap.html in a browser and take a screenshot instead.");
    process.exit(1);
  }
  console.log(`Saved the recap card to ${output}`);
}

void main();
