import { createHash } from "node:crypto";
import type { Candidate } from "./index.js";

const sha = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Shared evidence framing without loading a simulator or gate worker. */
export function sourceFingerprint(sources: Record<string, string>): string {
  return sha(Object.entries(sources).sort(([a], [b]) => a.localeCompare(b)));
}

export function mutationFingerprint(
  candidate: Candidate,
  sourceDigest: string,
): string {
  return sha([
    sourceDigest,
    candidate.file,
    candidate.location,
    candidate.original,
    candidate.replacement,
  ]);
}

export function candidateDigest(candidate: Candidate): string {
  return sha([
    candidate.id,
    candidate.file,
    candidate.site,
    candidate.mutator,
    candidate.location,
    candidate.original,
    candidate.replacement,
  ]);
}
