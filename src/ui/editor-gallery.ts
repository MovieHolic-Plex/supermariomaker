import type { CourseV1 } from "../level/types";
import { createAutosave, type AutosaveSession } from "../storage/autosave";
import type { DatabaseHandle } from "../storage/db";
import { rememberOpen } from "../storage/host";
import { mountEditor, type EditorViewState } from "./editor";

export type EditorPersistence = Readonly<{
  db: DatabaseHandle | null;
  expectedStoredRevision: number | null;
  unavailable?: boolean;
}>;

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
  let session: AutosaveSession | null = null;
  const view = mountEditor(root, {
    course,
    onTitleDraft: title => observe({ kind: "title-draft", title }),
    onCanvasPoint: point => observe({ kind: "canvas-point", ...point }),
    onPalettePreview: kind => observe({ kind: "palette-preview", value: kind }),
    onAuthoredChange: document => { void persist(document); },
    onSaveRetry: () => { void persist(view.getCourseSnapshot()); },
  });
  function applyStatus(): void {
    if (!session) {
      view.setSaveStatus(persistence.unavailable || persistence.db === null ? "unavailable" : "unsupported");
      return;
    }
    const status = session.status();
    if (status.error) view.setSaveStatus("failed", { errorKind: status.error.kind, recovery: status.recovery });
    else if (status.dirty) view.setSaveStatus("dirty");
    else view.setSaveStatus("saved");
  }
  async function persist(document: CourseV1): Promise<void> {
    if (!session) { applyStatus(); return; }
    session.setDocument(document);
    applyStatus();
    const shot = Reflect.get(globalThis, "__qaAfterDirty");
    if (typeof shot === "function" && session.status().dirty) await shot();
    if (!session.status().dirty) return;
    const outcome = await session.requestSave();
    if (outcome.status === "saved" && persistence.db) await rememberOpen(persistence.db, document);
    applyStatus();
  }
  if (persistence.db) {
    session = createAutosave({
      db: persistence.db,
      document: course,
      expectedStoredRevision: persistence.expectedStoredRevision,
    });
    void persist(course);
  } else applyStatus();
  const dispose = () => {
    window.removeEventListener("pagehide", dispose);
    for (const cancel of [...pending]) cancel();
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
