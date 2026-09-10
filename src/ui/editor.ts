import { createClipboard, type Clipboard } from "../editor/clipboard";
import { placeObject } from "../editor/commands";
import { createHistory, type EditorHistory } from "../editor/history";
import { beginPaintGesture, type PaintBrush, type PaintGesture, type PaintTool } from "../editor/paint";
import {
  beginMarqueeGesture, beginMoveGesture, commitCourseProperties, deleteSelection, emptySelection,
  objectsInRect, sanitizeSelection, type EditorSelection, type MarqueeGesture, type MoveGesture,
} from "../editor/selection";
import { backingTransform, canvasSize, EDITOR_ZOOMS, panViewport, screenToWorld, worldToCell, zoomViewport } from "../editor/viewport";
import type { EditorZoom, Point, Viewport } from "../editor/viewport";
import { CATALOG_CATEGORIES, OBJECT_CATALOG, TILE_CATALOG, type CatalogCategory, type ObjectRequest } from "../level/catalog";
import type { AreaV1, BlockContent, CourseV1, ObjectKind, TileKind } from "../level/types";
import { objectBounds, validateCourse } from "../level/validate";
import { canvasContext } from "../render/assets";
import { GAME_VIEWPORT } from "../render/renderer";
import { renderCoursePreview } from "./course-preview";
import { EDITOR_CSS } from "./editor-style";
import { catalogIcon, EDITOR_CATALOG, EDITOR_THEMES, renderInspector, type InspectorHost, type PaletteKind } from "./inspector";
import { createToolbar, type EditorTool } from "./toolbar";

export type EditorSaveStatus = "unsupported" | "saved" | "dirty" | "failed" | "unavailable";
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
  readonly tool: EditorTool | null;
  readonly undoCount: number;
  readonly redoCount: number;
  readonly dirty: boolean;
  readonly lastOutcome: "committed" | "noop" | "rejected" | "cancelled" | null;
  readonly preview: Readonly<{ cells: number; clipped: boolean; outOfBounds: boolean }> | null;
  readonly saveStatus: EditorSaveStatus;
  readonly saveErrorKind: string | null;
  readonly saveRecovery: readonly string[] | null;
  readonly selection: EditorSelection;
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
  readonly onAuthoredChange?: (course: CourseV1) => void;
  readonly onSaveRetry?: () => void;
}
export interface EditorView {
  readonly element: HTMLElement;
  getState(): EditorViewState;
  getCourseSnapshot(): CourseV1;
  /** Host supplies the next fully validated authoring result; this is not a document writer. */
  setCourse(course: CourseV1): void;
  setViewport(viewport: Viewport): void;
  setSaveStatus(status: EditorSaveStatus, detail?: Readonly<{ errorKind?: string | null; recovery?: readonly string[] | null }>): void;
  dispose(): void;
}

function tileBrush(kind: PaletteKind): PaintBrush | null {
  if (!Object.hasOwn(TILE_CATALOG, kind)) return null;
  const tile = kind as TileKind, defaults = TILE_CATALOG[tile].defaults;
  return Object.hasOwn(defaults, "content") ? { kind: tile, content: (defaults as { content: BlockContent }).content } : { kind: tile };
}
function typingTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement
    || (target instanceof HTMLElement && target.isContentEditable);
}
function isPaintTool(tool: EditorTool | null): tool is PaintTool {
  return tool === "paint" || tool === "erase" || tool === "fill";
}
function isObjectKind(kind: PaletteKind): kind is ObjectKind {
  return Object.hasOwn(OBJECT_CATALOG, kind);
}
function snapObject(point: Point): Point {
  return { x: Math.round(point.x / 16) * 16, y: Math.round(point.y / 16) * 16 };
}
function snapStart(point: Point): Point {
  return { x: Math.floor(point.x / 16) * 16 + 8, y: Math.floor(point.y / 16) * 16 + 16 };
}

/** Native, static editor core. No simulation, persistence, or global QA registration. */
export function mountEditor(root: HTMLElement, options: EditorViewOptions): EditorView {
  const document = root.ownerDocument, window = document.defaultView;
  if (!window) throw new Error("Editor view requires a window");
  const events = new AbortController(), listener = { signal: events.signal };
  let history: EditorHistory = createHistory(options.course);
  const clipboard: Clipboard = createClipboard();
  const inspectorHost: InspectorHost = {
    get history() { return history; },
    createId: () => globalThis.crypto.randomUUID(),
    onCommitted(selectAreaId) {
      lastOutcome = "committed";
      course = history.document();
      if (selectAreaId && course.areas.some(item => item.id === selectAreaId)) area = selectedArea(selectAreaId);
      selection = sanitizeSelection(selection, course);
      applyDocument(); render("command"); options.onAuthoredChange?.(history.document());
    },
    onRejected() { lastOutcome = "rejected"; syncHistory(); render("command"); },
    onPlaceStart() { cancelGestures(); placing = "start"; publish("place-mode"); },
    onPlaceFlag() { cancelGestures(); placing = "flagGoal"; publish("place-mode"); },
    onPlaceCastle() { cancelGestures(); placing = "castleGoal"; publish("place-mode"); },
  };
  let course = history.document();
  let area: AreaV1 = selectedArea(course.mainAreaId);
  let view: Viewport = options.viewport ?? { x: -16, y: -16, zoom: 2 };
  let kind: PaletteKind = "ground", category: CatalogCategory = "terrain", titleDraft = course.title;
  let grid = true, space = false, pointer: Point | null = null, hoveredCell: Point | null = null;
  let zoomAnchor: Point | null = null;
  let size = { width: 0, height: 0 }, dpr = window.devicePixelRatio;
  let drag: Readonly<{ id: number; start: Point; view: Viewport }> | null = null;
  let paint: Readonly<{ id: number; gesture: PaintGesture }> | null = null;
  let marquee: Readonly<{ id: number; gesture: MarqueeGesture }> | null = null;
  let moving: Readonly<{ id: number; gesture: MoveGesture }> | null = null;
  let tool: EditorTool | null = null, lastOutcome: EditorViewState["lastOutcome"] = null;
  let selection: EditorSelection = emptySelection(course.mainAreaId);
  let placing: "start" | "flagGoal" | "castleGoal" | null = null;
  let saveStatus: EditorSaveStatus = "unsupported", saveErrorKind: string | null = null, saveRecovery: readonly string[] | null = null;
  let disposed = false;
  const chunks = new Map<string, HTMLCanvasElement>();
  const panel = document.createElement("main"); panel.className = "editor-view"; panel.dataset["testid"] = "editor-view"; panel.setAttribute("aria-label", "코스 편집기 미리보기");
  const style = document.createElement("style"); style.textContent = EDITOR_CSS;
  const toolbar = createToolbar(document, {
    title: course.title, signal: events.signal,
    onTitleDraft: value => { titleDraft = value; options.onTitleDraft?.(value); publish("title-draft"); },
    onTitleCommit: value => {
      const outcome = commitCourseProperties(history, { title: value });
      lastOutcome = outcome.status;
      if (outcome.status === "committed") {
        applyDocument(); titleDraft = history.document().title; toolbar.setTitle(titleDraft);
        render("command"); options.onAuthoredChange?.(history.document());
      } else publish("command");
    },
    onZoom: zoom => changeZoom(zoom), onHome: home,
    onGrid: value => { grid = value; render("grid"); },
    onTool: next => { cancelGestures(); tool = next; placing = null; toolbar.setTool(tool); publish("tool"); },
    onUndo: () => undo(), onRedo: () => redo(),
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
  const paletteNote = document.createElement("p"); paletteNote.className = "editor-palette-note"; paletteNote.textContent = "타일은 그리기·지우기·채우기, 오브젝트는 그리기 클릭, 선택은 마퀴·이동";
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
  const caption = document.createElement("p"); caption.className = "editor-stage-caption"; caption.textContent = "선택 · Ctrl+C/V/Z/Y · Delete · Esc · 그리기/지우기/채우기";
  stage.append(stageHeader, wrap, caption);
  const inspector = document.createElement("aside"); inspector.className = "editor-inspector"; inspector.dataset["testid"] = "properties"; inspector.setAttribute("aria-label", "요소 속성 미리보기");
  workspace.append(palette, stage, inspector);
  const status = document.createElement("footer"); status.className = "editor-status"; status.dataset["testid"] = "editor-status";
  const statusNote = document.createElement("span"); statusNote.className = "editor-status-note"; statusNote.dataset["testid"] = "save-status";
  const saveLabel = document.createElement("span");
  const saveRetry = document.createElement("button"); saveRetry.type = "button"; saveRetry.dataset["testid"] = "save-retry"; saveRetry.textContent = "다시 시도"; saveRetry.hidden = true;
  saveRetry.addEventListener("click", () => options.onSaveRetry?.(), listener);
  statusNote.append(saveLabel);
  const coordinates = document.createElement("output"); coordinates.dataset["testid"] = "viewport-status";
  status.append(statusNote, coordinates); panel.append(style, toolbar.header, toolbar.tools, workspace, status); root.replaceChildren(panel);

  function selectedArea(id: string): AreaV1 {
    const result = course.areas.find(item => item.id === id);
    if (!result) throw new Error("Validated editor area missing");
    return result;
  }
  function historyCounts() { return history.snapshot(); }
  function livePreview() {
    if (!paint) return null;
    const preview = paint.gesture.preview(course);
    return { cells: preview.cells.length, clipped: preview.clipped, outOfBounds: preview.outOfBounds };
  }
  function getState(): EditorViewState {
    const snap = historyCounts();
    return {
      areaId: area.id, viewport: { ...view }, paletteKind: kind, titleDraft, hoveredCell: hoveredCell && { ...hoveredCell },
      grid, panning: drag !== null, size: { ...size }, dpr, tool, undoCount: snap.undoCount, redoCount: snap.redoCount,
      dirty: snap.dirty, lastOutcome, preview: livePreview(),
      saveStatus, saveErrorKind, saveRecovery,
      selection: { areaId: selection.areaId, objectIds: [...selection.objectIds] },
    };
  }
  function publish(reason: string): void {
    panel.dispatchEvent(new CustomEvent("editor-view-state", { bubbles: true, detail: { reason, ...getState() } }));
  }
  function renderSave(): void {
    statusNote.dataset["status"] = saveStatus;
    saveLabel.textContent = saveStatus === "saved" ? "저장됨"
      : saveStatus === "dirty" ? "편집됨"
      : saveStatus === "failed" ? "저장 실패"
      : saveStatus === "unavailable" ? "로컬 저장 불가"
      : historyCounts().dirty ? "편집됨 · 저장 미지원" : "원본과 동일 · 저장 미지원";
    const retry = saveStatus === "failed" && saveRecovery?.includes("retry") === true;
    if (retry) { saveRetry.hidden = false; if (!saveRetry.isConnected) statusNote.append(saveRetry); saveRetry.disabled = false; }
    else saveRetry.remove();
  }
  function syncHistory(): void {
    const snap = historyCounts();
    toolbar.setHistory({ undo: snap.undoCount, redo: snap.redoCount });
    if (saveStatus === "unsupported") renderSave();
  }
  function applyDocument(): void {
    course = history.document();
    const keep = course.areas.some(item => item.id === area.id);
    area = selectedArea(keep ? area.id : course.mainAreaId);
    selection = keep ? sanitizeSelection(selection, course) : emptySelection(area.id);
    chunks.clear(); updateAreas(); updatePalette(); syncHistory(); renderInspector(inspector, course, area, kind, inspectorHost);
  }
  function undo(): void {
    cancelGestures(); if (!history.undo()) return; lastOutcome = null; applyDocument(); render("undo");
    options.onAuthoredChange?.(history.document());
  }
  function redo(): void {
    cancelGestures(); if (!history.redo()) return; lastOutcome = null; applyDocument(); render("redo");
    options.onAuthoredChange?.(history.document());
  }
  function cancelGestures(): void {
    if (paint) { paint.gesture.cancel(); const id = paint.id; paint = null; lastOutcome = "cancelled"; if (canvas.hasPointerCapture(id)) canvas.releasePointerCapture(id); }
    if (marquee) { marquee.gesture.cancel(); const id = marquee.id; marquee = null; if (canvas.hasPointerCapture(id)) canvas.releasePointerCapture(id); }
    if (moving) { moving.gesture.cancel(); const id = moving.id; moving = null; lastOutcome = "cancelled"; if (canvas.hasPointerCapture(id)) canvas.releasePointerCapture(id); }
  }
  function cancelPaint(): void {
    if (!paint && !marquee && !moving) return;
    cancelGestures();
    render("paint-cancel");
  }
  function finishPaint(reason: "paint-commit"): void {
    if (!paint) return;
    const outcome = paint.gesture.commit(history);
    const id = paint.id; paint = null;
    if (canvas.hasPointerCapture(id)) canvas.releasePointerCapture(id);
    lastOutcome = outcome.status;
    if (outcome.status === "committed") applyDocument();
    else syncHistory();
    render(reason);
    if (outcome.status === "committed") options.onAuthoredChange?.(history.document());
  }
  function finishMarquee(): void {
    if (!marquee) return;
    selection = marquee.gesture.commit(course);
    const id = marquee.id; marquee = null;
    if (canvas.hasPointerCapture(id)) canvas.releasePointerCapture(id);
    render("marquee-commit");
  }
  function finishMove(): void {
    if (!moving) return;
    const outcome = moving.gesture.commit(history);
    const id = moving.id; moving = null;
    if (canvas.hasPointerCapture(id)) canvas.releasePointerCapture(id);
    if (outcome.status === "cancelled") lastOutcome = "cancelled";
    else lastOutcome = outcome.status;
    if (outcome.status === "committed") { applyDocument(); options.onAuthoredChange?.(history.document()); }
    else syncHistory();
    render("move-commit");
  }
  function applyOutcome(outcome: { status: "committed" | "noop" | "rejected" }, reason: string): void {
    lastOutcome = outcome.status;
    if (outcome.status === "committed") { applyDocument(); render(reason); options.onAuthoredChange?.(history.document()); }
    else { syncHistory(); render(reason); }
  }
  function placeAt(world: Point): void {
    const mode = placing; placing = null;
    if (mode === "start") {
      const start = snapStart(world);
      applyOutcome(history.commit(validateCourse({ ...history.document(), start: { areaId: area.id, x: start.x, y: start.y } })), "command");
      return;
    }
    if (mode === "flagGoal" || mode === "castleGoal") {
      const point = snapObject(world);
      applyOutcome(history.commit(placeObject(history.document(), area.id, { id: inspectorHost.createId(), kind: mode, x: point.x, y: point.y })), "command");
      return;
    }
    if (tool === "paint" && isObjectKind(kind) && kind !== "piranha") {
      const point = snapObject(world);
      const request = { id: inspectorHost.createId(), kind, x: point.x, y: point.y } as ObjectRequest;
      applyOutcome(history.commit(placeObject(history.document(), area.id, request)), "command");
    }
  }
  function copySelection(): void { clipboard.copy(history.document(), selection); render("copy"); }
  function cutSelection(): void {
    const cut = clipboard.cut(history, selection);
    lastOutcome = cut.outcome.status;
    selection = sanitizeSelection(selection, history.document());
    if (cut.outcome.status === "committed") { applyDocument(); render("cut"); options.onAuthoredChange?.(history.document()); }
    else { syncHistory(); render("cut"); }
  }
  function pasteClipboard(): void {
    const world = pointer ? screenToWorld(pointer, view, canvas.getBoundingClientRect()) : null;
    const first = clipboard.contents()?.objects[0];
    const delta = world && first
      ? { dx: Math.round((world.x - first.x) / 16) * 16, dy: Math.round((world.y - first.y) / 16) * 16 }
      : { dx: 16, dy: 0 };
    const pasted = clipboard.paste(history, area.id, delta, () => globalThis.crypto.randomUUID());
    lastOutcome = pasted.outcome.status;
    if (pasted.outcome.status === "committed") {
      applyDocument();
      render("paste");
      options.onAuthoredChange?.(history.document());
    } else { syncHistory(); render("paste"); }
  }
  function duplicateSelection(): void {
    const duplicated = clipboard.duplicate(history, selection, () => globalThis.crypto.randomUUID());
    lastOutcome = duplicated.outcome.status;
    if (duplicated.outcome.status === "committed") { applyDocument(); render("duplicate"); options.onAuthoredChange?.(history.document()); }
    else { syncHistory(); render("duplicate"); }
  }
  function removeSelection(): void {
    const outcome = deleteSelection(history, selection);
    lastOutcome = outcome.status;
    selection = sanitizeSelection(selection, history.document());
    if (outcome.status === "committed") { applyDocument(); render("delete"); options.onAuthoredChange?.(history.document()); }
    else { syncHistory(); render("delete"); }
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
        renderInspector(inspector, course, area, kind, inspectorHost); options.onPalettePreview?.(kind); publish("palette");
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
    if (paint) {
      const preview = paint.gesture.preview(course);
      context.fillStyle = preview.outOfBounds ? "#ff33cc99" : tool === "erase" ? "#1b1b1b99" : "#3ad0ff99";
      context.strokeStyle = preview.outOfBounds ? "#ff79e8" : "#f4fbff";
      context.lineWidth = 2 / view.zoom;
      for (const cell of preview.cells) { context.fillRect(cell.x * 16, cell.y * 16, 16, 16); context.strokeRect(cell.x * 16, cell.y * 16, 16, 16); }
    } else if (hoveredCell && hoveredCell.x >= 0 && hoveredCell.y >= 0 && hoveredCell.x < area.width && hoveredCell.y < area.height && !drag && !marquee && !moving) {
      context.fillStyle = "#fff2aa30"; context.fillRect(hoveredCell.x * 16, hoveredCell.y * 16, 16, 16);
      context.strokeStyle = "#fff0a1"; context.lineWidth = 2 / view.zoom; context.strokeRect(hoveredCell.x * 16, hoveredCell.y * 16, 16, 16);
    }
    const movePreview = moving ? moving.gesture.preview(course) : null;
    const dx = movePreview?.dx ?? 0, dy = movePreview?.dy ?? 0;
    context.lineWidth = 2 / view.zoom;
    for (const id of selection.objectIds) {
      const object = area.objects.find(item => item.id === id);
      if (!object) continue;
      const box = objectBounds(object);
      context.strokeStyle = movePreview && !movePreview.valid ? "#ff79e8" : "#3ad0ff";
      context.fillStyle = movePreview && !movePreview.valid ? "#ff33cc33" : "#3ad0ff33";
      context.fillRect(box.x + dx, box.y + dy, box.width, box.height);
      context.strokeRect(box.x + dx, box.y + dy, box.width, box.height);
    }
    if (marquee) {
      const rect = marquee.gesture.preview();
      const x = Math.min(rect.x0, rect.x1), y = Math.min(rect.y0, rect.y1);
      context.strokeStyle = "#f4fbff"; context.fillStyle = "#3ad0ff33";
      context.fillRect(x, y, Math.abs(rect.x1 - rect.x0), Math.abs(rect.y1 - rect.y0));
      context.strokeRect(x, y, Math.abs(rect.x1 - rect.x0), Math.abs(rect.y1 - rect.y0));
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
  function clearInput(): void { if (paint || marquee || moving) cancelPaint(); space = false; releaseDrag(); render("input-clear"); }
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
      if (placing) { event.preventDefault(); placeAt(world); return; }
      if (tool === "select") {
        event.preventDefault();
        const hits = objectsInRect(course, area.id, { x0: world.x, y0: world.y, x1: world.x, y1: world.y });
        const movingHit = hits.some(object => selection.objectIds.includes(object.id));
        if (movingHit && selection.objectIds.length > 0) {
          moving = { id: event.pointerId, gesture: beginMoveGesture({ objectIds: selection.objectIds, origin: world }) };
          canvas.setPointerCapture(event.pointerId); render("move-start");
        } else {
          marquee = { id: event.pointerId, gesture: beginMarqueeGesture({ areaId: area.id, origin: world }) };
          canvas.setPointerCapture(event.pointerId); render("marquee-start");
        }
        return;
      }
      const brush = tileBrush(kind);
      if (isPaintTool(tool) && brush) {
        event.preventDefault();
        paint = { id: event.pointerId, gesture: beginPaintGesture({ areaId: area.id, tool, brush, origin: cell }) };
        canvas.setPointerCapture(event.pointerId); render("paint-start");
      } else if (tool === "paint" && isObjectKind(kind) && kind !== "piranha") {
        event.preventDefault(); placeAt(world);
      } else render("point");
    }
  }, listener);
  canvas.addEventListener("pointermove", event => {
    pointer = { x: event.clientX, y: event.clientY }; zoomAnchor = pointer;
    if (paint && paint.id === event.pointerId) {
      paint.gesture.extend(worldToCell(screenToWorld(pointer, view, canvas.getBoundingClientRect())));
      render("paint-extend"); return;
    }
    if (marquee && marquee.id === event.pointerId) {
      marquee.gesture.extend(screenToWorld(pointer, view, canvas.getBoundingClientRect()));
      render("marquee-extend"); return;
    }
    if (moving && moving.id === event.pointerId) {
      moving.gesture.extend(screenToWorld(pointer, view, canvas.getBoundingClientRect()));
      render("move-extend"); return;
    }
    if (drag && drag.id === event.pointerId) { view = panViewport(drag.view, { x: pointer.x - drag.start.x, y: pointer.y - drag.start.y }); options.onViewportChange?.({ ...view }); }
    render(drag ? "pan" : "pointer");
  }, listener);
  canvas.addEventListener("pointerup", event => {
    if (paint?.id === event.pointerId) { finishPaint("paint-commit"); return; }
    if (marquee?.id === event.pointerId) { finishMarquee(); return; }
    if (moving?.id === event.pointerId) { finishMove(); return; }
    if (drag?.id === event.pointerId) { releaseDrag(); render("pan-end"); }
  }, listener);
  canvas.addEventListener("pointercancel", clearInput, listener);
  canvas.addEventListener("lostpointercapture", () => {
    if (paint) finishPaint("paint-commit");
    else if (marquee) finishMarquee();
    else if (moving) finishMove();
    drag = null; render("pan-end");
  }, listener);
  canvas.addEventListener("pointerleave", () => { if (!drag && !paint && !marquee && !moving) { pointer = null; render("pointer-leave"); } }, listener);
  canvas.addEventListener("auxclick", event => { if (event.button === 1) event.preventDefault(); }, listener);
  canvas.addEventListener("wheel", event => {
    if (event.ctrlKey || event.metaKey || event.deltaY === 0) return;
    event.preventDefault(); pointer = { x: event.clientX, y: event.clientY }; zoomAnchor = pointer;
    const zoom = EDITOR_ZOOMS[Math.max(0, Math.min(EDITOR_ZOOMS.length - 1, EDITOR_ZOOMS.indexOf(view.zoom) + (event.deltaY < 0 ? 1 : -1)))];
    if (zoom !== undefined && zoom !== view.zoom) changeZoom(zoom, pointer);
  }, { ...listener, passive: false });
  window.addEventListener("keydown", event => {
    if (event.isComposing) return;
    if ((event.ctrlKey || event.metaKey) && !event.altKey && !typingTarget(event.target)) {
      if (event.code === "KeyZ" && !event.shiftKey) { event.preventDefault(); undo(); return; }
      if (event.code === "KeyY" || (event.code === "KeyZ" && event.shiftKey)) { event.preventDefault(); redo(); return; }
      if (event.code === "KeyC") { event.preventDefault(); copySelection(); return; }
      if (event.code === "KeyX") { event.preventDefault(); cutSelection(); return; }
      if (event.code === "KeyV") { event.preventDefault(); pasteClipboard(); return; }
      if (event.code === "KeyD") { event.preventDefault(); duplicateSelection(); return; }
    }
    if (typingTarget(event.target)) return;
    if (event.code === "Delete" || event.code === "Backspace") { event.preventDefault(); removeSelection(); return; }
    if (document.activeElement !== canvas || event.ctrlKey || event.altKey || event.metaKey) return;
    if (event.code === "Escape" && (paint || marquee || moving)) {
      event.preventDefault();
      if (marquee) { marquee.gesture.cancel(); marquee = null; selection = emptySelection(area.id); render("select"); return; }
      if (moving) { moving.gesture.cancel(); moving = null; lastOutcome = "cancelled"; render("move-commit"); return; }
      cancelPaint(); return;
    }
    if (event.code === "Escape") { event.preventDefault(); selection = emptySelection(area.id); placing = null; render("select"); return; }
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
  areas.addEventListener("change", () => { clearInput(); area = selectedArea(areas.value); selection = emptySelection(area.id); chunks.clear(); updatePalette(); renderInspector(inspector, course, area, kind, inspectorHost); home(); }, listener);
  const observer = new ResizeObserver(resize); observer.observe(wrap);
  updateAreas(); updatePalette(); renderInspector(inspector, course, area, kind, inspectorHost); syncHistory(); toolbar.setTool(tool); resize();
  if (!options.viewport) home();
  function dispose(): void {
    if (disposed) return;
    disposed = true; releaseDrag(); events.abort(); observer.disconnect(); chunks.clear(); panel.remove();
  }
  window.addEventListener("pagehide", dispose, listener);
  return { element: panel, getState, getCourseSnapshot: () => structuredClone(history.document()),
    setCourse(next) {
      clearInput(); history = createHistory(next); course = history.document();
      area = selectedArea(course.areas.some(item => item.id === area.id) ? area.id : course.mainAreaId);
      selection = emptySelection(area.id); placing = null;
      titleDraft = course.title; toolbar.setTitle(course.title); lastOutcome = null; chunks.clear();
      updateAreas(); updatePalette(); renderInspector(inspector, course, area, kind, inspectorHost); syncHistory(); render("course");
    },
    setViewport(next) { clearInput(); view = { ...next }; render("viewport"); },
    setSaveStatus(status, detail) {
      saveStatus = status;
      saveErrorKind = detail?.errorKind ?? null;
      saveRecovery = detail?.recovery ?? null;
      renderSave();
      publish("save");
    },
    dispose,
  };
}
