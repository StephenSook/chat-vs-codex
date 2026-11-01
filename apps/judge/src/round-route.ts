import { ROUND_PROOF_HASH } from "../../../packages/round/src/proof-link.js";

/** Only committed receipts can be selected by a public deep link. */
export function parseRoundHash(
  hash: string,
  committedRoundIds: readonly string[],
): string | null {
  if (!hash.startsWith(ROUND_PROOF_HASH)) return null;
  const id = hash.slice(ROUND_PROOF_HASH.length);
  return /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
    id,
  ) && committedRoundIds.includes(id)
    ? id
    : null;
}
