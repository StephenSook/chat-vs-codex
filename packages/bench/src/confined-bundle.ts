import { realpath } from "node:fs/promises";
import { relative, sep } from "node:path";
import type { Plugin } from "esbuild";

/** Resolve patched code only from its materialized workspace dependency graph. */
export function confinedBundlePlugin(workspace: string): Plugin {
  const canonical = realpath(workspace);
  const resolving = {};
  const assertInside = async (path: string): Promise<string> => {
    const root = await canonical;
    const physical = await realpath(path);
    const rel = relative(root, physical);
    if (rel === ".." || rel.startsWith(`..${sep}`) || rel.startsWith(sep))
      throw new Error("Bundle import escapes runtime workspace");
    return physical;
  };
  return {
    name: "confined-runtime-files",
    setup(build) {
      build.onResolve({ filter: /.*/ }, async (args) => {
        if (args.pluginData === resolving) return undefined;
        if (/^[a-z][a-z\d+.-]*:/i.test(args.path))
          throw new Error("Runtime bundle protocol imports are forbidden");
        const result = await build.resolve(args.path, {
          kind: args.kind,
          importer: args.importer,
          namespace: args.namespace,
          resolveDir: args.resolveDir,
          pluginData: resolving,
        });
        if (result.errors.length) return { errors: result.errors };
        if (result.external || result.namespace !== "file")
          throw new Error("Runtime bundle external imports are forbidden");
        return { path: await assertInside(result.path), namespace: "file" };
      });
      // Recheck symlinks at load time too. No plugin may provide non-file modules.
      build.onLoad({ filter: /.*/, namespace: "file" }, async (args) => {
        await assertInside(args.path);
        return undefined;
      });
    },
  };
}
