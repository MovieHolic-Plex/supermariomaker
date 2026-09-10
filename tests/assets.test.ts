import { expect, test } from "bun:test";
import { PIXELS, ASSET_KEYS, WORLD_THEMES, WORLD_PALETTES } from "../src/assets/pixels";
import { MANIFEST, ATLAS_SIZE, getFrame, frameAt, FRAME_SEQUENCES, THEME_BACKGROUNDS } from "../src/assets/manifest";
import { rasterizeFrame, rasterizeAtlas } from "../src/render/assets";

test("resolves all 113 frames with unique, in-bounds atlas rectangles", () => {
  // Given all family imports; when resolving the manifest; then no frame is dropped or overlapped.
  expect(ASSET_KEYS).toHaveLength(113);
  expect(new Set(MANIFEST.map(f => f.key)).size).toBe(113);
  for (const frame of MANIFEST) {
    const source = PIXELS[frame.key];
    expect([frame.width, frame.height]).toEqual([source.width, source.height]);
    expect(source.rows).toHaveLength(frame.height);
    expect(frame.atlas.x + frame.width).toBeLessThan(ATLAS_SIZE.width);
    expect(frame.atlas.y + frame.height).toBeLessThan(ATLAS_SIZE.height);
    expect(frame.anchor.x).toBe(frame.width / 2);
    expect(frame.anchor.y).toBe(frame.key === "decor.platform" ? 8 : frame.height);
    for (const row of source.rows) {
      expect(row.length).toBe(frame.width);
      expect(row).toMatch(/^[.123456789ABCDEF]+$/);
    }
    for (const other of MANIFEST.filter(f => f.key !== frame.key)) {
      expect(frame.atlas.x + frame.width < other.atlas.x || other.atlas.x + other.width < frame.atlas.x
        || frame.atlas.y + frame.height < other.atlas.y || other.atlas.y + other.height < frame.atlas.y).toBe(true);
    }
  }
});
test("selects exact animation boundaries and loops", () => {
  // Given authored sequences; when selecting ticks; then boundaries and wrap are stable.
  expect(frameAt("mario.small.run", 7)).toBe("mario.small.run1");
  expect(frameAt("mario.small.run", 8)).toBe("mario.small.run2");
  expect(frameAt("mario.small.run", 24)).toBe("mario.small.run1");
  expect(() => frameAt("item.star", -1)).toThrow();
  expect(() => frameAt("item.star", 0, 0)).toThrow();
  for (const frames of Object.values(FRAME_SEQUENCES)) for (const key of frames) expect(getFrame(key).key).toBe(key);
});
test("rasterizes every source symbol into its real RGBA color in all four themes", () => {
  // Given authored matrices/colors; when rasterizing; then every byte matches the independent source inputs.
  for (const theme of WORLD_THEMES) for (const frame of MANIFEST) {
    const palette: Readonly<Record<string, string>> = WORLD_PALETTES[frame.palette === "world" ? theme : "overworld"];
    const actual = rasterizeFrame(frame.key, theme);
    const expected = [...PIXELS[frame.key].rows.join("")].flatMap(symbol => {
      const hex = palette[symbol];
      if (!hex) throw new Error(`Missing palette symbol ${symbol}`);
      return [1, 3, 5, 7].map(offset => offset === 7 && hex.length === 7 ? 255 : Number.parseInt(hex.slice(offset, offset + 2), 16));
    });
    expect(actual.length).toBe(frame.width * frame.height * 4);
    expect(Array.from(actual)).toEqual(expected);
  }
  expect(Array.from(rasterizeFrame("mario.small.idle", "overworld").slice(20, 24))).toEqual([228, 59, 44, 255]);
});
test("packs the actual raster into each atlas rectangle with transparent gutters", () => {
  // Given all frames; when packing; then every row and surrounding gutter survives without bleeding.
  for (const theme of WORLD_THEMES) {
    const atlas = rasterizeAtlas(theme);
    expect(atlas.length).toBe(ATLAS_SIZE.width * ATLAS_SIZE.height * 4);
    for (const frame of MANIFEST) {
      const pixels = rasterizeFrame(frame.key, theme);
      for (let y = 0; y < frame.height; y++) {
        const start = ((frame.atlas.y + y) * ATLAS_SIZE.width + frame.atlas.x) * 4;
        expect(atlas.slice(start, start + frame.width * 4)).toEqual(pixels.slice(y * frame.width * 4, (y + 1) * frame.width * 4));
        expect(Array.from(atlas.slice(start - 4, start))).toEqual([0, 0, 0, 0]);
        expect(Array.from(atlas.slice(start + frame.width * 4, start + (frame.width + 1) * 4))).toEqual([0, 0, 0, 0]);
      }
    }
  }
});
test("preserves actor identity colors and changes world terrain palettes", () => {
  // Given actors/terrain; when changing theme; then only theme-sensitive art changes.
  expect(rasterizeFrame("mario.super.idle", "castle")).toEqual(rasterizeFrame("mario.super.idle", "overworld"));
  expect(rasterizeFrame("enemy.goomba.walk1", "underground")).toEqual(rasterizeFrame("enemy.goomba.walk1", "overworld"));
  expect(rasterizeFrame("tile.brick", "underground")).not.toEqual(rasterizeFrame("tile.brick", "overworld"));
  expect(getFrame("tile.hidden").editorOnly).toBe(true);
});

test("keeps Bullet's nonempty raster perimeter at least 3:1 against castle", () => {
  const { width, height } = getFrame("enemy.bullet");
  const rgba = rasterizeFrame("enemy.bullet", "castle");
  const luminance = (rgb: Iterable<number>) => Array.from(rgb, byte => {
    const channel = byte / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  }).reduce((sum, channel, index) => sum + channel * (index === 0 ? 0.2126 : index === 1 ? 0.7152 : 0.0722), 0);
  const background = [1, 3, 5].map(offset => Number.parseInt(THEME_BACKGROUNDS.castle.slice(offset, offset + 2), 16));
  const backgroundLuminance = luminance(background);
  const opaque = (x: number, y: number) => x >= 0 && x < width && y >= 0 && y < height
    && rgba[(y * width + x) * 4 + 3] === 255;
  const contrasts: number[] = [];
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if (!opaque(x, y) || (opaque(x - 1, y) && opaque(x + 1, y) && opaque(x, y - 1) && opaque(x, y + 1))) continue;
    const offset = (y * width + x) * 4;
    const foregroundLuminance = luminance(rgba.subarray(offset, offset + 3));
    contrasts.push((Math.max(foregroundLuminance, backgroundLuminance) + 0.05)
      / (Math.min(foregroundLuminance, backgroundLuminance) + 0.05));
  }
  // An empty or fully transparent raster must not vacuously satisfy the contrast check.
  expect(contrasts.length).toBeGreaterThan(0);
  expect(Math.min(...contrasts)).toBeGreaterThanOrEqual(3);
});

test("small swim pose is not a standing idle", () => {
  expect(PIXELS["mario.small.swim1"].rows).not.toEqual(PIXELS["mario.small.idle"].rows);
  expect(PIXELS["mario.small.swim2"].rows).not.toEqual(PIXELS["mario.small.swim1"].rows);
  expect(PIXELS["mario.super.swim1"].rows).not.toEqual(PIXELS["mario.super.idle"].rows);
});
