import { ASSET_KEYS, PIXELS } from "./pixels";
import type { AssetKey, WorldTheme } from "./pixels";
export type { AssetKey, WorldTheme } from "./pixels";

export interface AssetFrame {
  readonly key: AssetKey;
  readonly width: number;
  readonly height: number;
  readonly anchor: { readonly x: number; readonly y: number };
  readonly palette: "world" | "identity";
  readonly editorOnly: boolean;
  readonly atlas: { readonly x: number; readonly y: number };
}
// Transparent gutters; fixed slots keep frame coordinates stable.
export const ATLAS_SIZE = { width: 8 * 34, height: Math.ceil(ASSET_KEYS.length / 8) * 50 } as const;
export const MANIFEST: readonly AssetFrame[] = ASSET_KEYS.map((key, index) => {
  const { width, height } = PIXELS[key];
  return {
    key, width, height,
    // Platform lower eight rows are padding, not occupied geometry.
    anchor: { x: width / 2, y: key === "decor.platform" ? 8 : height },
    palette: (key.startsWith("tile.") || key.startsWith("decor.")) && key !== "decor.hudLife"
      ? "world" : "identity",
    editorOnly: key === "tile.hidden",
    atlas: { x: (index % 8) * 34 + 1, y: Math.floor(index / 8) * 50 + 1 },
  };
});
const byKey = new Map(MANIFEST.map((frame) => [frame.key, frame]));
export class AssetError extends Error {
  constructor(readonly asset: string, message: string) { super(`${asset}: ${message}`); this.name = "AssetError"; }
}
export function getFrame(key: AssetKey): AssetFrame {
  const frame = byKey.get(key);
  if (!frame) throw new AssetError(key, "Unknown frame");
  return frame;
}
export const THEME_BACKGROUNDS: Readonly<Record<WorldTheme, string>> = {
  overworld: "#5C94FC", underground: "#080C18", underwater: "#124C9C", castle: "#181820",
};
export const FRAME_SEQUENCES = {
  "mario.small.run": ["mario.small.run1", "mario.small.run2", "mario.small.run3"],
  "mario.small.swim": ["mario.small.swim1", "mario.small.swim2"],
  "mario.small.climb": ["mario.small.climb1", "mario.small.climb2"],
  "mario.super.run": ["mario.super.run1", "mario.super.run2", "mario.super.run3"],
  "mario.super.swim": ["mario.super.swim1", "mario.super.swim2"],
  "mario.super.climb": ["mario.super.climb1", "mario.super.climb2"],
  "mario.fire.run": ["mario.fire.run1", "mario.fire.run2", "mario.fire.run3"],
  "mario.fire.swim": ["mario.fire.swim1", "mario.fire.swim2"],
  "mario.fire.climb": ["mario.fire.climb1", "mario.fire.climb2"],
  "enemy.goomba.walk": ["enemy.goomba.walk1", "enemy.goomba.walk2"],
  "enemy.koopa.green.walk": ["enemy.koopa.green.walk1", "enemy.koopa.green.walk2"],
  "enemy.koopa.green.wings": ["enemy.koopa.green.wings1", "enemy.koopa.green.wings2"],
  "enemy.koopa.red.walk": ["enemy.koopa.red.walk1", "enemy.koopa.red.walk2"],
  "enemy.koopa.red.wings": ["enemy.koopa.red.wings1", "enemy.koopa.red.wings2"],
  "enemy.piranha.bite": ["enemy.piranha.open", "enemy.piranha.closed"],
  "enemy.buzzy.walk": ["enemy.buzzy.walk1", "enemy.buzzy.walk2"],
  "enemy.hammerBro.walk": ["enemy.hammerBro.walk1", "enemy.hammerBro.walk2"],
  "enemy.lakitu.attack": ["enemy.lakitu.ride", "enemy.lakitu.throw"],
  "enemy.spiny.walk": ["enemy.spiny.walk1", "enemy.spiny.walk2"],
  "enemy.cheep.red.swim": ["enemy.cheep.red.swim1", "enemy.cheep.red.swim2"],
  "enemy.cheep.green.swim": ["enemy.cheep.green.swim1", "enemy.cheep.green.swim2"],
  "enemy.blooper.swim": ["enemy.blooper.open", "enemy.blooper.closed"],
  "enemy.podoboo.flight": ["enemy.podoboo.rise", "enemy.podoboo.fall"],
  "enemy.bowser.walk": ["enemy.bowser.walk1", "enemy.bowser.walk2"],
  "item.star": ["item.star1", "item.star2"],
  "decor.spring": ["decor.springExtended", "decor.springCompressed"],
} as const satisfies Record<string, readonly [AssetKey, ...AssetKey[]]>;
export type AnimationKey = keyof typeof FRAME_SEQUENCES;
export function frameAt(key: AnimationKey, tick: number, ticksPerFrame = 8): AssetKey {
  if (!Number.isInteger(tick) || tick < 0 || !Number.isInteger(ticksPerFrame) || ticksPerFrame < 1) {
    throw new AssetError(key, "Animation needs a nonnegative tick and positive frame duration");
  }
  const frames = FRAME_SEQUENCES[key];
  return frames[Math.floor(tick / ticksPerFrame) % frames.length] ?? frames[0];
}
