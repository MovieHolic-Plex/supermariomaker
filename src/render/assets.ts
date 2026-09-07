import { PIXELS, WORLD_PALETTES } from "../assets/pixels";
import type { AssetKey, WorldTheme } from "../assets/pixels";
import { AssetError, ATLAS_SIZE, MANIFEST, getFrame } from "../assets/manifest";

export function rasterizeFrame(key: AssetKey, theme: WorldTheme): Uint8ClampedArray<ArrayBuffer> {
  const frame = getFrame(key);
  const palette = WORLD_PALETTES[frame.palette === "world" ? theme : "overworld"];
  const colors = new Map(Object.entries(palette).map(([symbol, hex]) => [symbol,
    [1, 3, 5, 7].map(offset => offset === 7 && hex.length === 7 ? 255 : Number.parseInt(hex.slice(offset, offset + 2), 16)),
  ]));
  const data = new Uint8ClampedArray(frame.width * frame.height * 4);
  let offset = 0;
  for (const row of PIXELS[key].rows) for (const symbol of row) {
    const color = colors.get(symbol);
    if (!color) throw new AssetError(key, `Unknown palette symbol ${symbol}`);
    data.set(color, offset);
    offset += 4;
  }
  return data;
}
export function rasterizeAtlas(theme: WorldTheme): Uint8ClampedArray<ArrayBuffer> {
  const data = new Uint8ClampedArray(ATLAS_SIZE.width * ATLAS_SIZE.height * 4);
  for (const frame of MANIFEST) {
    const pixels = rasterizeFrame(frame.key, theme);
    for (let y = 0; y < frame.height; y++) {
      data.set(pixels.subarray(y * frame.width * 4, (y + 1) * frame.width * 4),
        ((frame.atlas.y + y) * ATLAS_SIZE.width + frame.atlas.x) * 4);
    }
  }
  return data;
}
// Browser resource cache is document-scoped; detached galleries do not retain their documents.
const atlases = new WeakMap<Document, Map<WorldTheme, HTMLCanvasElement>>();
export function canvasContext(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const context = canvas.getContext("2d");
  if (!context) throw new AssetError("canvas", "Canvas 2D is unavailable");
  return context;
}
export function getAtlas(document: Document, theme: WorldTheme): HTMLCanvasElement {
  let themes = atlases.get(document);
  if (!themes) { themes = new Map(); atlases.set(document, themes); }
  const cached = themes.get(theme);
  if (cached) return cached;
  const canvas = document.createElement("canvas");
  canvas.width = ATLAS_SIZE.width;
  canvas.height = ATLAS_SIZE.height;
  const context = canvasContext(canvas);
  const image = context.createImageData(canvas.width, canvas.height);
  image.data.set(rasterizeAtlas(theme));
  context.putImageData(image, 0, 0);
  themes.set(theme, canvas);
  return canvas;
}
export type PixelScale = 1 | 2 | 4 | 8;
export interface SpriteView {
  readonly key: AssetKey;
  /** CourseV1 pixel coordinates: bottom-center, never top-left. */
  readonly x: number;
  readonly y: number;
  readonly flipX?: boolean;
}
export interface DrawOptions {
  readonly theme?: WorldTheme;
  readonly scale?: PixelScale;
  readonly editorPreview?: boolean;
}
export function drawSprite(context: CanvasRenderingContext2D, sprite: SpriteView, options: DrawOptions = {}): void {
  const frame = getFrame(sprite.key);
  if (frame.editorOnly && !options.editorPreview) return;
  const scale = options.scale ?? 1;
  context.save();
  context.imageSmoothingEnabled = false;
  context.translate(Math.round(sprite.x) * scale, Math.round(sprite.y) * scale);
  context.scale(sprite.flipX ? -scale : scale, scale);
  context.drawImage(getAtlas(context.canvas.ownerDocument, options.theme ?? "overworld"),
    frame.atlas.x, frame.atlas.y, frame.width, frame.height,
    -frame.anchor.x, -frame.anchor.y, frame.width, frame.height);
  context.restore();
}
