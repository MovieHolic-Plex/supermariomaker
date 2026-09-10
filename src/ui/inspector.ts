import { createArea, deleteArea, linkPipes, placePipe, previewResize, renameArea, resizeArea, setAreaTheme, warpLabels } from "../editor/areas";
import { deleteObjects, placeObject, setCourseFields, setObjectProperties } from "../editor/commands";
import type { EditorHistory } from "../editor/history";
import { commitCourseProperties } from "../editor/selection";
import { getFrame } from "../assets/manifest";
import { CATALOG_CATEGORIES, createObject, OBJECT_CATALOG, SPAWNED_CATALOG, TILE_CATALOG, type SpawnedKind } from "../level/catalog";
import type { AreaV1, CourseV1, ObjectKind, Theme, TileKind, ValidationResult } from "../level/types";
import { canvasContext, drawSprite } from "../render/assets";

export type PaletteKind = TileKind | ObjectKind | SpawnedKind;
export const EDITOR_CATALOG = { ...TILE_CATALOG, ...OBJECT_CATALOG, ...SPAWNED_CATALOG };
export const EDITOR_THEMES = { overworld: "지상", underground: "지하", underwater: "수중", castle: "성" } as const;

export type InspectorHost = Readonly<{
  history: EditorHistory;
  createId: () => string;
  onCommitted: (selectAreaId?: string) => void;
  onRejected: () => void;
  onPlaceStart: () => void;
  onPlaceFlag: () => void;
  onPlaceCastle: () => void;
}>;

/** Uses the production atlas renderer; CSS enlarges its logical pixels. */
export function catalogIcon(document: Document, kind: PaletteKind, theme: AreaV1["theme"], size = 40): HTMLCanvasElement {
  const entry = EDITOR_CATALOG[kind], frame = getFrame(entry.assetKey);
  const canvas = document.createElement("canvas"); canvas.width = Math.max(32, frame.width); canvas.height = Math.max(32, frame.height);
  canvas.style.width = `${size}px`; canvas.style.height = `${size}px`; canvas.setAttribute("aria-hidden", "true");
  drawSprite(canvasContext(canvas), { key: entry.assetKey, x: (canvas.width - frame.width) / 2 + frame.anchor.x, y: (canvas.height - frame.height) / 2 + frame.anchor.y }, { theme, editorPreview: true });
  return canvas;
}

function commit(host: InspectorHost, result: ValidationResult<CourseV1>, selectAreaId?: string): void {
  const outcome = host.history.commit(result);
  if (outcome.status === "committed") host.onCommitted(selectAreaId);
  else host.onRejected();
}

function nextPipeX(area: AreaV1): number {
  const used = new Set(area.objects.filter(object => object.kind === "pipe").map(object => object.x));
  for (let x = 80; x + 16 <= area.width * 16; x += 32) if (!used.has(x)) return x;
  return 80;
}

export function renderInspector(root: HTMLElement, course: CourseV1, area: AreaV1, kind: PaletteKind, host: InspectorHost): void {
  const document = root.ownerDocument, entry = EDITOR_CATALOG[kind];
  root.replaceChildren();
  const heading = document.createElement("h2"); heading.textContent = "속성 미리보기";
  const subheading = document.createElement("p"); subheading.className = "editor-eyebrow"; subheading.textContent = `${CATALOG_CATEGORIES[entry.category]} / ${entry.placeable ? "배치 요소" : "자동 생성"}`;
  const hero = document.createElement("div"); hero.className = "editor-inspector-hero";
  const name = document.createElement("h3"); name.textContent = entry.label; name.dataset["testid"] = "preview-kind"; name.dataset["kind"] = kind;
  hero.append(catalogIcon(document, kind, area.theme, 80), name);
  const properties = document.createElement("dl"); properties.className = "editor-facts";
  const row = (label: string, value: string) => { const dt = document.createElement("dt"), dd = document.createElement("dd"); dt.textContent = label; dd.textContent = value; properties.append(dt, dd); };
  row("기준 격자", "16 × 16 px");
  if ("defaults" in entry && typeof entry.defaults !== "function") {
    for (const [key, value] of Object.entries(entry.defaults)) {
      const field = Object.entries(entry.properties).find(([prop]) => prop === key)?.[1];
      row(field?.label ?? key, typeof value === "object" ? JSON.stringify(value) : String(value));
    }
  } else row("기본 속성", kind === "piranha" ? "연결할 토관이 필요합니다" : "배치 위치에서 결정됩니다");
  const notice = document.createElement("p"); notice.className = "editor-notice"; notice.textContent = "타일 그리기·지우기·채우기를 사용할 수 있습니다. 선택 도구로 복사·이동하고, 시작/목표는 아래에서 배치합니다.";
  const draft = document.createElement("label");
  const error = document.createElement("p"); error.className = "editor-notice"; error.dataset["testid"] = "property-error"; error.hidden = true;
  if (kind === "platform") {
    draft.append("길이 초안");
    const input = document.createElement("input"); input.type = "number"; input.dataset["testid"] = "property-length";
    input.value = "3"; input.min = "2"; input.max = "8"; input.autocomplete = "off";
    input.addEventListener("input", () => {
      const result = createObject({ course, areaId: area.id }, {
        id: globalThis.crypto.randomUUID(), kind: "platform", x: 64, y: 208,
        props: { motion: "horizontal", length: Number(input.value), travel: 8, speed: 1 },
      });
      if (result.ok) { error.hidden = true; error.textContent = ""; input.setCustomValidity(""); }
      else { error.hidden = false; error.textContent = `${result.error.code}:${result.error.path}`; input.setCustomValidity(result.error.message); }
    });
    draft.append(input);
  }

  const coursePanel = document.createElement("section"); coursePanel.className = "editor-area-panel"; coursePanel.dataset["testid"] = "course-panel";
  const courseHeading = document.createElement("h3"); courseHeading.className = "editor-section-heading"; courseHeading.textContent = "코스 속성";
  const timerLabel = document.createElement("label"); timerLabel.className = "editor-field";
  const timerCaption = document.createElement("span"); timerCaption.className = "editor-field-caption"; timerCaption.textContent = "제한 시간 (초)";
  const timerHint = document.createElement("span"); timerHint.className = "editor-field-hint"; timerHint.textContent = "0=무제한";
  const timer = document.createElement("input"); timer.type = "number"; timer.dataset["testid"] = "course-timer";
  timer.value = String(course.timerSeconds); timer.min = "0"; timer.max = "999"; timer.step = "1"; timer.autocomplete = "off";
  const timerError = document.createElement("p"); timerError.className = "editor-notice editor-field-error"; timerError.dataset["testid"] = "course-timer-error"; timerError.hidden = true;
  const showTimer = (message: string) => {
    timerError.hidden = false; timerError.textContent = message; timer.setCustomValidity(message);
    timer.classList.add("editor-field-invalid"); timer.setAttribute("aria-invalid", "true");
    timerLabel.scrollIntoView({ block: "nearest", inline: "nearest" });
  };
  const hideTimer = () => {
    timerError.hidden = true; timerError.textContent = ""; timer.setCustomValidity("");
    timer.classList.remove("editor-field-invalid"); timer.setAttribute("aria-invalid", "false");
  };
  timer.addEventListener("input", () => {
    const result = setCourseFields(host.history.document(), { timerSeconds: Number(timer.value) });
    if (result.ok) hideTimer();
    else showTimer(`${result.error.code}:${result.error.path}`);
  });
  timer.addEventListener("change", () => {
    const outcome = commitCourseProperties(host.history, { timerSeconds: Number(timer.value) });
    if (outcome.status === "committed") host.onCommitted();
    else if (outcome.status === "rejected") {
      const result = setCourseFields(host.history.document(), { timerSeconds: Number(timer.value) });
      showTimer(result.ok ? "rejected" : `${result.error.code}:${result.error.path}`);
      host.onRejected();
    }
  });
  timerLabel.append(timerCaption, timerHint, timer, timerError);
  const placeStart = document.createElement("button"); placeStart.type = "button"; placeStart.dataset["testid"] = "place-start"; placeStart.textContent = "시작 위치";
  placeStart.addEventListener("click", () => host.onPlaceStart());
  const placeFlag = document.createElement("button"); placeFlag.type = "button"; placeFlag.dataset["testid"] = "place-flag"; placeFlag.textContent = "깃발 목표";
  placeFlag.addEventListener("click", () => host.onPlaceFlag());
  const placeCastle = document.createElement("button"); placeCastle.type = "button"; placeCastle.dataset["testid"] = "place-castle"; placeCastle.textContent = "성 목표";
  placeCastle.addEventListener("click", () => host.onPlaceCastle());
  const placeActions = document.createElement("div"); placeActions.className = "editor-area-actions";
  placeActions.append(placeStart, placeFlag, placeCastle);
  coursePanel.append(courseHeading, timerLabel, placeActions);

  const areaPanel = document.createElement("section"); areaPanel.className = "editor-area-panel"; areaPanel.dataset["testid"] = "area-panel";
  const areaHeading = document.createElement("h3"); areaHeading.className = "editor-section-heading"; areaHeading.textContent = "영역 관리";
  const areaError = document.createElement("p"); areaError.className = "editor-notice"; areaError.dataset["testid"] = "area-error"; areaError.hidden = true;
  const showError = (message: string) => { areaError.hidden = false; areaError.textContent = message; };
  const nameLabel = document.createElement("label"); nameLabel.append("이름");
  const nameInput = document.createElement("input"); nameInput.dataset["testid"] = "area-name"; nameInput.value = area.name; nameInput.maxLength = 80; nameInput.autocomplete = "off";
  nameInput.addEventListener("change", () => commit(host, renameArea(host.history.document(), area.id, nameInput.value)));
  nameLabel.append(nameInput);
  const themeLabel = document.createElement("label"); themeLabel.append("테마");
  const themeSelect = document.createElement("select"); themeSelect.dataset["testid"] = "area-theme";
  for (const [id, label] of Object.entries(EDITOR_THEMES)) {
    const option = document.createElement("option"); option.value = id; option.textContent = label; themeSelect.append(option);
  }
  themeSelect.value = area.theme;
  themeSelect.addEventListener("change", () => commit(host, setAreaTheme(host.history.document(), area.id, themeSelect.value as Theme)));
  themeLabel.append(themeSelect);
  const widthLabel = document.createElement("label"); widthLabel.append("너비(칸)");
  const widthInput = document.createElement("input"); widthInput.type = "number"; widthInput.dataset["testid"] = "area-width"; widthInput.value = String(area.width); widthInput.min = "32"; widthInput.max = "4096";
  widthLabel.append(widthInput);
  const heightLabel = document.createElement("label"); heightLabel.append("높이(칸)");
  const heightInput = document.createElement("input"); heightInput.type = "number"; heightInput.dataset["testid"] = "area-height"; heightInput.value = String(area.height); heightInput.min = "15"; heightInput.max = "128";
  heightLabel.append(heightInput);
  const cropPreview = document.createElement("p"); cropPreview.className = "editor-notice"; cropPreview.dataset["testid"] = "area-crop-preview"; cropPreview.hidden = true;
  const confirmResize = document.createElement("button"); confirmResize.type = "button"; confirmResize.dataset["testid"] = "area-resize-confirm"; confirmResize.textContent = "축소 확인";
  const resizeBtn = document.createElement("button"); resizeBtn.type = "button"; resizeBtn.dataset["testid"] = "area-resize"; resizeBtn.textContent = "크기 적용";
  resizeBtn.addEventListener("click", () => {
    const width = Number(widthInput.value), height = Number(heightInput.value);
    const preview = previewResize(host.history.document(), area.id, width, height);
    if (!preview.ok) { showError("영역 크기는 32–4096 × 15–128칸이어야 합니다"); return; }
    if (preview.blocked) { showError("시작 위치를 옮긴 뒤에 축소할 수 있습니다"); return; }
    if (preview.tiles.length || preview.objects.length) {
      cropPreview.hidden = false;
      cropPreview.textContent = `잘릴 타일 ${preview.tiles.length} · 오브젝트 ${preview.objects.length}`;
      confirmResize.onclick = () => commit(host, resizeArea(host.history.document(), area.id, width, height));
      return;
    }
    commit(host, resizeArea(host.history.document(), area.id, width, height));
  });
  const createBtn = document.createElement("button"); createBtn.type = "button"; createBtn.dataset["testid"] = "area-create"; createBtn.textContent = "영역 추가";
  createBtn.addEventListener("click", () => {
    const id = host.createId();
    commit(host, createArea(host.history.document(), { id }), id);
  });
  const deleteBtn = document.createElement("button"); deleteBtn.type = "button"; deleteBtn.dataset["testid"] = "area-delete"; deleteBtn.textContent = "영역 삭제";
  const confirmDelete = document.createElement("button"); confirmDelete.type = "button"; confirmDelete.dataset["testid"] = "area-delete-confirm"; confirmDelete.textContent = "삭제 확인";
  const startLabel = document.createElement("label"); startLabel.append("삭제 시 시작 영역");
  const startSelect = document.createElement("select"); startSelect.dataset["testid"] = "area-start-select";
  const startBlank = document.createElement("option"); startBlank.value = ""; startBlank.textContent = "(현재 영역 유지)"; startSelect.append(startBlank);
  for (const item of course.areas) {
    if (item.id === area.id) continue;
    const option = document.createElement("option"); option.value = item.id; option.textContent = item.name; startSelect.append(option);
  }
  startLabel.append(startSelect);
  deleteBtn.addEventListener("click", () => {
    if (course.areas.length <= 1) { showError("마지막 영역은 삭제할 수 없습니다"); return; }
    if (course.start.areaId === area.id && !startSelect.value) showError("다른 시작 영역을 선택하세요");
  });
  confirmDelete.addEventListener("click", () => {
    const current = host.history.document();
    if (current.start.areaId === area.id) {
      const nextId = startSelect.value;
      const next = current.areas.find(item => item.id === nextId);
      if (!next) { showError("다른 시작 영역을 선택하세요"); return; }
      commit(host, deleteArea(current, area.id, { start: { areaId: next.id, x: 40, y: 208 } }));
      return;
    }
    commit(host, deleteArea(current, area.id));
  });
  const actions = document.createElement("div"); actions.className = "editor-area-actions";
  actions.append(createBtn, resizeBtn, confirmResize, deleteBtn, confirmDelete);
  const areaInfo = document.createElement("dl"); areaInfo.className = "editor-facts";
  for (const [label, value] of [["이름", area.name], ["테마", EDITOR_THEMES[area.theme]], ["크기", `${area.width} × ${area.height}칸`], ["배치", `타일 ${area.tiles.length} · 오브젝트 ${area.objects.length}`], ["제한 시간", course.timerSeconds === 0 ? "무제한" : `${course.timerSeconds}초`]]) {
    const dt = document.createElement("dt"), dd = document.createElement("dd"); dt.textContent = label ?? ""; dd.textContent = value ?? ""; areaInfo.append(dt, dd);
  }
  areaPanel.append(areaHeading, areaError, nameLabel, themeLabel, widthLabel, heightLabel, cropPreview, startLabel, actions, areaInfo);

  const pipePanel = document.createElement("section"); pipePanel.dataset["testid"] = "pipe-panel";
  const pipeHeading = document.createElement("h3"); pipeHeading.className = "editor-section-heading"; pipeHeading.textContent = "토관 연결";
  const placePipeBtn = document.createElement("button"); placePipeBtn.type = "button"; placePipeBtn.dataset["testid"] = "place-pipe"; placePipeBtn.textContent = "토관 배치";
  placePipeBtn.addEventListener("click", () => {
    commit(host, placePipe(host.history.document(), area.id, { id: host.createId(), x: nextPipeX(area), y: area.height * 16, height: 2 }));
  });
  const pipes = course.areas.flatMap(item => item.objects.filter(object => object.kind === "pipe").map(pipe => ({ area: item, pipe })));
  const optionFor = (select: HTMLSelectElement, empty: string) => {
    const blank = document.createElement("option"); blank.value = ""; blank.textContent = empty; select.append(blank);
    for (const entry of pipes) {
      const option = document.createElement("option"); option.value = `${entry.area.id}:${entry.pipe.id}`;
      option.textContent = `${entry.area.name} · ${entry.pipe.props.entrance}`; select.append(option);
    }
  };
  const linkA = document.createElement("select"); linkA.dataset["testid"] = "pipe-link-a";
  const linkB = document.createElement("select"); linkB.dataset["testid"] = "pipe-link-b";
  optionFor(linkA, "토관 A"); optionFor(linkB, "토관 B");
  const linkApply = document.createElement("button"); linkApply.type = "button"; linkApply.dataset["testid"] = "pipe-link-apply"; linkApply.textContent = "서로 연결";
  const parseRef = (value: string) => {
    const sep = value.indexOf(":");
    return sep === -1 ? null : { areaId: value.slice(0, sep), pipeId: value.slice(sep + 1) };
  };
  linkApply.addEventListener("click", () => {
    const a = parseRef(linkA.value), b = parseRef(linkB.value);
    if (!a || !b) { showError("연결할 토관 두 개를 선택하세요"); return; }
    commit(host, linkPipes(host.history.document(), a, b));
  });
  const deletePipe = document.createElement("button"); deletePipe.type = "button"; deletePipe.dataset["testid"] = "pipe-delete"; deletePipe.textContent = "선택한 토관 삭제";
  deletePipe.addEventListener("click", () => {
    const a = parseRef(linkA.value);
    if (!a) { showError("삭제할 토관을 선택하세요"); return; }
    commit(host, deleteObjects(host.history.document(), [a.pipeId]));
  });
  const placeWarpBtn = document.createElement("button"); placeWarpBtn.type = "button"; placeWarpBtn.dataset["testid"] = "place-warp"; placeWarpBtn.textContent = "워프 존 배치";
  placeWarpBtn.addEventListener("click", () => {
    commit(host, placeObject(host.history.document(), area.id, { id: host.createId(), kind: "warpZone", x: 160, y: 144 }));
  });
  const warp = area.objects.find(object => object.kind === "warpZone");
  const warpOut = document.createElement("output"); warpOut.dataset["testid"] = "warp-labels";
  warpOut.textContent = warp?.kind === "warpZone" ? warpLabels(course, warp).join(" | ") : "- | - | -";
  const localPipes = area.objects.filter(object => object.kind === "pipe");
  const slots = [0, 1, 2].map(index => {
    const select = document.createElement("select"); select.dataset["testid"] = `warp-slot-${index}`;
    const blank = document.createElement("option"); blank.value = ""; blank.textContent = "-"; select.append(blank);
    for (const pipe of localPipes) {
      const option = document.createElement("option"); option.value = pipe.id; option.textContent = pipe.props.entrance; select.append(option);
    }
    if (warp?.kind === "warpZone") select.value = warp.props.pipeIds[index] ?? "";
    return select;
  });
  const warpApply = document.createElement("button"); warpApply.type = "button"; warpApply.dataset["testid"] = "warp-slots-apply"; warpApply.textContent = "워프 라벨 적용";
  warpApply.addEventListener("click", () => {
    const current = host.history.document();
    const target = current.areas.find(item => item.id === area.id)?.objects.find(object => object.kind === "warpZone");
    if (!target) { showError("워프 존을 먼저 배치하세요"); return; }
    const pipeIds = slots.map(select => select.value === "" ? null : select.value) as [string | null, string | null, string | null];
    commit(host, setObjectProperties(current, area.id, target.id, { pipeIds }));
  });
  const pipeActions = document.createElement("div"); pipeActions.className = "editor-area-actions";
  pipeActions.append(placePipeBtn, placeWarpBtn, linkApply, deletePipe, warpApply);
  pipePanel.append(pipeHeading, pipeActions, linkA, linkB, slots[0]!, slots[1]!, slots[2]!, warpOut);

  root.append(heading, subheading, hero, properties, notice, coursePanel);
  if (kind === "platform") root.append(draft, error);
  root.append(areaPanel, pipePanel);
}
