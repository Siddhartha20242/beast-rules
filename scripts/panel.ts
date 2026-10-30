// npm run panel [constitution|laws|tongue]: shows an information panel on the overlay of a running demo or sandbox
// server, the same panel a viewer gets with !constitution, !laws or !tongue, so it can be screen-recorded on its own.
// PORT defaults to 3100.
const base = `http://localhost:${process.env.PORT ?? 3100}`;
const kind = ["constitution", "laws", "tongue"].includes(process.argv[2] ?? "") ? process.argv[2] : "constitution";

try {
  const response = await fetch(`${base}/api/sandbox/panel`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind }) });
  console.log(response.ok ? `Showing the ${kind} panel on the overlay.` : `The server refused (${response.status}).`);
} catch {
  console.error(`No Beast Rules server answered on ${base}. Start it first.`);
  process.exit(1);
}
