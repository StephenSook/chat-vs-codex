import { createHash } from "node:crypto";
import ts from "typescript";
import { type HotfixRegion, validateRegions } from "../../mutator/src/index.js";
export interface SidecarFile {
  file: string;
  sha256: string;
  regions: (HotfixRegion & { marker: string; endMarker: string })[];
}
export interface HotfixManifest {
  schemaVersion: 1;
  files: SidecarFile[];
}
export const digest = (source: string): string =>
  createHash("sha256").update(source).digest("hex");
/** Conservative discovery, followed by a human/Codex purity review before authorizing sites. */
export function discoverRegions(source: string, file: string): SidecarFile {
  if (!/\.(?:ts|js)$/.test(file))
    throw new Error("Only TypeScript and JavaScript game logic is supported");
  const tree = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".js") ? ts.ScriptKind.JS : ts.ScriptKind.TS,
  );
  const regions: SidecarFile["regions"] = [];
  for (const node of tree.statements) {
    if (
      !ts.isFunctionDeclaration(node) ||
      !node.name ||
      !node.body ||
      node.name.text === "hashState"
    )
      continue;
    let impure = false;
    const inspect = (child: ts.Node): void => {
      if (
        ts.isAwaitExpression(child) ||
        ts.isThrowStatement(child) ||
        ts.isNewExpression(child)
      )
        impure = true;
      if (
        ts.isIdentifier(child) &&
        /^(?:window|document|globalThis|process|console|fetch|Date|performance|setTimeout|setInterval|require)$/.test(
          child.text,
        )
      )
        impure = true;
      if (
        ts.isPropertyAccessExpression(child) &&
        child.expression.getText(tree) === "Math" &&
        /^(?:sin|cos|pow|random)$/.test(child.name.text)
      )
        impure = true;
      ts.forEachChild(child, inspect);
    };
    inspect(node.body);
    if (!impure)
      regions.push({
        name: node.name.text,
        marker: `@hotfix-site ${node.name.text}`,
        endMarker: `@hotfix-site-end ${node.name.text}`,
        start: node.body.getStart(tree) + 1,
        end: node.body.end - 1,
      });
  }
  return { file, sha256: digest(source), regions };
}
export function authorizedRegions(
  source: string,
  file: SidecarFile,
): readonly HotfixRegion[] {
  if (digest(source) !== file.sha256)
    throw new Error("Sidecar source digest drift");
  validateRegions(source, file.regions);
  return file.regions;
}
