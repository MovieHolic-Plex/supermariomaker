import type { PaintTool } from "../editor/paint";
import { EDITOR_ZOOMS, type EditorZoom } from "../editor/viewport";

export interface ToolbarOptions {
  readonly title: string;
  readonly signal: AbortSignal;
  readonly onTitleDraft: (title: string) => void;
  readonly onZoom: (zoom: EditorZoom) => void;
  readonly onHome: () => void;
  readonly onGrid: (visible: boolean) => void;
  readonly onTool: (tool: PaintTool) => void;
  readonly onUndo: () => void;
  readonly onRedo: () => void;
}
export function createToolbar(document: Document, options: ToolbarOptions) {
  const header = document.createElement("header"); header.className = "editor-header"; header.dataset["testid"] = "editor-toolbar";
  header.innerHTML = `<div class="editor-brand"><span class="editor-brand-mark" aria-hidden="true">M</span><div><strong>코스 메이커</strong><small>워크스페이스 · 미리보기</small></div></div>
    <label class="editor-title-label">코스 제목 <span>입력 초안 · 원본에 반영되지 않음</span><input data-testid="course-title" maxlength="80" autocomplete="off" spellcheck="false"></label>
    <div class="editor-header-actions"><button type="button" data-testid="export-course" disabled>내보내기</button><button type="button" data-testid="play-start" class="editor-play" disabled>▶ 플레이</button></div>`;
  const title = header.querySelector("input");
  if (!title) throw new Error("Editor title input missing");
  title.value = options.title;
  title.addEventListener("input", () => options.onTitleDraft(title.value), { signal: options.signal });
  const tools = document.createElement("nav"); tools.className = "editor-tools"; tools.dataset["testid"] = "editor-tools"; tools.setAttribute("aria-label", "편집 도구와 보기 설정");
  const group = document.createElement("div"); group.className = "editor-tool-group";
  const buttons = new Map<string, HTMLButtonElement>();
  for (const [id, label] of [["tool-paint", "그리기"], ["tool-erase", "지우기"], ["tool-fill", "채우기"], ["tool-select", "선택"], ["undo", "실행 취소"], ["redo", "다시 실행"]]) {
    const button = document.createElement("button"); button.type = "button"; button.dataset["testid"] = id; button.textContent = label ?? "";
    if (id === "tool-select") {
      button.disabled = true; button.title = "선택 도구는 아직 사용할 수 없습니다";
    } else if (id === "undo" || id === "redo") {
      button.disabled = true; button.title = id === "undo" ? "실행 취소 (Ctrl+Z)" : "다시 실행 (Ctrl+Y)";
      button.addEventListener("click", id === "undo" ? options.onUndo : options.onRedo, { signal: options.signal });
    } else {
      const tool: PaintTool = id === "tool-paint" ? "paint" : id === "tool-erase" ? "erase" : "fill";
      button.title = label ?? "";
      button.addEventListener("click", () => options.onTool(tool), { signal: options.signal });
    }
    group.append(button); buttons.set(id ?? "", button);
  }
  const viewing = document.createElement("div"); viewing.className = "editor-tool-group";
  const home = document.createElement("button"); home.type = "button"; home.textContent = "시작 위치"; home.dataset["testid"] = "viewport-home";
  home.addEventListener("click", options.onHome, { signal: options.signal });
  const gridLabel = document.createElement("label"); gridLabel.className = "editor-grid-toggle";
  const grid = document.createElement("input"); grid.type = "checkbox"; grid.checked = true; grid.dataset["testid"] = "viewport-grid";
  grid.addEventListener("change", () => options.onGrid(grid.checked), { signal: options.signal }); gridLabel.append(grid, "격자");
  const zooms = document.createElement("div"); zooms.className = "editor-zooms"; zooms.setAttribute("role", "group"); zooms.setAttribute("aria-label", "화면 배율");
  const zoomButtons = EDITOR_ZOOMS.map(zoom => {
    const button = document.createElement("button"); button.type = "button"; button.textContent = `${zoom}×`; button.dataset["testid"] = `zoom-${zoom}`; button.setAttribute("aria-label", `${zoom}배 확대`);
    button.addEventListener("click", () => options.onZoom(zoom), { signal: options.signal }); zooms.append(button); return { button, zoom };
  });
  viewing.append(home, gridLabel, zooms); tools.append(group, viewing);
  return { header, tools, setTitle(value: string) { title.value = value; }, setZoom(value: EditorZoom) {
    for (const { button, zoom } of zoomButtons) button.setAttribute("aria-pressed", String(value === zoom));
  }, setTool(tool: PaintTool | null) {
    for (const [id, value] of [["tool-paint", "paint"], ["tool-erase", "erase"], ["tool-fill", "fill"]] as const) {
      buttons.get(id)?.setAttribute("aria-pressed", String(tool === value));
    }
  }, setHistory(counts: Readonly<{ undo: number; redo: number }>) {
    const undo = buttons.get("undo"), redo = buttons.get("redo");
    if (undo) undo.disabled = counts.undo === 0;
    if (redo) redo.disabled = counts.redo === 0;
  } };
}
