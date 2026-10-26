import type { ActiveLaw } from "./engine.js";
import { describeRule, displayUsername } from "./describe.js";
let toastSequence = 0;

export interface LawToast {
  toast_id: string;
  law_id: string;
  description: string;
  triggered_by?: string;
  sponsor?: string;
  simulated: boolean;
  ends_at: number;
}

export function createLawToast(law: ActiveLaw, actorName: string | undefined, simulated: boolean, now = Date.now()): LawToast {
  return {
    toast_id: `${law.id}:${now}:${++toastSequence}`,
    law_id: law.id,
    description: describeRule({ status: law.status, trigger: law.trigger, action: law.action, mutation: law.mutation }),
    ...(!simulated && actorName ? { triggered_by: displayUsername(actorName) } : {}),
    ...(law.proposer_name && law.proposer_name !== "unknown" ? { sponsor: displayUsername(law.proposer_name) } : {}),
    simulated,
    ends_at: now + 3000
  };
}

export function pushLawToast(toasts: readonly LawToast[], toast: LawToast, now = Date.now()): LawToast[] {
  return [...toasts.filter((item) => item.ends_at > now), toast].slice(-2);
}

export function lawToastsForSnapshot(toasts: readonly LawToast[], now = Date.now()): LawToast[] {
  return toasts.filter((toast) => toast.ends_at > now).slice(-2).map((toast) => ({ ...toast }));
}
