import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type PooledMutant, ROOT, sourceDigest } from "./gate.js";
import { candidateDigest, enumerateCandidates } from "./live.js";

/** Accept only an exact Stryker-produced replacement in the current trusted source.
 * This authorizes original planted code capture, never a Codex-authored patch. */
export async function trustedOriginalMutation(
  mutant: PooledMutant,
  digest?: string,
): Promise<boolean> {
  if (digest !== undefined && digest !== (await sourceDigest())) return false;
  const pool = JSON.parse(
    await readFile(join(ROOT, "packages/mutator/pool.json"), "utf8"),
  ) as { mutants: PooledMutant[] };
  if (
    pool.mutants.some(
      (candidate) => candidateDigest(candidate) === candidateDigest(mutant),
    )
  )
    return true;
  return (await enumerateCandidates()).some(
    (candidate) => candidateDigest(candidate) === candidateDigest(mutant),
  );
}
