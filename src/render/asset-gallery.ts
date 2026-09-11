import { ASSET_KEYS, WORLD_THEMES } from "../assets/pixels";
import type { AssetKey, WorldTheme } from "../assets/pixels";
import { THEME_BACKGROUNDS, getFrame } from "../assets/manifest";
import { canvasContext, drawSprite } from "./assets";
import type { PixelScale, SpriteView } from "./assets";
import { renderScene, drawPipe, drawPlatform, drawPole } from "./renderer";

export interface SheetPage {
  readonly id: string;
  readonly theme: WorldTheme;
  readonly keys: readonly AssetKey[];
}
export const GALLERY_PAGES: readonly SheetPage[] = WORLD_THEMES.flatMap(theme =>
  Array.from({ length: Math.ceil(ASSET_KEYS.length / 8) }, (_, index) => ({
    id: `${theme}-${String(index + 1).padStart(2, "0")}`, theme,
    keys: ASSET_KEYS.slice(index * 8, index * 8 + 8),
  })));
export const COMPOSITION_SPRITES: readonly SpriteView[] = [
  { key: "decor.cloud", x: 64, y: 48 }, { key: "decor.hill", x: 32, y: 208 },
  { key: "decor.bush", x: 96, y: 208 }, { key: "decor.smallCastle", x: 224, y: 208 },
  ...Array.from({ length: 16 }, (_, x) => ({ key: "tile.ground", x: x * 16 + 8, y: 224 } as const)),
  ...Array.from({ length: 16 }, (_, x) => ({ key: "tile.ground", x: x * 16 + 8, y: 240 } as const)),
  { key: "tile.brick", x: 72, y: 160 }, { key: "tile.question", x: 88, y: 160 },
  { key: "mario.super.run1", x: 40, y: 208 }, { key: "enemy.goomba.walk1", x: 80, y: 208 },
  { key: "enemy.koopa.red.walk1", x: 112, y: 208 }, { key: "item.star1", x: 88, y: 136 },
];

export function mountAssetGallery(root: HTMLElement): () => void {
  const document = root.ownerDocument;
  root.replaceChildren();
  root.dataset["testid"] = "asset-gallery";
  root.style.cssText = "max-width:1100px;margin:auto;padding:16px;";
  const heading = document.createElement("h1");
  heading.textContent = "픽셀 자료실";
  heading.style.cssText = "font-size:24px;margin:0 0 8px";
  const controls = document.createElement("nav");
  controls.setAttribute("aria-label", "자료실 탐색");
  controls.style.cssText = "display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:8px";
  const previous = document.createElement("button");
  previous.textContent = "이전";
  previous.dataset["testid"] = "assets-previous";
  const next = document.createElement("button");
  next.textContent = "다음";
  next.dataset["testid"] = "assets-next";
  const select = document.createElement("select");
  select.dataset["testid"] = "assets-page";
  select.setAttribute("aria-label", "테마 및 시트 선택");
  select.style.cssText = "font:inherit;min-height:44px;max-width:100%";
  for (const page of GALLERY_PAGES) select.add(new Option(page.id, page.id));
  for (const theme of WORLD_THEMES) for (const scale of [1, 4]) {
    const id = `scene-${theme}-${scale}`;
    select.add(new Option(`${theme} / 합성 ${scale}x`, id));
  }
  const count = document.createElement("span");
  count.className = "muted";
  count.setAttribute("aria-live", "polite");
  controls.append(previous, select, next, count);
  const note = document.createElement("p");
  note.textContent = `전체 ${ASSET_KEYS.length} 프레임 · 4개 테마 · 원본 1x / 확대 4x · 숨김 블록은 편집 미리보기`;
  note.style.cssText = "font-size:12px;margin:0 0 8px;max-width:none;word-break:keep-all";
  const sheet = document.createElement("section");
  sheet.dataset["testid"] = "asset-sheet";
  root.append(heading, controls, note, sheet);

  function show(): void {
    sheet.replaceChildren();
    sheet.dataset["page"] = select.value;
    const page = GALLERY_PAGES.find(entry => entry.id === select.value);
    previous.disabled = select.selectedIndex === 0;
    next.disabled = select.selectedIndex === select.options.length - 1;
    count.textContent = `${select.selectedIndex + 1} / ${select.options.length}`;
    if (page) {
      sheet.style.cssText = "display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px";
      for (const key of page.keys) {
        const frame = getFrame(key);
        const card = document.createElement("article");
        card.dataset["assetKey"] = key;
        card.style.cssText = "background:var(--surface);border:1px solid var(--border);padding:8px;min-width:0";
        const title = document.createElement("h2");
        title.textContent = key;
        title.style.cssText = "font:12px/16px monospace;margin:0;overflow-wrap:anywhere";
        const size = document.createElement("div");
        size.textContent = `${frame.width} × ${frame.height} / ${frame.palette}`;
        size.style.cssText = "font-size:11px;line-height:16px;color:var(--muted)";
        const previews = document.createElement("div");
        previews.style.cssText = "display:flex;gap:8px;align-items:flex-start;justify-content:flex-start";
        for (const scale of [1, 4] as const) {
          const figure = document.createElement("figure");
          figure.style.margin = "0";
          const label = document.createElement("figcaption");
          label.textContent = `${scale}x`;
          label.style.cssText = "font-size:11px;line-height:16px";
          const canvas = document.createElement("canvas");
          canvas.width = scale === 1 ? 40 : 144;
          canvas.height = scale === 1 ? 56 : 200;
          canvas.style.cssText = `display:block;image-rendering:pixelated;width:${canvas.width}px;height:${canvas.height}px`;
          canvas.setAttribute("aria-label", `${key} ${scale}x ${page.theme}`);
          canvas.dataset["key"] = key;
          canvas.dataset["scale"] = String(scale);
          canvas.dataset["theme"] = page.theme;
          const context = canvasContext(canvas);
          context.fillStyle = THEME_BACKGROUNDS[page.theme];
          context.fillRect(0, 0, canvas.width, canvas.height);
          drawSprite(context, { key, x: canvas.width / (2 * scale),
            y: (canvas.height - 4) / scale - (frame.height - frame.anchor.y) },
          { theme: page.theme, scale, editorPreview: true });
          figure.append(label, canvas);
          previews.append(figure);
        }
        card.append(title, size, previews);
        sheet.append(card);
      }
    } else {
      sheet.style.cssText = "display:block";
      for (const theme of WORLD_THEMES) for (const scale of [1, 4] as const) {
        if (select.value !== `scene-${theme}-${scale}`) continue;
        const canvas = document.createElement("canvas");
        canvas.dataset["testid"] = "asset-composition";
        canvas.dataset["theme"] = theme;
        canvas.dataset["scale"] = String(scale);
        canvas.setAttribute("aria-label", `${theme} 합성 ${scale}x`);
        renderScene(canvas, { theme, camera: { x: 0, y: 0 }, sprites: COMPOSITION_SPRITES }, scale);
        drawComposition(canvas, theme, scale);
        sheet.append(canvas);
      }
    }
    root.dispatchEvent(new CustomEvent("asset-gallery-page", { detail: select.value, bubbles: true }));
  }
  select.addEventListener("change", show);
  previous.onclick = () => { select.selectedIndex--; show(); };
  next.onclick = () => { select.selectedIndex++; show(); };
  show();
  return () => { select.removeEventListener("change", show); previous.onclick = null; next.onclick = null; root.replaceChildren(); };
}
function drawComposition(canvas: HTMLCanvasElement, theme: WorldTheme, scale: PixelScale): void {
  const context = canvasContext(canvas);
  drawPipe(context, { x: 152, y: 208, heightCells: 3 }, { theme, scale });
  drawPlatform(context, { x: 112, y: 112, length: 3 }, { theme, scale });
  drawPole(context, { x: 192, y: 208, heightCells: 9 }, { theme, scale });
  drawSprite(context, { key: "decor.flag", x: 184, y: 88 }, { theme, scale });
}
