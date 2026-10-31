import { createHash } from "node:crypto";
import { Instrumenter } from "@stryker-mutator/instrumenter";

export interface Position {
  line: number;
  column: number;
}
export interface Candidate {
  id: string;
  file: string;
  site: string;
  mutator: string;
  location: { start: Position; end: Position };
  original: string;
  replacement: string;
}

const logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  fatal() {},
  trace() {},
  isDebugEnabled: () => false,
  isInfoEnabled: () => false,
  isWarnEnabled: () => false,
  isErrorEnabled: () => false,
  isFatalEnabled: () => false,
  isTraceEnabled: () => false,
};

/** Stryker API positions are zero-based UTF-16 offsets, end exclusive. */
export function offsetAt(source: string, position: Position): number {
  const lines = source.split("\n");
  const line = lines[position.line];
  if (
    !Number.isInteger(position.line) ||
    !Number.isInteger(position.column) ||
    position.line < 0 ||
    position.column < 0 ||
    line === undefined ||
    position.column > line.length
  ) {
    throw new Error("Invalid zero-based source location");
  }
  let offset = position.column;
  for (let i = 0; i < position.line; i++) offset += (lines[i]?.length ?? 0) + 1;
  return offset;
}

export function regions(
  source: string,
): { name: string; start: number; end: number }[] {
  const result: { name: string; start: number; end: number }[] = [];
  let open: { name: string; start: number } | undefined;
  const markers =
    /^\s*\/\/ @hotfix-site(-end)? (physics|input|collision|coyote|buffer|enemy)\s*$/gm;
  for (const match of source.matchAll(markers)) {
    const name = match[2];
    if (!name) throw new Error("Missing site name");
    if (!match[1]) {
      if (open) throw new Error("Nested hotfix sites");
      open = { name, start: match.index + match[0].length };
    } else {
      if (!open || open.name !== name) throw new Error("Unpaired hotfix site");
      result.push({ ...open, end: match.index });
      open = undefined;
    }
  }
  if (open) throw new Error("Unclosed hotfix site");
  return result;
}

/** Enumerate only. Discard Stryker's instrumented files; splice one replacement. */
export async function enumerate(
  source: string,
  file: string,
): Promise<Candidate[]> {
  const sites = regions(source);
  if (!sites.length) return [];
  const result = await new Instrumenter(logger).instrument(
    [
      {
        name: file,
        content: source,
        mutate: sites.map((s) => ({
          start: positionAt(source, s.start),
          end: positionAt(source, s.end),
        })),
      },
    ],
    { excludedMutations: [], ignorers: [], plugins: null },
  );
  return result.mutants.flatMap((mutant) => {
    if (mutant.status === "Ignored") return [];
    const start = offsetAt(source, mutant.location.start);
    const end = offsetAt(source, mutant.location.end);
    const site = sites.find((s) => start >= s.start && end <= s.end);
    if (!site || start >= end) return [];
    const original = source.slice(start, end);
    const id = createHash("sha256")
      .update(
        JSON.stringify([file, mutant.location, original, mutant.replacement]),
      )
      .digest("hex")
      .slice(0, 16);
    return [
      {
        id,
        file,
        site: site.name,
        mutator: mutant.mutatorName,
        location: mutant.location,
        original,
        replacement: mutant.replacement,
      },
    ];
  });
}

function positionAt(source: string, offset: number): Position {
  const prefix = source.slice(0, offset).split("\n");
  return { line: prefix.length - 1, column: prefix.at(-1)?.length ?? 0 };
}

export function applyCandidate(source: string, candidate: Candidate): string {
  const start = offsetAt(source, candidate.location.start);
  const end = offsetAt(source, candidate.location.end);
  if (source.slice(start, end) !== candidate.original) {
    throw new Error("Mutation source drift: original bytes no longer match");
  }
  const site = regions(source).find(
    (s) => s.name === candidate.site && start >= s.start && end <= s.end,
  );
  if (!site) throw new Error("Mutation is outside an authorized hotfix site");
  return source.slice(0, start) + candidate.replacement + source.slice(end);
}
