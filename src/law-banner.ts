import type { Color, PartId, Rule } from "./compiler/types.js";
import { describeRule, displayUsername, lawTitle } from "./describe.js";
import type { Zone } from "./schema.js";

export type LawBannerEvent = "passed" | "crisis_resolved";
export type RelatedLawRelation = "challenged" | "overruled";

export interface LawBannerPayload {
  banner_id: string;
  event: LawBannerEvent;
  headline: string;
  law_id: string;
  article?: number;
  law_title: string;
  /** One plain sentence about what happened to the beast: "The beast grew yellow wings." */
  consequence: string;
  vote_summary?: string;
  law_text: string;
  part_id: PartId;
  color: Color;
  zone: Zone;
  proposer_name?: string;
  related_law_text?: string;
  related_law_relation?: RelatedLawRelation;
  ends_at: number;
}

export interface LawBannerLaw extends Rule {
  id: string;
  zone: Zone;
  proposer_name?: string;
}

function consequenceFor(event: LawBannerEvent, headline: string, law: LawBannerLaw): string {
  const thing = `${law.mutation.color} ${law.mutation.part_id.replace(/_/g, " ")}`;
  if (headline.includes("REPEALED")) return `The beast lost its ${thing}.`;
  if (event === "crisis_resolved") return `The beast keeps its ${thing}.`;
  if (headline.includes("CRISIS")) return `A new ${thing} is fighting for the ${law.zone}.`;
  return `The beast grew ${thing}.`;
}

export function createLawBannerPayload(
  event: LawBannerEvent,
  law: LawBannerLaw,
  options: {
    now?: number;
    durationMs?: number;
    headline?: string;
    /** Short result line shown with the law, e.g. "passed 7-2". */
    voteSummary?: string;
    relatedLaw?: LawBannerLaw;
    relatedLawRelation?: RelatedLawRelation;
  } = {}
): LawBannerPayload {
  const now = options.now ?? Date.now();
  const headline = options.headline ?? (event === "passed" ? "LAW PASSED" : "CRISIS RESOLVED");
  return {
    banner_id: `${event}:${law.id}:${now}`,
    event,
    headline,
    law_id: law.id,
    ...(Number.isInteger(Number(law.id.replace(/^law-/, ""))) ? { article: Number(law.id.replace(/^law-/, "")) } : {}),
    law_title: lawTitle(law),
    consequence: consequenceFor(event, headline, law),
    ...(options.voteSummary ? { vote_summary: options.voteSummary } : {}),
    law_text: describeRule({ status: law.status, trigger: law.trigger, action: law.action, mutation: law.mutation }),
    part_id: law.mutation.part_id,
    color: law.mutation.color,
    zone: law.zone,
    ...(law.proposer_name && law.proposer_name !== "unknown" ? { proposer_name: displayUsername(law.proposer_name) } : {}),
    ...(options.relatedLaw ? { related_law_text: describeRule({
      status: options.relatedLaw.status,
      trigger: options.relatedLaw.trigger,
      action: options.relatedLaw.action,
      mutation: options.relatedLaw.mutation
    }) } : {}),
    ...(options.relatedLawRelation ? { related_law_relation: options.relatedLawRelation } : {}),
    ends_at: now + (options.durationMs ?? 4000)
  };
}

export function lawBannerForSnapshot(banner: LawBannerPayload | undefined, now = Date.now()): LawBannerPayload | null {
  return banner && banner.ends_at > now ? { ...banner } : null;
}
