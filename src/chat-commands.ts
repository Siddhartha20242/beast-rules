export type VoteToken = "1" | "2" | "3" | "yes" | "no";

export type ChatCommand =
  | { kind: "laws" }
  | { kind: "constitution" }
  | { kind: "tongue" }
  | { kind: "name_beast" }
  | { kind: "repeal"; lawNumber: number }
  | { kind: "law_missing" }
  | { kind: "law_highlight"; lawNumber: number }
  | { kind: "law_propose"; text: string }
  | { kind: "vote_token"; token: VoteToken }
  | { kind: "none" };

/**
 * Classify one chat message. Pure and side-effect free so every command and edge case can be tested
 * without Twitch. What a vote token means (yes/no, crisis 1/2, ballot 1/2/3) depends on what is
 * happening on stream, so the server decides that; this only recognises the token.
 */
export function parseChatCommand(raw: string): ChatCommand {
  const text = raw.trim();
  if (/^!laws$/i.test(text)) return { kind: "laws" };
  if (/^!constitution$/i.test(text)) return { kind: "constitution" };
  if (/^!tongue$/i.test(text)) return { kind: "tongue" };
  if (/^!name$/i.test(text)) return { kind: "name_beast" };
  const repeal = text.match(/^!repeal\s+(?:law-)?(\d{1,4})\s*$/i);
  if (repeal) return { kind: "repeal", lawNumber: Number(repeal[1]) };
  if (/^!law$/i.test(text)) return { kind: "law_missing" };
  const highlight = text.match(/^!law\s+(\d+)\s*$/i);
  if (highlight) return { kind: "law_highlight", lawNumber: Number(highlight[1]) };
  const proposal = text.match(/^!law\s+(.+)$/i);
  if (proposal) {
    const lawText = proposal[1]!.trim();
    return lawText ? { kind: "law_propose", text: lawText } : { kind: "none" };
  }
  if (/^[123]$/.test(text)) return { kind: "vote_token", token: text as VoteToken };
  if (/^yes$/i.test(text)) return { kind: "vote_token", token: "yes" };
  if (/^no$/i.test(text)) return { kind: "vote_token", token: "no" };
  return { kind: "none" };
}
