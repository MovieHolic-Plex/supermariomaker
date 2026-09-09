import { backingTransform, canvasSize, EDITOR_ZOOMS, panViewport, screenToWorld, worldToCell, zoomViewport } from "../editor/viewport";
import type { EditorZoom, Point, Viewport } from "../editor/viewport";
import { CATALOG_CATEGORIES, type CatalogCategory } from "../level/catalog";
import type { AreaV1, CourseV1 } from "../level/types";
import { canvasContext } from "../render/assets";
import { GAME_VIEWPORT } from "../render/renderer";
import { renderCoursePreview } from "./course-preview";
import { EDITOR_CSS } from "./editor-style";
import { catalogIcon, EDITOR_CATALOG, EDITOR_THEMES, renderInspector, type PaletteKind } from "./inspector";
import { createToolbar } from "./toolbar";

export interface EditorViewState {
  readonly areaId: string;
  readonly viewport: Viewport;
  readonly paletteKind: PaletteKind;
  readonly titleDraft: string;
  readonly hoveredCell: Point | null;
  readonly grid: boolean;
  readonly panning: boolean;
  readonly size: Readonly<{ width: number; height: number }>;
  readonly dpr: number;
}
export interface EditorViewOptions {
  /** A validated document. The view takes a copy and never writes to the supplied Course. */
  readonly course: CourseV1;
  readonly viewport?: Viewport;
  readonly onTitleDraft?: (title: string) => void;
  readonly onPalettePreview?: (kind: PaletteKind) => void;
  readonly onViewportChange?: (viewport: Viewport) => void;
  /** Observation/proposal only: the host owns any eventual authoring command. */
  readonly onCanvasPoint?: (point: Readonly<{ areaId: string; world: Point; cell: Point }>) => void;
}
export interface EditorView {
  readonly element: HTMLElement;
  getState(): EditorViewState;
  getCourseSnapshot(): CourseV1;
  /** Host supplies the next fully validated authoring result; this is not a document writer. */
  setCourse(course: CourseV1): void;
  setViewport(viewport: Viewport): void;
  dispose(): void;
}

/** Native, static editor core. No simulation, history, persistence, or global QA registration. */
export function mountEditor(root: HTMLElement, options: EditorViewOptions): EditorView {
  const document = root.ownerDocument, window = document.defaultView;
  if (!window) throw new Error("Editor view requires a window");
  const events = new AbortController(), listener = { signal: events.signal };
  let course = structuredClone(options.course);
  let area: AreaV1 = selectedArea(course.mainAreaId);
  let view: Viewport = options.viewport ?? { x: -16, y: -16, zoom: 2 };
  let kind: PaletteKind = "ground", category: CatalogCategory = "terrain", titleDraft = course.title;
  let grid = true, space = false, pointer: Point | null = null, hoveredCell: Point | null = null;
  let zoomAnchor: Point | null = null;
  let size = { width: 0, height: 0 }, dpr = window.devicePixelRatio;
  let drag: Readonly<{ id: number; start: Point; view: Viewport }> | null = null;
  let disposed = false;
  const chunks = new Map<string, HTMLCanvasElement>();
  const panel = document.createElement("main"); panel.className = "editor-view"; panel.dataset["testid"] = "editor-view"; panel.setAttribute("aria-label", "코스 편집기 미리보기");
  const style = document.createElement("style"); style.textContent = EDITOR_CSS;
  const toolbar = createToolbar(document, {
    title: course.title, signal: events.signal,
    onTitleDraft: value => { titleDraft = value; options.onTitleDraft?.(value); publish("title-draft"); },
    onZoom: zoom => changeZoom(zoom), onHome: home,
    onGrid: value => { grid = value; render("grid"); },
  });
  const workspace = document.createElement("div"); workspace.className = "editor-workspace";
  const palette = document.createElement("aside"); palette.className = "editor-palette"; palette.dataset["testid"] = "editor-palette"; palette.setAttribute("aria-label", "요소 팔레트");
  palette.innerHTML = `<div class="editor-panel-heading"><h2>요소 팔레트</h2><p class="editor-eyebrow">픽셀 하나부터, 나만의 코스</p></div>`;
  const categories = document.createElement("div"); categories.className = "editor-categories"; categories.setAttribute("role", "group"); categories.setAttribute("aria-label", "팔레트 분류");
  const list = document.createElement("div"); list.className = "editor-palette-list";
  for (const [id, label] of Object.entries(CATALOG_CATEGORIES)) {
    const button = document.createElement("button"); button.type = "button"; button.textContent = label; button.dataset["testid"] = `category-${id}`; button.dataset["category"] = id;
    button.addEventListener("click", () => { category = id as CatalogCategory; updatePalette(); publish("category"); }, listener); categories.append(button);
  }
  const paletteNote = document.createElement("p"); paletteNote.className = "editor-palette-note"; paletteNote.textContent = "요소를 눌러 모양과 기본 속성 확인";
  palette.append(categories, list, paletteNote);
  const stage = document.createElement("section"); stage.className = "editor-stage"; stage.dataset["testid"] = "editor-stage"; stage.setAttribute("aria-label", "코스 작업 화면");
  const stageHeader = document.createElement("div"); stageHeader.className = "editor-stage-header";
  const areaLabel = document.createElement("label"); areaLabel.append("영역");
  const areas = document.createElement("select"); areas.dataset["testid"] = "area-select"; areaLabel.append(areas);
  const tag = document.createElement("span"); tag.className = "editor-stage-tag"; tag.textContent = "16 PX GRID · PREVIEW";
  stageHeader.append(areaLabel, tag);
  const wrap = document.createElement("div"); wrap.className = "editor-canvas-wrap";
  const canvas = document.createElement("canvas"); canvas.className = "editor-canvas"; canvas.dataset["testid"] = "editor-canvas"; canvas.tabIndex = 0;
  canvas.setAttribute("aria-label", "코스 화면. 가운데 버튼 또는 스페이스와 드래그로 이동, 휠 또는 숫자 1, 2, 4, 8로 확대. 방향키로 이동, Home으로 시작 위치.");
  wrap.append(canvas);
  const caption = document.createElement("p"); caption.className = "editor-stage-caption"; caption.textContent = "가운데 버튼 / Space + 드래그 이동 · 휠 확대 · 방향키 이동 · Home 시작 위치";
  stage.append(stageHeader, wrap, caption);
  const inspector = document.createElement("aside"); inspector.className = "editor-inspector"; inspector.dataset["testid"] = "properties"; inspector.setAttribute("aria-label", "요소 속성 미리보기");
  workspace.append(palette, stage, inspector);
  const status = document.createElement("footer"); status.className = "editor-status"; status.dataset["testid"] = "editor-status";
  const statusNote = document.createElement("span"); statusNote.className = "editor-status-note"; statusNote.dataset["testid"] = "save-status"; statusNote.textContent = "보기 전용 · 배치 / 저장 미지원 · 제목은 입력 초안";
  const coordinates = document.createElement("output"); coordinates.dataset["testid"] = "viewport-status";
  status.append(statusNote, coordinates); panel.append(style, toolbar.header, toolbar.tools, workspace, status); root.replaceChildren(panel);

  function selectedArea(id: string): AreaV1 {
    const result = course.areas.find(item => item.id === id);
    if (!result) throw new Error("Validated editor area missing");
    return result;
  }
  function getState(): EditorViewState {
    return { areaId: area.id, viewport: { ...view }, paletteKind: kind, titleDraft, hoveredCell: hoveredCell && { ...hoveredCell }, grid, panning: drag !== null, size: { ...size }, dpr };
  }
  function publish(reason: string): void {
    panel.dispatchEvent(new CustomEvent("editor-view-state", { bubbles: true, detail: { reason, ...getState() } }));
  }
  function updateAreas(): void {
    areas.replaceChildren(...course.areas.map(item => {
      const option = document.createElement("option"); option.value = item.id; option.textContent = `${item.name} · ${EDITOR_THEMES[item.theme]}`; return option;
    })); areas.value = area.id;
  }
  function updatePalette(): void {
    for (const button of categories.querySelectorAll("button")) button.setAttribute("aria-pressed", String(button.dataset["category"] === category));
    list.replaceChildren(...(Object.keys(EDITOR_CATALOG) as PaletteKind[]).filter(id => EDITOR_CATALOG[id].category === category).map(id => {
      const entry = EDITOR_CATALOG[id], button = document.createElement("button"), label = document.createElement("span");
      button.type = "button"; button.dataset["testid"] = `palette-${id}`; button.setAttribute("aria-pressed", String(kind === id));
      label.textContent = `${entry.label}${entry.placeable ? "" : " · 자동 생성"}`; button.append(catalogIcon(document, id, area.theme), label);
      button.addEventListener("click", () => {
        kind = id;
        for (const item of list.querySelectorAll("button")) item.setAttribute("aria-pressed", String(item === button));
        renderInspector(inspector, course, area, kind); options.onPalettePreview?.(kind); publish("palette");
      }, listener);
      return button;
    }));
  }
  function home(): void {
    const start = course.start.areaId === area.id ? course.start : { x: 40, y: 208 };
    view = { ...view, x: Math.max(-16, start.x - 56), y: Math.max(-16, start.y - size.height / view.zoom + 48) };
    pointer = null; zoomAnchor = null; render("home"); options.onViewportChange?.({ ...view });
  }
  function changeZoom(zoom: EditorZoom, anchor = zoomAnchor): void {
    const bounds = canvas.getBoundingClientRect();
    view = zoomViewport(view, zoom, anchor ?? { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 }, bounds);
    render("zoom"); options.onViewportChange?.({ ...view });
  }
  function render(reason: string): void {
    if (disposed || size.width === 0 || size.height === 0) return;
    const context = canvasContext(canvas), backing = canvasSize(size, dpr);
    if (canvas.width !== backing.width || canvas.height !== backing.height) { canvas.width = backing.width; canvas.height = backing.height; }
    context.setTransform(1, 0, 0, 1, 0, 0); context.fillStyle = "#24343c"; context.fillRect(0, 0, canvas.width, canvas.height);
    context.setTransform(...backingTransform(view, dpr)); context.imageSmoothingEnabled = false;
    const right = Math.min(area.width * 16, view.x + size.width / view.zoom), bottom = Math.min(area.height * 16, view.y + size.height / view.zoom);
    const left = Math.max(0, view.x), top = Math.max(0, view.y);
    const visible = new Set<string>();
    context.save(); context.beginPath(); context.rect(0, 0, area.width * 16, area.height * 16); context.clip();
    // Reuse the actual fixed-size preview renderer as logical chunks. Only visible chunks are retained.
    // This preserves all catalog-specific composition, hidden blocks, start marker, and poles without a second rasterizer.
    for (let y = Math.floor(top / GAME_VIEWPORT.height) * GAME_VIEWPORT.height; y < bottom; y += GAME_VIEWPORT.height) {
      for (let x = Math.floor(left / GAME_VIEWPORT.width) * GAME_VIEWPORT.width; x < right; x += GAME_VIEWPORT.width) {
        const key = `${x},${y}`; visible.add(key);
        let chunk = chunks.get(key);
        if (!chunk) { chunk = document.createElement("canvas"); renderCoursePreview(chunk, course, { area, camera: { x, y } }); chunks.set(key, chunk); }
        context.drawImage(chunk, x, y);
      }
    }
    for (const key of chunks.keys()) if (!visible.has(key)) chunks.delete(key);
    if (grid) {
      context.beginPath(); context.lineWidth = 1 / (view.zoom * dpr); context.strokeStyle = "#ffffff30";
      for (let x = Math.ceil(left / 16) * 16; x <= right; x += 16) { context.moveTo(x, top); context.lineTo(x, bottom); }
      for (let y = Math.ceil(top / 16) * 16; y <= bottom; y += 16) { context.moveTo(left, y); context.lineTo(right, y); }
      context.stroke();
    }
    hoveredCell = pointer ? worldToCell(screenToWorld(pointer, view, canvas.getBoundingClientRect())) : null;
    if (hoveredCell && hoveredCell.x >= 0 && hoveredCell.y >= 0 && hoveredCell.x < area.width && hoveredCell.y < area.height && !drag) {
      context.fillStyle = "#fff2aa30"; context.fillRect(hoveredCell.x * 16, hoveredCell.y * 16, 16, 16);
      context.strokeStyle = "#fff0a1"; context.lineWidth = 2 / view.zoom; context.strokeRect(hoveredCell.x * 16, hoveredCell.y * 16, 16, 16);
    }
    context.restore();
    context.strokeStyle = "#e6d8ab"; context.lineWidth = 1 / view.zoom; context.strokeRect(0, 0, area.width * 16, area.height * 16);
    toolbar.setZoom(view.zoom); canvas.dataset["pan"] = drag ? "active" : space ? "ready" : "idle";
    coordinates.textContent = `${hoveredCell ? `칸 ${hoveredCell.x}, ${hoveredCell.y} · ` : ""}카메라 ${view.x.toFixed(1)}, ${view.y.toFixed(1)} · ${view.zoom}× · ${area.width} × ${area.height}칸`;
    publish(reason);
  }
  function releaseDrag(): void {
    const id = drag?.id; drag = null;
    if (id !== undefined && canvas.hasPointerCapture(id)) canvas.releasePointerCapture(id);
  }
  function clearInput(): void { space = false; releaseDrag(); render("input-clear"); }
  function resize(): void {
    const bounds = canvas.getBoundingClientRect(); size = { width: bounds.width, height: bounds.height }; dpr = window?.devicePixelRatio ?? 1;
    render("resize");
  }
  canvas.addEventListener("pointerdown", event => {
    if (event.button !== 0 && event.button !== 1) return;
    canvas.focus({ preventScroll: true }); pointer = { x: event.clientX, y: event.clientY }; zoomAnchor = pointer;
    if (event.button === 1 || space) {
      event.preventDefault(); drag = { id: event.pointerId, start: pointer, view }; canvas.setPointerCapture(event.pointerId); render("pan-start");
    } else {
      const world = screenToWorld(pointer, view, canvas.getBoundingClientRect()), cell = worldToCell(world);
      if (cell.x >= 0 && cell.y >= 0 && cell.x < area.width && cell.y < area.height) options.onCanvasPoint?.({ areaId: area.id, world, cell });
      render("point");
    }
  }, listener);
  canvas.addEventListener("pointermove", event => {
    pointer = { x: event.clientX, y: event.clientY }; zoomAnchor = pointer;
    if (drag && drag.id === event.pointerId) { view = panViewport(drag.view, { x: pointer.x - drag.start.x, y: pointer.y - drag.start.y }); options.onViewportChange?.({ ...view }); }
    render(drag ? "pan" : "pointer");
  }, listener);
  canvas.addEventListener("pointerup", event => { if (drag?.id === event.pointerId) { releaseDrag(); render("pan-end"); } }, listener);
  canvas.addEventListener("pointercancel", clearInput, listener);
  canvas.addEventListener("lostpointercapture", () => { drag = null; render("pan-end"); }, listener);
  canvas.addEventListener("pointerleave", () => { if (!drag) { pointer = null; render("pointer-leave"); } }, listener);
  canvas.addEventListener("auxclick", event => { if (event.button === 1) event.preventDefault(); }, listener);
  canvas.addEventListener("wheel", event => {
    if (event.ctrlKey || event.metaKey || event.deltaY === 0) return;
    event.preventDefault(); pointer = { x: event.clientX, y: event.clientY }; zoomAnchor = pointer;
    const zoom = EDITOR_ZOOMS[Math.max(0, Math.min(EDITOR_ZOOMS.length - 1, EDITOR_ZOOMS.indexOf(view.zoom) + (event.deltaY < 0 ? 1 : -1)))];
    if (zoom !== undefined && zoom !== view.zoom) changeZoom(zoom, pointer);
  }, { ...listener, passive: false });
  window.addEventListener("keydown", event => {
    if (document.activeElement !== canvas || event.isComposing || event.ctrlKey || event.altKey || event.metaKey) return;
    if (event.code === "Space") { event.preventDefault(); space = true; render("space"); return; }
    if (event.repeat) return;
    const zoom = EDITOR_ZOOMS.find(value => event.key === String(value));
    if (zoom) { event.preventDefault(); changeZoom(zoom); return; }
    const directions: Readonly<Record<string, Point>> = { ArrowLeft: { x: 32, y: 0 }, ArrowRight: { x: -32, y: 0 }, ArrowUp: { x: 0, y: 32 }, ArrowDown: { x: 0, y: -32 } };
    const delta = directions[event.code];
    if (delta) { event.preventDefault(); view = panViewport(view, delta); render("key-pan"); options.onViewportChange?.({ ...view }); }
    else if (event.code === "Home") { event.preventDefault(); home(); }
    else if (event.code === "Escape") clearInput();
  }, listener);
  window.addEventListener("keyup", event => { if (event.code === "Space" && space) { if (document.activeElement === canvas) event.preventDefault(); clearInput(); } }, listener);
  canvas.addEventListener("blur", clearInput, listener); window.addEventListener("blur", clearInput, listener);
  document.addEventListener("visibilitychange", () => { if (document.hidden) clearInput(); }, listener);
  window.addEventListener("resize", resize, listener);
  areas.addEventListener("change", () => { clearInput(); area = selectedArea(areas.value); chunks.clear(); updatePalette(); renderInspector(inspector, course, area, kind); home(); }, listener);
  const observer = new ResizeObserver(resize); observer.observe(wrap);
  updateAreas(); updatePalette(); renderInspector(inspector, course, area, kind); resize();
  if (!options.viewport) home();
  function dispose(): void {
    if (disposed) return;
    disposed = true; releaseDrag(); events.abort(); observer.disconnect(); chunks.clear(); panel.remove();
  }
  window.addEventListener("pagehide", dispose, listener);
  return { element: panel, getState, getCourseSnapshot: () => structuredClone(course),
    setCourse(next) {
      clearInput(); course = structuredClone(next); area = selectedArea(course.areas.some(item => item.id === area.id) ? area.id : course.mainAreaId);
      titleDraft = course.title; toolbar.setTitle(course.title); chunks.clear(); updateAreas(); updatePalette(); renderInspector(inspector, course, area, kind); render("course");
    },
    setViewport(next) { clearInput(); view = { ...next }; render("viewport"); }, dispose,
  };
}
