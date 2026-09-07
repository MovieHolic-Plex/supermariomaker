import { PLAYER_PIXELS } from "./pixels-player";
import { WORLD_PIXELS, WORLD_PALETTES } from "./pixels-world";
import { ENEMY_PIXELS } from "./pixels-enemies";

export { WORLD_PALETTES };
export const PIXELS = { ...PLAYER_PIXELS, ...WORLD_PIXELS, ...ENEMY_PIXELS } as const;
export type AssetKey = keyof typeof PIXELS;
export type WorldTheme = keyof typeof WORLD_PALETTES;
export interface PixelFrame {
  readonly width: number;
  readonly height: number;
  readonly rows: readonly string[];
}
export function isAssetKey(key: string): key is AssetKey { return Object.hasOwn(PIXELS, key); }
export const ASSET_KEYS: readonly AssetKey[] = Object.keys(PIXELS).filter(isAssetKey);
export const WORLD_THEMES = ["overworld", "underground", "underwater", "castle"] as const;
