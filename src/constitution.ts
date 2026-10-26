import { describeRule, displayUsername, lawTitle } from "./describe.js";
import type { ActiveLaw, HistoricalLaw } from "./engine.js";
import type { Zone } from "./schema.js";

export type ArticleStatus = "active" | "repealed" | "overruled";

export interface Article {
  id: string;
  number: number;
  title: string;
  /** Canonical description built from validated values, never the viewer's sentence. */
  text: string;
  zone: Zone;
  proposer: string | null;
  enacted_at: string;
  status: ArticleStatus;
  ended_at?: string;
  note?: string;
}

export interface ConstitutionCover {
  beast_name: string | null;
  temperament: string | null;
  ratified_at: string | null;
  /** Share of every law ever written that is still in force, 0-100. Null before the first law. */
  integrity_percent: number | null;
  laws_written: number;
  laws_in_force: number;
}

export interface ConstitutionDocument {
  cover: ConstitutionCover;
  title: string;
  preamble: string;
  beast_name: string | null;
  articles: Article[];
  summary: { active: number; repealed: number; overruled: number };
  scars: Partial<Record<Zone, number>>;
}

const preamble = "We, the chat of this channel, ordain these laws as the body of a creature that understands only the language of the beast.";

function lawNumber(id: string, fallback: number): number {
  const parsed = Number(id.replace(/^law-/, ""));
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function proposerOf(name: string | undefined): string | null {
  return name && name !== "unknown" ? displayUsername(name) : null;
}

function toArticle(law: ActiveLaw, index: number, status: ArticleStatus, history?: HistoricalLaw): Article {
  return {
    id: law.id,
    number: lawNumber(law.id, index + 1),
    title: lawTitle(law),
    text: describeRule({ status: law.status, trigger: law.trigger, action: law.action, mutation: law.mutation }),
    zone: law.zone,
    proposer: proposerOf(law.proposer_name),
    enacted_at: new Date(law.timestamp).toISOString(),
    status,
    ...(history ? {
      ended_at: new Date(history.repealed_at).toISOString(),
      note: history.overruled_by === "repealed" ? "Repealed by a chat vote." : `Overruled by ${history.overruled_by}.`
    } : {})
  };
}

/** Every zone that has lost a law keeps a scar for each one. */
export function scarsByZone(history: readonly Pick<HistoricalLaw, "zone">[]): Partial<Record<Zone, number>> {
  const scars: Partial<Record<Zone, number>> = {};
  for (const law of history) scars[law.zone] = (scars[law.zone] ?? 0) + 1;
  return scars;
}

export function buildConstitution(input: { beastName: string | null; active: readonly ActiveLaw[]; history: readonly HistoricalLaw[]; temperamentLabel?: string | null }): ConstitutionDocument {
  const articles: Article[] = [
    ...input.active.map((law, index) => toArticle(law, index, "active")),
    ...input.history.map((law, index) => toArticle(law, input.active.length + index, law.overruled_by === "repealed" ? "repealed" : "overruled", law))
  ].sort((a, b) => a.number - b.number);
  const written = articles.length;
  const inForce = articles.filter((article) => article.status === "active").length;
  const firstEnacted = written ? articles.map((article) => Date.parse(article.enacted_at)).sort((a, b) => a - b)[0]! : undefined;
  return {
    cover: {
      beast_name: input.beastName,
      temperament: input.temperamentLabel ?? null,
      ratified_at: firstEnacted === undefined ? null : new Date(firstEnacted).toISOString(),
      integrity_percent: written ? Math.round((inForce / written) * 100) : null,
      laws_written: written,
      laws_in_force: inForce
    },
    title: `Constitution of ${input.beastName ?? "the Beast"}`,
    preamble,
    beast_name: input.beastName,
    articles,
    summary: {
      active: articles.filter((article) => article.status === "active").length,
      repealed: articles.filter((article) => article.status === "repealed").length,
      overruled: articles.filter((article) => article.status === "overruled").length
    },
    scars: scarsByZone(input.history)
  };
}

export interface InfoPanel {
  title: string;
  rows: string[];
}

/** A short, overlay-sized view of the constitution for `!constitution`. */
export function constitutionPanel(document: ConstitutionDocument, maxRows = 6): InfoPanel {
  const active = document.articles.filter((article) => article.status === "active");
  const rows = active.slice(0, maxRows).map((article) => `${article.id} · ${article.title}: ${article.text}${article.proposer ? ` (by ${article.proposer})` : ""}`);
  if (active.length > maxRows) rows.push(`…and ${active.length - maxRows} more.`);
  if (!active.length) rows.push("No laws yet. Chat has not written anything.");
  const lost = document.summary.repealed + document.summary.overruled;
  if (lost > 0) rows.push(`${lost} law${lost === 1 ? "" : "s"} repealed or overruled; each left a scar.`);
  return { title: document.title.toUpperCase(), rows };
}
