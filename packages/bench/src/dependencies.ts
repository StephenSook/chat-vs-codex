import { createHash } from "node:crypto";
import { cp, mkdir, readFile, realpath, symlink } from "node:fs/promises";
import { dirname, join, relative } from "node:path";

async function locate(name: string, from: string): Promise<string | null> {
  for (let dir = from; ; dir = dirname(dir)) {
    const path = join(dir, "node_modules", name);
    try {
      const pkg = JSON.parse(
        await readFile(join(path, "package.json"), "utf8"),
      ) as { name: string };
      if (pkg.name === name) return realpath(path);
    } catch (error) {
      if (
        !["ENOENT", "ENOTDIR"].includes(
          (error as NodeJS.ErrnoException).code ?? "",
        )
      )
        throw error;
    }
    if (dirname(dir) === dir) return null;
  }
}

/** Materialize only dependency code. Every symlink remains inside the trial. */
export async function copyDependencies(
  workspace: string,
  root: string,
): Promise<void> {
  const installed = new Map<string, string>();
  async function copy(real: string): Promise<string> {
    const existing = installed.get(real);
    if (existing) return existing;
    const id = createHash("sha256").update(real).digest("hex").slice(0, 20);
    const target = join(workspace, "node_modules/.isolated", id);
    installed.set(real, target);
    await cp(real, target, {
      recursive: true,
      filter: (p) => !relative(real, p).split("/").includes("node_modules"),
    });
    const pkg = JSON.parse(
      await readFile(join(real, "package.json"), "utf8"),
    ) as {
      name?: string;
      dependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
      peerDependenciesMeta?: Record<string, { optional?: boolean }>;
    };
    for (const [name, optional] of [
      ...Object.keys(pkg.dependencies ?? {}).map(
        (name) => [name, false] as const,
      ),
      ...Object.keys(pkg.optionalDependencies ?? {}).map(
        (name) => [name, true] as const,
      ),
      // Headless replay verification does not transform CSS or run Vite's
      // minifiers. Expo's installed minifiers must not expand every game snapshot.
      // Preserve other optional peers: vite-node needs its optional Vite link.
      ...Object.keys(pkg.peerDependencies ?? {})
        .filter(
          (name) =>
            !(
              pkg.name === "vite" &&
              ["lightningcss", "terser"].includes(name) &&
              pkg.peerDependenciesMeta?.[name]?.optional
            ),
        )
        .map((name) => [name, true] as const),
    ]) {
      const source = await locate(name, real);
      if (!source) {
        if (optional) continue;
        throw new Error(`Missing dependency ${name}`);
      }
      const dependency = await copy(source);
      const link = join(target, "node_modules", name);
      await mkdir(dirname(link), { recursive: true });
      try {
        await symlink(relative(dirname(link), dependency), link, "dir");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
    return target;
  }
  for (const name of ["vitest", "typescript", "@types/node", "pure-rand"]) {
    const source = await locate(
      name,
      name === "pure-rand" ? join(root, "packages/sim") : root,
    );
    if (!source) throw new Error(`Missing tool dependency ${name}`);
    const target = await copy(source);
    const link = join(workspace, "node_modules", name);
    await mkdir(dirname(link), { recursive: true });
    await symlink(relative(dirname(link), target), link, "dir");
  }
}
