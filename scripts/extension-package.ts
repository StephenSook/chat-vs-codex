import { execFileSync } from "node:child_process";
import { mkdir, readdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const directory = join(root, "apps/extension/dist");
const files: string[] = [];
async function walk(path: string) {
  for (const item of await readdir(path, { withFileTypes: true })) {
    const full = join(path, item.name);
    if (item.isSymbolicLink())
      throw new Error("Extension assets cannot contain symlinks");
    if (item.isDirectory()) await walk(full);
    else if (item.isFile()) files.push(full.slice(directory.length + 1));
  }
}
await walk(directory);
if (!files.includes("index.html") || files.length < 3)
  throw new Error("Build the Extension before packaging");
for (const file of files) {
  if (
    !/\.(html|css|js|svg|png|jpg|woff2)$/.test(file) ||
    (await stat(join(directory, file))).size > 10_000_000
  )
    throw new Error("Unexpected Extension asset");
  const bytes = await readFile(join(directory, file));
  if (
    /TWITCH_EXTENSION_SECRET|127\.0\.0\.1|localhost|Bearer /.test(
      bytes.toString("utf8"),
    )
  )
    throw new Error(
      "Extension asset contains private host or credential wiring",
    );
}
await mkdir(join(root, ".local/extension"), { recursive: true });
const output = join(root, ".local/extension/chat-vs-codex-panel.zip");
// Recreate rather than update a ZIP so removed files cannot survive from a previous build.
const temporary = `${output}.${Date.now()}.zip`;
execFileSync("zip", ["-X", "-q", temporary, ...files.sort()], {
  cwd: directory,
});
const { rename } = await import("node:fs/promises");
await rename(temporary, output);
console.log(
  `Extension upload: ${resolve(output)} (${files.length} static assets)`,
);
