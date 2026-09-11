import { parseCourse } from "../level/serialize";
import { COURSE_LIMITS } from "../level/types";
import type { CourseV1, ValidationCode, ValidationIssue } from "../level/types";
import { renderCoursePreview } from "./course-preview";
import { EDITOR_THEMES } from "./inspector";

const remedies: Readonly<Record<ValidationCode, string>> = {
  malformed_json: "JSON 문법을 확인한 뒤 파일을 다시 선택해 주세요.",
  invalid_utf8: "UTF-8로 저장한 JSON 파일을 선택해 주세요.",
  file_too_large: "32 MiB 이하의 코스 파일을 선택해 주세요.",
  duplicate_id: "코스, 영역, 오브젝트의 중복 ID를 고쳐 주세요.",
  invalid_type: "표시된 위치의 값 형식을 확인해 주세요.",
  invalid_value: "표시된 위치의 값과 허용 범위를 확인해 주세요.",
  invalid_id: "표시된 위치의 UUID를 확인해 주세요.",
  unknown_field: "지원하지 않는 필드를 제거해 주세요.",
  unknown_kind: "지원하는 타일 또는 배치 오브젝트 종류인지 확인해 주세요.",
  unsupported_version: "smb1-maker 버전 1 코스 파일을 선택해 주세요.",
  duplicate_cell: "같은 칸에 겹친 타일을 고쳐 주세요.",
  out_of_bounds: "영역 크기와 배치 좌표를 확인해 주세요.",
  limit_exceeded: "영역, 타일, 오브젝트 수와 크기 제한을 확인해 주세요.",
  invalid_reference: "연결 대상 ID와 양방향 연결을 확인해 주세요.",
  occupied_bridge: "성 목표의 다리와 겹친 타일을 제거해 주세요.",
  start_blocked: "시작 위치를 막고 있는 지형을 확인해 주세요.",
  goal_required: "필요한 목표를 코스에 배치해 주세요.",
};

export interface FixtureGalleryOptions {
  readonly purpose?: "movement";
  /** Called only after the actual selected file passes the production parser and selection token. */
  readonly onCourseLoaded?: (course: CourseV1) => void;
  readonly onDispose?: () => void;
}
/** The sole document replacement boundary is parseCourse(selected bytes). Default route stays read-only. */
export function mountFixtureGallery(root: HTMLElement, options: FixtureGalleryOptions = {}): Readonly<{ dispose(): void }> {
  const events = new AbortController();
  let course: CourseV1 | null = null;
  let selection = 0;
  let disposed = false;
  const panel = document.createElement("main");
  panel.dataset["testid"] = "fixture-gallery";
  const style = document.createElement("style");
  style.textContent = `
    [data-testid=fixture-gallery] { max-width:1100px; margin:24px auto; padding:24px; background:var(--surface); border:1px solid var(--border); }
    [data-testid=fixture-gallery] h1 { font-size:28px; margin:0 0 8px; }
    [data-testid=fixture-gallery] h2 { font-size:24px; margin:0 0 12px; overflow-wrap:anywhere; }
    [data-testid=fixture-gallery] p { margin:0 0 16px; word-break:keep-all; overflow-wrap:anywhere; }
    [data-testid=fixture-gallery] .fixture-layout { display:grid; grid-template-columns:minmax(0,1fr) 512px; gap:32px; align-items:start; }
    [data-testid=fixture-gallery] label { display:block; min-height:44px; margin:0 0 12px; }
    [data-testid=fixture-gallery] input, [data-testid=fixture-gallery] select { display:block; font:inherit; color:inherit; width:100%; min-width:0; min-height:44px; margin:4px 0 0; padding:8px; background:var(--surface); border:1px solid var(--border); }
    [data-testid=fixture-gallery] label:has(select), [data-testid=fixture-gallery] label:has(input[type=range]) { display:grid; grid-template-columns:180px minmax(0,1fr); gap:12px; align-items:center; }
    [data-testid=fixture-gallery] label select, [data-testid=fixture-gallery] input[type=range] { margin:0; }
    [data-testid=fixture-gallery] input[type=range] { padding:0; height:44px; accent-color:var(--accent); }
    [data-testid=fixture-gallery] input[type=file] { font-size:14px; }
    [data-testid=fixture-gallery] input::file-selector-button { min-height:44px; font:inherit; margin-right:8px; }
    [data-testid=fixture-gallery] button { margin:0 8px 12px 0; padding:8px 16px; }
    [data-testid=fixture-gallery] button:disabled { opacity:.55; cursor:default; }
    [data-testid=fixture-gallery] output { display:block; background:#f5f3ed; border-left:4px solid var(--accent); padding:12px; margin-bottom:16px; overflow-wrap:anywhere; word-break:keep-all; }
    [data-testid=fixture-gallery] figure { margin:0; }
    [data-testid=fixture-gallery] canvas { display:block; max-width:100%; object-fit:contain; image-rendering:pixelated; }
    [data-testid=fixture-gallery] [hidden] { display:none; }
    [data-testid=fixture-gallery] figcaption { font-size:14px; color:var(--muted); margin-top:8px; }
    [data-testid=fixture-gallery] details { margin-top:16px; }
    [data-testid=fixture-gallery] summary { min-height:44px; cursor:pointer; }
    [data-testid=fixture-gallery] pre { max-height:240px; overflow:auto; font-size:12px; }
    @media(max-width:900px) { [data-testid=fixture-gallery] .fixture-layout { grid-template-columns:minmax(0,1fr); } }
  `;
  panel.innerHTML = `<h1>코스 파일 진단</h1><p>파일을 검증하고 저장된 배치를 정지 화면으로 확인합니다. 편집 · 플레이 · 저장 기능은 제공하지 않습니다.</p>
    <div class="fixture-layout"><section aria-label="파일과 미리보기 설정"></section><figure><figcaption>256 × 240 논리 픽셀 · 2배 표시 · 숨은 블록과 워프 존은 진단용 표시입니다.</figcaption></figure></div>`;
  if (options.purpose === "movement") {
    const heading = panel.querySelector("h1"), description = panel.querySelector("p");
    if (heading) heading.textContent = "이동 실험실 · 코스 파일";
    if (description) description.textContent = "검증한 파일로 이동 · 블록 · 아이템 · 지상 적 · 등껍질 공격을 테스트합니다. 움직이는 장치, 수영과 코스 완료는 아직 제공하지 않습니다. 편집 · 저장은 지원하지 않습니다.";
  }
  panel.prepend(style);
  const controls = panel.querySelector("section"), figure = panel.querySelector("figure");
  if (!controls || !figure) throw new Error("Fixture gallery structure missing");
  const label = (text: string, control: HTMLElement) => {
    const element = document.createElement("label"); element.append(text, control); controls.append(element); return element;
  };
  const input = document.createElement("input"); input.type = "file"; input.accept = ".json,application/json"; input.dataset["testid"] = "import-course";
  label("코스 JSON 파일 · 최대 32 MiB", input);
  const title = document.createElement("h2"); title.dataset["testid"] = "fixture-title"; title.textContent = "선택한 코스 없음";
  const info = document.createElement("p"); info.dataset["testid"] = "fixture-counts"; info.textContent = "파일을 선택하면 영역과 배치 수가 표시됩니다.";
  controls.append(title, info);
  const areas = document.createElement("select"); areas.dataset["testid"] = "fixture-area"; areas.disabled = true; label("미리보기 영역", areas);
  const x = document.createElement("input"), y = document.createElement("input");
  for (const [axis, control] of [["x", x], ["y", y]] as const) {
    control.type = "range"; control.min = "0"; control.max = "0"; control.step = "1"; control.value = "0"; control.disabled = true; control.dataset["testid"] = `fixture-camera-${axis}`;
    label(axis === "x" ? "카메라 가로 위치 (픽셀)" : "카메라 세로 위치 (픽셀)", control);
  }
  const camera = document.createElement("p"); camera.dataset["testid"] = "fixture-camera"; controls.append(camera);
  const button = (id: string, text: string) => {
    const element = document.createElement("button"); element.type = "button"; element.dataset["testid"] = id; element.textContent = text; controls.append(element); return element;
  };
  const cancel = button("fixture-cancel", "읽기 취소"); cancel.disabled = true;
  const exit = button("fixture-exit", "진단 닫기");
  const status = document.createElement("output"); status.dataset["testid"] = "fixture-status"; status.setAttribute("aria-live", "polite"); controls.insertBefore(status, title);
  const canvas = document.createElement("canvas"); canvas.width = 256; canvas.height = 240; canvas.hidden = true; canvas.dataset["testid"] = "fixture-canvas"; canvas.setAttribute("aria-label", "선택한 영역의 정적 코스 미리보기"); figure.prepend(canvas);
  const details = document.createElement("details"), summary = document.createElement("summary"), snapshot = document.createElement("pre");
  summary.textContent = "검증된 코스 스냅샷 · 읽기 전용"; snapshot.dataset["testid"] = "fixture-snapshot"; snapshot.textContent = "null"; details.append(summary, snapshot); panel.append(details);
  root.replaceChildren(panel);
  document.title = "코스 파일 진단 | 코스 메이커";

  const show = (state: string, message: string, code = "", path = "") => {
    panel.dataset["status"] = state; status.dataset["code"] = code; status.dataset["path"] = path; status.textContent = message;
    cancel.disabled = state !== "loading";
    root.dispatchEvent(new CustomEvent("fixture-state", { bubbles: true, detail: { status: state, code, path } }));
  };
  const render = () => {
    if (!course) return;
    const area = course.areas.find(item => item.id === areas.value);
    if (!area) throw new Error("Selected validated area missing");
    const position = { x: x.valueAsNumber, y: y.valueAsNumber };
    renderCoursePreview(canvas, course, { area, camera: position }); canvas.hidden = false;
    canvas.dataset["areaId"] = area.id;
    info.textContent = `${course.areas.length}개 영역 · ${area.name} (${EDITOR_THEMES[area.theme]}) · ${area.width} × ${area.height}칸 · 타일 ${area.tiles.length}개 · 오브젝트 ${area.objects.length}개`;
    info.dataset["tiles"] = String(area.tiles.length); info.dataset["objects"] = String(area.objects.length); info.dataset["areas"] = String(course.areas.length);
    camera.textContent = `X ${position.x} / ${x.max} · Y ${position.y} / ${y.max}`;
    root.dispatchEvent(new CustomEvent("fixture-preview", { bubbles: true, detail: { areaId: area.id, camera: position } }));
  };
  const selectArea = () => {
    const area = course?.areas.find(item => item.id === areas.value);
    if (!area) return;
    x.max = String(Math.max(0, area.width * 16 - 256)); y.max = String(Math.max(0, area.height * 16 - 240));
    const start = course?.start.areaId === area.id ? course.start : null;
    x.value = String(Math.min(Number(x.max), Math.max(0, (start?.x ?? 128) - 128)));
    y.value = String(Math.min(Number(y.max), Math.max(0, (start?.y ?? 240) - 208)));
    x.disabled = x.max === "0"; y.disabled = y.max === "0"; render();
  };
  const reject = (issue: ValidationIssue) => show("rejected", `불러오기 실패 · ${remedies[issue.code]} 기존 미리보기는 유지됩니다.`, issue.code, issue.path);
  const load = async () => {
    const token = ++selection;
    const file = input.files?.[0];
    if (!file) { show("cancelled", "파일 선택을 취소했습니다. 기존 미리보기는 유지됩니다."); return; }
    // Retain the File, not the input selection: choosing the same file again must trigger change after a failure.
    input.value = "";
    show("loading", `${file.name} 읽는 중 · 다른 파일을 선택하면 마지막 선택만 적용됩니다.`);
    let bytes: Uint8Array;
    try {
      if (file.size > COURSE_LIMITS.fileBytes) { reject({ code: "file_too_large", path: "$", message: "" }); return; }
      // File.arrayBuffer cannot stop underlying browser I/O. The token cancels its authority to replace state.
      try { bytes = new Uint8Array(await file.arrayBuffer()); }
      catch (error) {
        if (disposed || token !== selection) return;
        const aborted = error instanceof DOMException && error.name === "AbortError";
        show("rejected", `파일 읽기 ${aborted ? "취소" : "실패"} · 파일 접근 권한을 확인하고 다시 선택해 주세요. 기존 미리보기는 유지됩니다.`, aborted ? "read_aborted" : "read_failed", "$");
        return;
      }
      if (disposed || token !== selection) return;
      const result = parseCourse(bytes);
      if (!result.ok) { reject(result.error); return; }
      course = result.value;
      snapshot.textContent = JSON.stringify(course);
      title.textContent = course.title;
      areas.replaceChildren(...course.areas.map(area => {
        const option = document.createElement("option"); option.value = area.id; option.textContent = `${area.name} · ${EDITOR_THEMES[area.theme]}`; return option;
      }));
      areas.disabled = false; areas.value = course.mainAreaId; selectArea();
      options.onCourseLoaded?.(course);
      show("loaded", `${file.name} 검증 완료 · ${options.purpose === "movement" ? "목표 없이 이동 테스트를 시작할 수 있습니다." : "정적 미리보기만 표시합니다."}`);
    } finally {
      root.dispatchEvent(new CustomEvent("fixture-read-settled", { bubbles: true, detail: { name: file.name, stale: disposed || token !== selection } }));
    }
  };
  const on = (target: EventTarget, type: string, handler: () => void) => target.addEventListener(type, handler, { signal: events.signal });
  const cancelRead = () => { selection++; show("cancelled", "읽기 적용을 취소했습니다. 기존 미리보기는 유지됩니다."); };
  on(input, "change", () => { void load(); }); on(input, "cancel", cancelRead); on(cancel, "click", cancelRead);
  on(areas, "change", selectArea); on(x, "input", render); on(y, "input", render);
  const dispose = () => {
    if (disposed) return;
    disposed = true; selection++; events.abort(); course = null; root.replaceChildren();
    options.onDispose?.();
    root.dispatchEvent(new CustomEvent("fixture-cleanup", { bubbles: true, detail: { listenersAborted: events.signal.aborted, pendingReadsInvalidated: true } }));
  };
  on(exit, "click", dispose); on(window, "pagehide", dispose);
  show("empty", "코스 JSON 파일을 선택해 주세요. 원본 파일은 변경하지 않습니다.");
  return { dispose };
}
