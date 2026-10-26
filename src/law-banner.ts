import type { Color, PartId } from "./compiler/types.js";
import type { Zone } from "./schema.js";

export type LawBannerEvent = "passed" | "crisis_resolved";
export type RelatedLawRelation = "challenged" | "overruled";

export interface LawBannerPayload {
  banner_id: string;
  event: LawBannerEvent;
  headline: string;
  law_id: string;
  law_text: string;
  part_id: PartId;
  color: Color;
  zone: Zone;
  related_law_text?: string;
  related_law_relation?: RelatedLawRelation;
  ends_at: number;
}

export interface LawBannerLaw {
  id: string;
  raw_text: string;
  mutation: { part_id: PartId; color: Color };
  zone: Zone;
}

export function createLawBannerPayload(
  event: LawBannerEvent,
  law: LawBannerLaw,
  options: {
    now?: number;
    durationMs?: number;
    headline?: string;
    relatedLawText?: string;
    relatedLawRelation?: RelatedLawRelation;
  } = {}
): LawBannerPayload {
  const now = options.now ?? Date.now();
  return {
    banner_id: `${event}:${law.id}:${now}`,
    event,
    headline: options.headline ?? (event === "passed" ? "LAW PASSED" : "CRISIS RESOLVED"),
    law_id: law.id,
    law_text: law.raw_text,
    part_id: law.mutation.part_id,
    color: law.mutation.color,
    zone: law.zone,
    ...(options.relatedLawText ? { related_law_text: options.relatedLawText } : {}),
    ...(options.relatedLawRelation ? { related_law_relation: options.relatedLawRelation } : {}),
    ends_at: now + (options.durationMs ?? 4000)
  };
}

export function lawBannerForSnapshot(banner: LawBannerPayload | undefined, now = Date.now()): LawBannerPayload | null {
  return banner && banner.ends_at > now ? { ...banner } : null;
}
