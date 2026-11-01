import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  generateIcons,
  ICON_FILES,
  ICON_SIZE,
} from "../../../scripts/pit-wall-icons.js";

const asset = (name: string) => new URL(`../assets/${name}`, import.meta.url);
const svg = readFileSync(asset("icon.svg"), "utf8");

function parsePng(bytes: Buffer) {
  expect(bytes.subarray(0, 8)).toEqual(
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  );
  const chunks: { type: string; data: Buffer }[] = [];
  for (let offset = 8; offset < bytes.length; ) {
    const length = bytes.readUInt32BE(offset);
    const end = offset + 12 + length;
    expect(end).toBeLessThanOrEqual(bytes.length);
    chunks.push({
      type: bytes.toString("ascii", offset + 4, offset + 8),
      data: bytes.subarray(offset + 8, offset + 8 + length),
    });
    offset = end;
  }
  const header = chunks.find(({ type }) => type === "IHDR")?.data;
  if (!header) throw new Error("PNG has no IHDR");
  return {
    width: header.readUInt32BE(0),
    height: header.readUInt32BE(4),
    bitDepth: header[8],
    colorType: header[9],
    chunkTypes: chunks.map(({ type }) => type),
    raw: inflateSync(
      Buffer.concat(
        chunks.filter(({ type }) => type === "IDAT").map(({ data }) => data),
      ),
    ),
  };
}

describe("Pit Wall icon assets", () => {
  it("ships an opaque 1024 square RGB marketing icon with ink corners", () => {
    const png = parsePng(readFileSync(asset("icon.png")));
    expect([png.width, png.height, png.bitDepth, png.colorType]).toEqual([
      1024, 1024, 8, 2,
    ]);
    expect(png.chunkTypes).not.toContain("tRNS");
    const stride = 1 + png.width * 3;
    for (const [x, y] of [
      [0, 0],
      [1023, 0],
      [0, 1023],
      [1023, 1023],
    ]) {
      if (x === undefined || y === undefined) throw new Error("Missing corner");
      expect(png.raw[y * stride]).toBe(0);
      const start = y * stride + 1 + x * 3;
      expect([...png.raw.subarray(start, start + 3)]).toEqual([31, 29, 27]);
    }
  });

  it("keeps the transparent adaptive foreground within its central 66% safe zone", () => {
    const png = parsePng(readFileSync(asset("adaptive-icon.png")));
    expect([png.width, png.height, png.bitDepth, png.colorType]).toEqual([
      1024, 1024, 8, 6,
    ]);
    const stride = 1 + png.width * 4;
    const inset = Math.ceil(ICON_SIZE * 0.17);
    const safeRadiusSquared = (ICON_SIZE * 0.33) ** 2;
    let visible = 0;
    let outsideSafeZone = 0;
    let transparent = 0;
    for (let y = 0; y < png.height; y++) {
      expect(png.raw[y * stride]).toBe(0);
      for (let x = 0; x < png.width; x++) {
        const alpha = png.raw[y * stride + 1 + x * 4 + 3];
        if (alpha === 0) transparent++;
        else {
          visible++;
          if (
            x < inset ||
            y < inset ||
            x >= ICON_SIZE - inset ||
            y >= ICON_SIZE - inset ||
            (x + 0.5 - ICON_SIZE / 2) ** 2 + (y + 0.5 - ICON_SIZE / 2) ** 2 >
              safeRadiusSquared
          )
            outsideSafeZone++;
        }
      }
    }
    expect(visible).toBeGreaterThan(ICON_SIZE * ICON_SIZE * 0.05);
    expect(transparent).toBeGreaterThan(ICON_SIZE * ICON_SIZE * 0.5);
    expect(outsideSafeZone).toBe(0);
  });

  it("matches all committed PNGs byte for byte after fresh SVG rendering", () => {
    const fresh = generateIcons(svg);
    for (const name of ICON_FILES) {
      expect(
        readFileSync(asset(name)).equals(fresh[name]),
        `${name} is stale`,
      ).toBe(true);
      const png = parsePng(fresh[name]);
      expect([png.width, png.height]).toEqual([ICON_SIZE, ICON_SIZE]);
    }
  });

  it("refuses source images, fonts and missing or ambiguous background layers", () => {
    expect(() =>
      generateIcons(svg.replace('id="background"', 'id="other"')),
    ).toThrow(/background rect/);
    expect(() =>
      generateIcons(
        svg.replace(
          "</svg>",
          '<rect id="background" width="1" height="1"/></svg>',
        ),
      ),
    ).toThrow(/background rect/);
    expect(() =>
      generateIcons(
        svg.replace(
          "</svg>",
          '<image href="https://example.test/icon"/></svg>',
        ),
      ),
    ).toThrow(/local geometry/);
  });
});
