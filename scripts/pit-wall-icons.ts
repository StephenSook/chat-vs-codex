import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { constants, deflateSync } from "node:zlib";
import { Resvg } from "@resvg/resvg-js";

export const ICON_SIZE = 1024;
export const ICON_FILES = [
  "icon.png",
  "adaptive-icon.png",
  "splash-icon.png",
] as const;
type IconFile = (typeof ICON_FILES)[number];

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, byte) => {
  let crc = byte;
  for (let bit = 0; bit < 8; bit++)
    crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  return crc >>> 0;
});

function chunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  let crc = 0xffffffff;
  for (const byte of body)
    crc = (CRC_TABLE[(crc ^ byte) & 255] ?? 0) ^ (crc >>> 8);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([length, body, checksum]);
}

/** Own PNG encoding keeps native renderer metadata and encoder defaults out of assets. */
function png(pixels: Uint8Array, channels: 3 | 4): Buffer {
  const stride = ICON_SIZE * channels;
  const scanlines = Buffer.alloc((stride + 1) * ICON_SIZE);
  for (let y = 0; y < ICON_SIZE; y++) {
    for (let x = 0; x < ICON_SIZE; x++) {
      const source = (y * ICON_SIZE + x) * 4;
      const destination = y * (stride + 1) + 1 + x * channels;
      if (channels === 3 && pixels[source + 3] !== 255)
        throw new Error("Marketing icon must be fully opaque");
      for (let channel = 0; channel < channels; channel++)
        scanlines[destination + channel] = pixels[source + channel] ?? 0;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(ICON_SIZE, 0);
  header.writeUInt32BE(ICON_SIZE, 4);
  header[8] = 8;
  header[9] = channels === 3 ? 2 : 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk(
      "IDAT",
      deflateSync(scanlines, {
        level: 9,
        strategy: constants.Z_FIXED,
        windowBits: 15,
        memLevel: 8,
      }),
    ),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function render(svg: string): Uint8Array {
  const rendered = new Resvg(svg, {
    fitTo: { mode: "width", value: ICON_SIZE },
    font: { loadSystemFonts: false },
  }).render();
  if (rendered.width !== ICON_SIZE || rendered.height !== ICON_SIZE)
    throw new Error("Icon SVG must render as a 1024 by 1024 square");
  return rendered.pixels;
}

/** The source owns one self-closing background rect; the mark is shared at exact scale. */
export function generateIcons(svg: string): Record<IconFile, Buffer> {
  if (
    /<(?:image|text|foreignObject)\b|\b(?:href|font-family)\s*=|url\s*\(/i.test(
      svg,
    )
  )
    throw new Error(
      "Icon SVG must use local geometry only, without fonts or images",
    );
  const backgrounds = svg.match(/<rect\b[^>]*\bid=["']background["'][^>]*\/>/g);
  if (backgrounds?.length !== 1)
    throw new Error("Icon SVG needs exactly one self-closing background rect");
  const background = backgrounds[0];
  if (!background) throw new Error("Icon background missing");
  const foreground = svg.replace(background, "");
  const transparent = png(render(foreground), 4);
  return {
    "icon.png": png(render(svg), 3),
    "adaptive-icon.png": transparent,
    "splash-icon.png": transparent,
  };
}

export async function writeIcons(root: string, check = false): Promise<void> {
  const directory = resolve(root, "apps/pit-wall/assets");
  const assets = generateIcons(
    await readFile(resolve(directory, "icon.svg"), "utf8"),
  );
  if (!check) await mkdir(directory, { recursive: true });
  for (const name of ICON_FILES) {
    const path = resolve(directory, name);
    if (check) {
      if (!(await readFile(path)).equals(assets[name]))
        throw new Error(`Pit Wall icon differs from its SVG: ${name}`);
    } else await writeFile(path, assets[name]);
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== "--check"))
    throw new Error("Usage: pnpm pit-wall:icons [--check]");
  await writeIcons(
    fileURLToPath(new URL("../", import.meta.url)),
    args.includes("--check"),
  );
}
