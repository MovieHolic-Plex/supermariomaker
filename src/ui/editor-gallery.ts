import { createEditorSession, type EditorSession } from "../editor/session";
import type { EditorSelection } from "../editor/selection";
import type { Viewport } from "../editor/viewport";
import { FixedClock } from "../game/clock";
import { snapshot } from "../game/state";
import type { GameEvent } from "../game/state";
import { EMPTY_INPUT, attachInput, type PauseReason } from "../input";
import type { CourseStart, CourseV1, ValidationIssue } from "../level/types";
import { createAutosave, type AutosaveSession } from "../storage/autosave";
import type { DatabaseHandle } from "../storage/db";
import { exportCourseFile, importCourseFile } from "../storage/files";
import { rememberOpen } from "../storage/host";
import { openLibraryCourse, resolveLibraryConflict } from "../storage/library";
import { mountEditor, type EditorViewState } from "./editor";
import { renderHud } from "./hud";
import { renderPlay } from "./play-view";

export type EditorPersistence = Readonly<{
  db: DatabaseHandle | null;
  expectedStoredRevision: number | null;
  unavailable?: boolean;
  onOpenLibrary?: () => void;
  onOpenRecord?: (course: CourseV1, expectedStoredRevision: number) => void;
}>;

function spawnFromCell(areaId: string, cell: Readonly<{ x: number; y: number }>): CourseStart {
  return { areaId, x: cell.x * 16 + 8, y: cell.y * 16 + 16 };
}

function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = "noopener";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

/** Normal application host. QA observes the same view created by the visible new-course form. */
export function mountNormalEditor(root: HTMLElement, course: CourseV1, persistence: EditorPersistence = { db: null, expectedStoredRevision: null }) {
  const qaEnabled = new URLSearchParams(location.search).get("qa") === "editor";
  const proposals: unknown[] = [];
  const pending = new Set<() => void>();
  const observe = (proposal: unknown) => {
    if (!qaEnabled) return;
    proposals.push(proposal);
    if (proposals.length > 128) proposals.shift();
  };
  let autosave: AutosaveSession | null = null;
  let editorSession: EditorSession;
  const clock = new FixedClock();
  let raf: number | null = null;
  let lastInput = EMPTY_INPUT;
  let playEvents: readonly GameEvent[] = [];
  let overlay: HTMLElement | null = null;
  let gameCanvas: HTMLCanvasElement | null = null;
  let hud: HTMLElement | null = null;
  let input: ReturnType<typeof attachInput> | null = null;
  let playError: HTMLElement | null = null;
  let conflictBox: HTMLElement | null = null;

  const view = mountEditor(root, {
    course,
    onTitleDraft: title => observe({ kind: "title-draft", title }),
    onCanvasPoint: point => observe({ kind: "canvas-point", ...point }),
    onPalettePreview: kind => observe({ kind: "palette-preview", value: kind }),
    onAuthoredChange: document => { void persist(document); },
    onSaveRetry: () => { void persist(view.getCourseSnapshot()); },
    onPlayStart: () => startPlay({}),
    onPlayCursor: () => startCursor(),
    onPlaySandbox: () => startPlay({ allowNoGoal: true }),
    onExport: () => exportCurrent(),
    onImport: file => { void importFile(file); },
    ...(persistence.onOpenLibrary ? { onOpenLibrary: persistence.onOpenLibrary } : {}),
  });
  editorSession = createEditorSession({
    history: view.history(),
    selection: view.selection(),
    viewport: view.getState().viewport,
  });
  let lastHover: Readonly<{ areaId: string; x: number; y: number }> | null = null;
  view.element.addEventListener("editor-view-state", event => {
    if (!(event instanceof CustomEvent)) return;
    const cell = event.detail.hoveredCell as Readonly<{ x: number; y: number }> | null;
    if (cell) lastHover = { areaId: event.detail.areaId as string, x: cell.x, y: cell.y };
  });

  function bindSession(): void {
    editorSession = createEditorSession({
      history: view.history(),
      selection: view.selection(),
      viewport: view.getState().viewport,
    });
  }

  function applyStatus(): void {
    if (!autosave) {
      view.setSaveStatus(persistence.unavailable || persistence.db === null ? "unavailable" : "unsupported");
      return;
    }
    const status = autosave.status();
    if (status.error) view.setSaveStatus("failed", { errorKind: status.error.kind, recovery: status.recovery });
    else if (status.dirty) view.setSaveStatus("dirty");
    else view.setSaveStatus("saved");
  }

  function showHostDialog(kind: "conflict" | "error", message: string): HTMLElement {
    conflictBox?.remove();
    const box = document.createElement("section");
    box.dataset["testid"] = "error-dialog";
    box.setAttribute("role", "dialog");
    box.className = "editor-notice";
    box.style.cssText = "position:fixed;z-index:30;left:50%;top:24px;transform:translateX(-50%);max-width:520px;padding:16px;background:#fff6e8;color:#26323c;border:2px solid #c04426;";
    const text = document.createElement("p");
    text.textContent = message;
    box.append(text);
    if (kind === "conflict") {
      const reload = document.createElement("button");
      reload.type = "button";
      reload.dataset["testid"] = "reload-course";
      reload.textContent = "다시 불러오기";
      const copy = document.createElement("button");
      copy.type = "button";
      copy.dataset["testid"] = "confirm";
      copy.textContent = "사본 저장";
      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.dataset["testid"] = "cancel";
      cancel.textContent = "취소";
      reload.addEventListener("click", () => { void onConflict("reload"); });
      copy.addEventListener("click", () => { void onConflict("save-copy"); });
      cancel.addEventListener("click", () => { box.remove(); if (conflictBox === box) conflictBox = null; });
      box.append(reload, copy, cancel);
    } else {
      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.dataset["testid"] = "cancel";
      cancel.textContent = "닫기";
      cancel.addEventListener("click", () => { box.remove(); if (conflictBox === box) conflictBox = null; });
      box.append(cancel);
    }
    document.body.append(box);
    conflictBox = box;
    return box;
  }

  async function onConflict(decision: "reload" | "save-copy"): Promise<void> {
    if (!autosave || !persistence.db) return;
    const result = await resolveLibraryConflict(persistence.db, autosave, decision);
    conflictBox?.remove();
    conflictBox = null;
    if (result.status === "reloaded" || result.status === "copied") {
      persistence.onOpenRecord?.(result.record.document, result.record.document.revision);
      view.setCourse(result.record.document);
      autosave = createAutosave({
        db: persistence.db,
        document: result.record.document,
        expectedStoredRevision: result.record.document.revision,
      });
      bindSession();
      applyStatus();
    }
  }

  async function persist(document: CourseV1): Promise<void> {
    if (!autosave) { applyStatus(); return; }
    autosave.setDocument(document);
    applyStatus();
    const shot = Reflect.get(globalThis, "__qaAfterDirty");
    if (typeof shot === "function" && autosave.status().dirty) await shot();
    if (!autosave.status().dirty) return;
    const outcome = await autosave.requestSave();
    if (outcome.status === "saved" && persistence.db) await rememberOpen(persistence.db, document);
    if (outcome.status === "conflict") {
      showHostDialog("conflict", "저장된 코스가 더 최신입니다. 다시 불러오거나 사본으로 저장하세요.");
    }
    applyStatus();
  }

  function exportCurrent(): void {
    const exported = exportCourseFile(view.getCourseSnapshot());
    if (!exported.ok) {
      showHostDialog("error", exported.error.message);
      return;
    }
    triggerDownload(exported.value.blob, exported.value.filename);
  }

  async function importFile(file: File): Promise<void> {
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (!persistence.db) {
      showHostDialog("error", "로컬 저장 불가: 가져오기를 보관함에 넣을 수 없습니다.");
      return;
    }
    const imported = await importCourseFile(persistence.db, bytes);
    if (imported.status !== "imported") {
      const message = imported.status === "invalid" ? imported.error.message : "가져오기에 실패했습니다.";
      showHostDialog("error", message);
      return;
    }
    const opened = await openLibraryCourse(persistence.db, imported.record.id);
    if (opened.status !== "opened") {
      showHostDialog("error", "가져온 코스를 열 수 없습니다.");
      return;
    }
    persistence.onOpenRecord?.(opened.record.document, opened.record.document.revision);
    view.setCourse(opened.record.document);
    autosave = createAutosave({
      db: persistence.db,
      document: opened.record.document,
      expectedStoredRevision: opened.record.document.revision,
    });
    bindSession();
    applyStatus();
  }

  function emitPlay(): void {
    const run = editorSession.run();
    root.dispatchEvent(new CustomEvent("play-state", {
      bubbles: true,
      detail: {
        mode: editorSession.mode(),
        runtime: run ? snapshot(run.runtime) : null,
        input: lastInput,
        events: playEvents,
        history: view.history().snapshot(),
      },
    }));
  }

  function cancelFrame(): void {
    if (raf !== null) cancelAnimationFrame(raf);
    raf = null;
  }

  function destroyOverlay(): void {
    cancelFrame();
    clock.pause();
    input?.dispose();
    input = null;
    overlay?.remove();
    overlay = null;
    gameCanvas = null;
    hud = null;
    playError = null;
    view.element.inert = false;
  }

  function ensureOverlay(): HTMLCanvasElement {
    if (overlay && gameCanvas && input) return gameCanvas;
    destroyOverlay();
    overlay = document.createElement("section");
    overlay.className = "play-overlay";
    overlay.dataset["testid"] = "play-overlay";
    overlay.innerHTML = `<div class="play-layout"><div></div><section>
      <p>← → / A D 이동 · Space / Z 점프 · Shift / X 달리기 · Esc 일시정지</p>
    </section></div>`;
    const slot = overlay.querySelector(".play-layout > div");
    const controls = overlay.querySelector("section");
    if (!slot || !controls) throw new Error("Play overlay missing");
    gameCanvas = document.createElement("canvas");
    gameCanvas.dataset["testid"] = "game-canvas";
    gameCanvas.tabIndex = 0;
    gameCanvas.setAttribute("aria-label", "플레이 테스트");
    slot.append(gameCanvas);
    hud = document.createElement("output");
    hud.dataset["testid"] = "hud";
    controls.append(hud);
    playError = document.createElement("section");
    playError.dataset["testid"] = "error-dialog";
    playError.hidden = true;
    playError.setAttribute("role", "alert");
    controls.append(playError);
    const clearDialog = document.createElement("section");
    clearDialog.dataset["testid"] = "clear-dialog";
    clearDialog.hidden = true;
    controls.append(clearDialog);
    const gameOver = document.createElement("section");
    gameOver.dataset["testid"] = "game-over";
    gameOver.hidden = true;
    gameOver.textContent = "게임 오버";
    controls.append(gameOver);
    const add = (id: string, label: string, action: () => void) => {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset["testid"] = id;
      button.textContent = label;
      button.addEventListener("click", action);
      controls.append(button);
      return button;
    };
    const pauseButton = add("pause", "일시정지", () => pausePlay("button"));
    const resumeButton = add("resume", "재개", () => resumePlay());
    resumeButton.hidden = true;
    const retryButton = add("retry", "다시 도전", () => {
      editorSession.retry();
      resumePlay();
    });
    retryButton.hidden = true;
    add("restart-course", "처음부터 다시", () => {
      editorSession.restart();
      resumePlay();
    });
    add("return-editor", "편집으로 돌아가기", () => returnToEdit());
    const syncButtons = () => {
      const mode = editorSession.mode();
      pauseButton.hidden = mode !== "PLAYING";
      resumeButton.hidden = mode !== "PAUSED";
      retryButton.hidden = mode !== "DEAD";
      clearDialog.hidden = mode !== "CLEARED";
      gameOver.hidden = mode !== "GAME_OVER";
      if (mode === "CLEARED") {
        const ending = editorSession.run()?.runtime.ending.kind === "castle" ? "castle" : "flag";
        clearDialog.dataset["ending"] = ending;
        clearDialog.textContent = ending === "castle" ? "성 클리어" : "깃발 클리어";
      }
    };
    Object.assign(overlay, { syncButtons });
    root.append(overlay);
    view.element.inert = true;
    input = attachInput(gameCanvas, pausePlay);
    return gameCanvas;
  }

  function renderOverlay(): void {
    const run = editorSession.run();
    if (!run || !gameCanvas || !hud) return;
    renderPlay(gameCanvas, run.runtime);
    renderHud(hud, run.runtime, editorSession.mode());
    const sync = Reflect.get(overlay ?? {}, "syncButtons");
    if (typeof sync === "function") sync();
  }

  function loop(now: number): void {
    raf = null;
    clock.frame(now, () => {
      if (editorSession.mode() !== "PLAYING" || !input) return;
      lastInput = input.consume();
      playEvents = editorSession.step(lastInput);
      emitPlay();
      const mode = editorSession.mode();
      if (mode === "DEAD" || mode === "CLEARED" || mode === "GAME_OVER") {
        clock.pause();
        input.setActive(false);
      }
    });
    renderOverlay();
    if (editorSession.mode() === "PLAYING") raf = requestAnimationFrame(loop);
  }

  function pausePlay(reason: PauseReason): void {
    if (editorSession.mode() !== "PLAYING") return;
    editorSession.pause(reason);
    clock.pause();
    input?.setActive(false);
    cancelFrame();
    renderOverlay();
    emitPlay();
  }

  function resumePlay(): void {
    if (document.hidden) return;
    editorSession.resume();
    if (editorSession.mode() !== "PLAYING") return;
    input?.setActive(true);
    clock.resume();
    playEvents = [];
    renderOverlay();
    emitPlay();
    gameCanvas?.focus();
    raf = requestAnimationFrame(loop);
  }

  function showPlayError(error: ValidationIssue): void {
    const box = showHostDialog("error", error.message);
    box.dataset["errorKind"] = error.code;
  }

  function startPlay(options: { allowNoGoal?: boolean; spawnOverride?: CourseStart }): void {
    editorSession.setSelection(view.selection());
    editorSession.setViewport(view.getState().viewport);
    const result = editorSession.enterPlay(options);
    if (!result.ok) {
      showPlayError(result.error);
      return;
    }
    ensureOverlay();
    playError && (playError.hidden = true);
    resumePlay();
  }

  function startCursor(): void {
    const state = view.getState();
    const hovered = lastHover ?? (state.hoveredCell ? { areaId: state.areaId, x: state.hoveredCell.x, y: state.hoveredCell.y } : null);
    if (!hovered) {
      showPlayError({ code: "invalid_value", path: "$.spawnOverride", message: "커서가 코스 칸 위에 있어야 합니다." });
      return;
    }
    startPlay({ spawnOverride: spawnFromCell(hovered.areaId, hovered) });
  }

  function returnToEdit(): void {
    const selection: EditorSelection = editorSession.selection();
    const viewport: Viewport = editorSession.viewport();
    editorSession.returnToEdit();
    destroyOverlay();
    view.setSelection(selection);
    view.setViewport(viewport);
    playEvents = [];
    emitPlay();
  }

  if (persistence.db) {
    autosave = createAutosave({
      db: persistence.db,
      document: course,
      expectedStoredRevision: persistence.expectedStoredRevision,
    });
    void persist(course);
  } else applyStatus();
  const dispose = () => {
    window.removeEventListener("pagehide", dispose);
    for (const cancel of [...pending]) cancel();
    destroyOverlay();
    conflictBox?.remove();
    if (qaEnabled) Reflect.deleteProperty(globalThis, "__qa");
    view.dispose();
  };
  window.addEventListener("pagehide", dispose, { once: true });
  if (qaEnabled) {
    Object.defineProperty(globalThis, "__qa", { configurable: true, value: Object.freeze({
      getState: () => view.getState(),
      getCourseSnapshot: () => view.getCourseSnapshot(),
      getProposals: () => structuredClone(proposals),
      nextState: (predicate: (state: EditorViewState & { reason: string }) => boolean) => new Promise<EditorViewState>((resolve, reject) => {
        const finish = () => { clearTimeout(timer); root.removeEventListener("editor-view-state", onState); pending.delete(cancel); };
        const cancel = () => { finish(); reject(new Error("Editor host disposed")); };
        const onState = (event: Event) => {
          if (!(event instanceof CustomEvent)) return;
          try {
            const state = structuredClone(event.detail);
            if (predicate(state)) { finish(); resolve(state); }
          } catch (error) { finish(); reject(error); }
        };
        const timer = setTimeout(() => { finish(); reject(new Error("Editor state event timed out")); }, 10_000);
        pending.add(cancel); root.addEventListener("editor-view-state", onState);
      }),
    }) });
    document.dispatchEvent(new CustomEvent("normal-editor-ready"));
  }
  return { element: view.element, dispose };
}
