// Private QA entry point only. Never imported by main.ts or the central scenario registry.
import { parseCourse } from "../../src/level/serialize";
import { mountEditor, type EditorView } from "../../src/ui/editor";
import type { EditorViewState } from "../../src/ui/editor";

const root = document.querySelector<HTMLElement>("#editor-root");
const input = document.querySelector<HTMLInputElement>('[data-testid="import-course"]');
const status = document.querySelector<HTMLOutputElement>('[data-testid="private-import-status"]');
const close = document.querySelector<HTMLButtonElement>('[data-testid="private-close"]');
if (!root || !input || !status || !close) throw new Error("Private editor host markup missing");
const parsed = parseCourse(new Uint8Array(await (await fetch("/fixture.json")).arrayBuffer()));
if (!parsed.ok) throw new Error(`Private editor seed failed validation: ${JSON.stringify(parsed.error)}`);
let course = parsed.value;
let view: EditorView | null = mountEditor(root, { course });
let token = 0;
const proposals: unknown[] = [];
function mount(): EditorView {
  if (!root) throw new Error("Editor root missing");
  return mountEditor(root, { course, onTitleDraft: title => proposals.push({ kind: "title-draft", title }),
    onCanvasPoint: point => proposals.push({ kind: "canvas-point", ...point }),
    onPalettePreview: kind => proposals.push({ kind: "palette-preview", value: kind }) });
}
Object.defineProperty(globalThis, "__qa", { value: Object.freeze({
  getState: () => view?.getState() ?? null,
  getCourseSnapshot: () => view?.getCourseSnapshot() ?? structuredClone(course),
  getProposals: () => structuredClone(proposals),
  nextState: (predicate: (state: EditorViewState & { reason: string }) => boolean) => new Promise<EditorViewState>((resolve, reject) => {
    const onState = (event: Event) => {
      if (!(event instanceof CustomEvent) || !predicate(event.detail)) return;
      clearTimeout(timer); document.removeEventListener("editor-view-state", onState); resolve(event.detail);
    };
    const timer = setTimeout(() => { document.removeEventListener("editor-view-state", onState); reject(new Error("Editor state event timed out")); }, 10_000);
    document.addEventListener("editor-view-state", onState);
  }),
}) });
input.addEventListener("change", async () => {
  const current = ++token, file = input.files?.[0]; input.value = "";
  if (!file) return;
  try {
    const result = parseCourse(new Uint8Array(await file.arrayBuffer()));
    if (current !== token) return;
    if (!result.ok) { status.value = `불러오기 실패: ${result.error.code}`; document.dispatchEvent(new CustomEvent("private-editor-import", { detail: { ok: false, code: result.error.code } })); return; }
    course = result.value; view?.dispose(); view = mount(); close.textContent = "뷰 닫기"; status.value = "검증된 파일 · 보기 전용";
    document.dispatchEvent(new CustomEvent("private-editor-import", { detail: { ok: true } }));
  } catch (error) {
    status.value = `파일 읽기 실패: ${String(error)}`;
    document.dispatchEvent(new CustomEvent("private-editor-import", { detail: { ok: false, message: String(error) } }));
  }
});
close.addEventListener("click", () => {
  token++;
  if (view) { view.dispose(); view = null; close.textContent = "뷰 열기"; }
  else { view = mount(); close.textContent = "뷰 닫기"; }
  document.dispatchEvent(new CustomEvent("private-editor-mount", { detail: { mounted: view !== null } }));
});
document.dispatchEvent(new CustomEvent("private-editor-ready"));
