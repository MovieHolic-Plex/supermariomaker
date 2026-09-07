import { THEME_BACKGROUNDS, getFrame } from "../assets/manifest";
import type { WorldTheme } from "../assets/pixels";
import { canvasContext, drawSprite, getAtlas } from "./assets";
import type { DrawOptions, PixelScale, SpriteView } from "./assets";

export const GAME_VIEWPORT = { width: 256, height: 240 } as const;
export interface CameraView { readonly x: number; readonly y: number }
export interface RenderView {
  readonly theme: WorldTheme;
  readonly camera: CameraView;
  /** Back-to-front order, supplied by caller. Renderer does not simulate or collide. */
  readonly sprites: readonly SpriteView[];
  readonly editorPreview?: boolean;
}
export interface PipeView { readonly x: number; readonly y: number; readonly heightCells: number }
export interface PlatformView { readonly x: number; readonly y: number; readonly length: number }
export interface PoleView { readonly x: number; readonly y: number; readonly heightCells: number }

export function renderScene(canvas: HTMLCanvasElement, view: RenderView, scale: PixelScale = 1): void {
  canvas.width = GAME_VIEWPORT.width * scale;
  canvas.height = GAME_VIEWPORT.height * scale;
  canvas.style.width = `${canvas.width}px`;
  canvas.style.height = `${canvas.height}px`;
  canvas.style.imageRendering = "pixelated";
  const context = canvasContext(canvas);
  context.fillStyle = THEME_BACKGROUNDS[view.theme];
  context.fillRect(0, 0, canvas.width, canvas.height);
  for (const sprite of view.sprites) drawSprite(context, {
    ...sprite, x: sprite.x - view.camera.x, y: sprite.y - view.camera.y,
  }, { theme: view.theme, scale, editorPreview: view.editorPreview ?? false });
}
export function drawPipe(context: CanvasRenderingContext2D, pipe: PipeView, options: DrawOptions = {}): void {
  for (let row = 0; row < pipe.heightCells - 1; row++) {
    drawSprite(context, { key: "decor.pipeBody", x: pipe.x, y: pipe.y - row * 16 }, options);
  }
  drawSprite(context, { key: "decor.pipeCap", x: pipe.x, y: pipe.y - (pipe.heightCells - 1) * 16 }, options);
}
export function drawPlatform(context: CanvasRenderingContext2D, platform: PlatformView, options: DrawOptions = {}): void {
  for (let cell = 0; cell < platform.length; cell++) drawSprite(context, {
    key: "decor.platform", x: platform.x - platform.length * 8 + cell * 16 + 8, y: platform.y,
  }, options);
}
export function drawPole(context: CanvasRenderingContext2D, pole: PoleView, options: DrawOptions = {}): void {
  const top = pole.y - pole.heightCells * 16;
  drawSprite(context, { key: "decor.pole", x: pole.x, y: top + 16 }, options);
  const frame = getFrame("decor.pole");
  const scale = options.scale ?? 1;
  context.save();
  context.imageSmoothingEnabled = false;
  const atlas = getAtlas(context.canvas.ownerDocument, options.theme ?? "overworld");
  // Repeat only shaft rows 8-15; never repeat the finial down the pole.
  for (let y = top + 16; y < pole.y; y += 8) context.drawImage(atlas,
    frame.atlas.x, frame.atlas.y + 8, 16, 8,
    Math.round(pole.x - 8) * scale, Math.round(y) * scale, 16 * scale, 8 * scale);
  context.restore();
}
