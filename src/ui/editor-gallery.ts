import type { CourseV1 } from "../level/types";
import { mountEditor, type EditorViewState } from "./editor";

/** Normal application host. QA observes the same view created by the visible new-course form. */
export function mountNormalEditor(root: HTMLElement, course: CourseV1) {
  const qaEnabled = new URLSearchParams(location.search).get("qa") === "editor";
  const proposals: unknown[] = [];
  const pending = new Set<() => void>();
  const observe = (proposal: unknown) => {
    if (!qaEnabled) return;
    proposals.push(proposal);
    if (proposals.length > 128) proposals.shift();
  };
  const view = mountEditor(root, { course,
    onTitleDraft: title => observe({ kind: "title-draft", title }),
    onCanvasPoint: point => observe({ kind: "canvas-point", ...point }),
    onPalettePreview: kind => observe({ kind: "palette-preview", value: kind }),
  });
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
