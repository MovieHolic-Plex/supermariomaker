import { getFrame } from "../assets/manifest";
import { CATALOG_CATEGORIES, OBJECT_CATALOG, SPAWNED_CATALOG, TILE_CATALOG, type SpawnedKind } from "../level/catalog";
import type { AreaV1, CourseV1, ObjectKind, TileKind } from "../level/types";
import { canvasContext, drawSprite } from "../render/assets";

export type PaletteKind = TileKind | ObjectKind | SpawnedKind;
export const EDITOR_CATALOG = { ...TILE_CATALOG, ...OBJECT_CATALOG, ...SPAWNED_CATALOG };
export const EDITOR_THEMES = { overworld: "지상", underground: "지하", underwater: "수중", castle: "성" } as const;

/** Uses the production atlas renderer; CSS enlarges its logical pixels. */
export function catalogIcon(document: Document, kind: PaletteKind, theme: AreaV1["theme"], size = 40): HTMLCanvasElement {
  const entry = EDITOR_CATALOG[kind], frame = getFrame(entry.assetKey);
  const canvas = document.createElement("canvas"); canvas.width = Math.max(32, frame.width); canvas.height = Math.max(32, frame.height);
  canvas.style.width = `${size}px`; canvas.style.height = `${size}px`; canvas.setAttribute("aria-hidden", "true");
  drawSprite(canvasContext(canvas), { key: entry.assetKey, x: (canvas.width - frame.width) / 2 + frame.anchor.x, y: (canvas.height - frame.height) / 2 + frame.anchor.y }, { theme, editorPreview: true });
  return canvas;
}

export function renderInspector(root: HTMLElement, course: CourseV1, area: AreaV1, kind: PaletteKind): void {
  const document = root.ownerDocument, entry = EDITOR_CATALOG[kind];
  root.replaceChildren();
  const heading = document.createElement("h2"); heading.textContent = "속성 미리보기";
  const subheading = document.createElement("p"); subheading.className = "editor-eyebrow"; subheading.textContent = `${CATALOG_CATEGORIES[entry.category]} / ${entry.placeable ? "배치 요소" : "자동 생성 요소"}`;
  const hero = document.createElement("div"); hero.className = "editor-inspector-hero";
  const name = document.createElement("h3"); name.textContent = entry.label; name.dataset["testid"] = "preview-kind"; name.dataset["kind"] = kind;
  hero.append(catalogIcon(document, kind, area.theme, 80), name);
  const properties = document.createElement("dl"); properties.className = "editor-facts";
  const row = (label: string, value: string) => { const dt = document.createElement("dt"), dd = document.createElement("dd"); dt.textContent = label; dd.textContent = value; properties.append(dt, dd); };
  row("기준 격자", "16 × 16 px");
  // Read the actual catalog defaults. Reference-dependent defaults have no fabricated preview values.
  if ("defaults" in entry && typeof entry.defaults !== "function") {
    for (const [key, value] of Object.entries(entry.defaults)) {
      const field = Object.entries(entry.properties).find(([name]) => name === key)?.[1];
      row(field?.label ?? key, typeof value === "object" ? JSON.stringify(value) : String(value));
    }
  } else row("기본 속성", kind === "piranha" ? "연결할 토관이 필요합니다" : "배치 위치에서 결정됩니다");
  const notice = document.createElement("p"); notice.className = "editor-notice"; notice.textContent = "팔레트 선택은 미리보기입니다. 배치와 속성 변경은 아직 지원하지 않습니다.";
  const areaHeading = document.createElement("h3"); areaHeading.className = "editor-section-heading"; areaHeading.textContent = "현재 영역";
  const areaInfo = document.createElement("dl"); areaInfo.className = "editor-facts";
  for (const [label, value] of [["이름", area.name], ["테마", EDITOR_THEMES[area.theme]], ["크기", `${area.width} × ${area.height}칸`], ["배치", `타일 ${area.tiles.length} · 오브젝트 ${area.objects.length}`], ["제한 시간", course.timerSeconds === 0 ? "무제한" : `${course.timerSeconds}초`]]) {
    const dt = document.createElement("dt"), dd = document.createElement("dd"); dt.textContent = label ?? ""; dd.textContent = value ?? ""; areaInfo.append(dt, dd);
  }
  root.append(heading, subheading, hero, properties, notice, areaHeading, areaInfo);
}
