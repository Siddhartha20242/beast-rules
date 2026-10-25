import { config } from "./config.js";

export type VoteChoice = "yes" | "no";
export type VoteStatus = "passed" | "failed";

export interface VoteOutcome {
  proposalId: string;
  status: VoteStatus;
  yes: number;
  no: number;
  total: number;
  startedAt: number;
  endedAt: number;
}

export interface ProposalSnapshot {
  proposalId: string;
  proposerId: string;
  startedAt: number;
  endsAt: number;
  yes: number;
  no: number;
  voters: number;
}

export interface VotingOptions {
  voteSeconds?: number;
  proposalCooldownSeconds?: number;
  clock?: () => number;
}

interface ActiveProposal extends ProposalSnapshot {
  votes: Map<string, VoteChoice>;
}

export class VotingManager {
  private readonly voteWindowMs: number;
  private readonly cooldownMs: number;
  private readonly clock: () => number;
  private readonly proposerCooldowns = new Map<string, number>();
  private proposal: ActiveProposal | undefined;
  private lastOutcome: VoteOutcome | undefined;

  constructor(options: VotingOptions = {}) {
    this.voteWindowMs = Math.max(1, options.voteSeconds ?? config.voteSeconds) * 1000;
    this.cooldownMs = Math.max(0, options.proposalCooldownSeconds ?? 60) * 1000;
    this.clock = options.clock ?? Date.now;
  }

  get current(): ProposalSnapshot | undefined {
    if (!this.proposal) return undefined;
    const { proposalId, proposerId, startedAt, endsAt, yes, no, voters } = this.proposal;
    return { proposalId, proposerId, startedAt, endsAt, yes, no, voters };
  }

  get outcome(): VoteOutcome | undefined {
    return this.lastOutcome ? { ...this.lastOutcome } : undefined;
  }

  startProposal(proposalId: string, proposerId: string): boolean {
    if (this.proposal) return false;
    const now = this.clock();
    const cooldownEndsAt = this.proposerCooldowns.get(proposerId) ?? 0;
    if (now < cooldownEndsAt) return false;

    this.proposerCooldowns.set(proposerId, now + this.cooldownMs);
    this.proposal = {
      proposalId,
      proposerId,
      startedAt: now,
      endsAt: now + this.voteWindowMs,
      yes: 0,
      no: 0,
      voters: 0,
      votes: new Map()
    };
    this.lastOutcome = undefined;
    return true;
  }

  castVote(userId: string, choice: VoteChoice): boolean {
    if (!this.proposal || this.clock() >= this.proposal.endsAt || this.proposal.votes.has(userId)) return false;
    this.proposal.votes.set(userId, choice);
    this.proposal.voters += 1;
    if (choice === "yes") this.proposal.yes += 1;
    else this.proposal.no += 1;
    return true;
  }

  closeIfExpired(): VoteOutcome | undefined {
    if (!this.proposal || this.clock() < this.proposal.endsAt) return undefined;
    const proposal = this.proposal;
    const total = proposal.yes + proposal.no;
    const outcome: VoteOutcome = {
      proposalId: proposal.proposalId,
      status: total >= 1 && proposal.yes > proposal.no ? "passed" : "failed",
      yes: proposal.yes,
      no: proposal.no,
      total,
      startedAt: proposal.startedAt,
      endedAt: this.clock()
    };
    this.proposal = undefined;
    this.lastOutcome = outcome;
    return { ...outcome };
  }
}
