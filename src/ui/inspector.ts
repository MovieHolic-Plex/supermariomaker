import { createArea, deleteArea, linkPipes, placePipe, previewResize, renameArea, resizeArea, setAreaTheme, warpLabels } from "../editor/areas";
import { deleteObjects, placeObject, setCourseFields, setObjectProperties } from "../editor/commands";
import type { EditorHistory } from "../editor/history";
import { commitCourseProperties, commitObjectProperties } from "../editor/selection";
import { getFrame } from "../assets/manifest";
import { CATALOG_CATEGORIES, createObject, OBJECT_CATALOG, SPAWNED_CATALOG, TILE_CATALOG, type SpawnedKind } from "../level/catalog";
import type { AreaV1, CourseV1, ObjectKind, PlacedObject, Theme, TileKind, ValidationResult } from "../level/types";
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

function pipesIn(area: AreaV1): Extract<PlacedObject, { kind: "pipe" }>[] {
  return area.objects.filter((object): object is Extract<PlacedObject, { kind: "pipe" }> => object.kind === "pipe");
}

function liveObject(host: InspectorHost, areaId: string, objectId: string): PlacedObject | undefined {
  return host.history.document().areas.find(item => item.id === areaId)?.objects.find(item => item.id === objectId);
}

function mergeObjectProps(object: PlacedObject, patch: Record<string, unknown>): unknown {
  if (object.kind === "castleGoal") {
    const bridgePatch = patch["bridge"];
    const bridge = { ...object.props.bridge, ...(typeof bridgePatch === "object" && bridgePatch !== null ? bridgePatch : {}) };
    const next: Record<string, unknown> = { bridge };
    if (object.props.bowserId !== undefined) next["bowserId"] = object.props.bowserId;
    if (Object.hasOwn(patch, "bowserId")) {
      if (patch["bowserId"]) next["bowserId"] = patch["bowserId"];
      else delete next["bowserId"];
    }
    return next;
  }
  if (object.kind === "pipe") {
    const next: Record<string, unknown> = { height: object.props.height, entrance: object.props.entrance };
    if (object.props.destination) next["destination"] = object.props.destination;
    Object.assign(next, patch);
    if (Object.hasOwn(patch, "destination") && !patch["destination"]) delete next["destination"];
    return next;
  }
  if (object.kind === "platform") {
    const next: Record<string, unknown> = {
      motion: object.props.motion, length: object.props.length, travel: object.props.travel, speed: object.props.speed,
    };
    if (object.props.motion === "balance" && object.props.pairId) next["pairId"] = object.props.pairId;
    Object.assign(next, patch);
    if (next["motion"] !== "balance") delete next["pairId"];
    if (Object.hasOwn(patch, "pairId") && !patch["pairId"]) delete next["pairId"];
    return next;
  }
  if (object.kind === "warpZone" && Object.hasOwn(patch, "pipeIds")) return { pipeIds: patch["pipeIds"] };
  return { ...object.props, ...patch };
}

function showFieldError(control: HTMLElement, error: HTMLParagraphElement, message: string, label: HTMLElement): void {
  error.hidden = false; error.textContent = message;
  if (control instanceof HTMLInputElement || control instanceof HTMLSelectElement) control.setCustomValidity(message);
  control.classList.add("editor-field-invalid"); control.setAttribute("aria-invalid", "true");
  label.scrollIntoView({ block: "nearest", inline: "nearest" });
}

function hideFieldError(control: HTMLElement, error: HTMLParagraphElement): void {
  error.hidden = true; error.textContent = "";
  if (control instanceof HTMLInputElement || control instanceof HTMLSelectElement) control.setCustomValidity("");
  control.classList.remove("editor-field-invalid"); control.setAttribute("aria-invalid", "false");
}

function bindObjectField(
  host: InspectorHost, areaId: string, objectId: string, control: HTMLElement, error: HTMLParagraphElement, label: HTMLElement,
  readProps: () => unknown,
): void {
  const preview = () => {
    const result = setObjectProperties(host.history.document(), areaId, objectId, readProps());
    if (result.ok) hideFieldError(control, error);
    else showFieldError(control, error, `${result.error.code}:${result.error.path}`, label);
  };
  const commitField = () => {
    const props = readProps();
    const outcome = commitObjectProperties(host.history, areaId, objectId, props);
    if (outcome.status === "committed") host.onCommitted();
    else if (outcome.status === "rejected") {
      const result = setObjectProperties(host.history.document(), areaId, objectId, props);
      showFieldError(control, error, result.ok ? "rejected" : `${result.error.code}:${result.error.path}`, label);
      host.onRejected();
    }
  };
  control.addEventListener("input", preview);
  control.addEventListener("change", commitField);
}

function integerControl(document: Document, testid: string, value: number, min: number, max: number): HTMLInputElement {
  const input = document.createElement("input");
  input.type = "number"; input.dataset["testid"] = testid; input.value = String(value);
  input.min = String(min); input.max = String(max); input.step = "1"; input.autocomplete = "off";
  return input;
}

function choiceControl(document: Document, testid: string, value: string, options: readonly { value: string; label: string }[]): HTMLSelectElement {
  const select = document.createElement("select"); select.dataset["testid"] = testid;
  for (const item of options) {
    const option = document.createElement("option"); option.value = item.value; option.textContent = item.label; select.append(option);
  }
  select.value = value;
  return select;
}

function fieldShell(document: Document, caption: string, testid: string): {
  label: HTMLLabelElement; error: HTMLParagraphElement;
} {
  const label = document.createElement("label"); label.className = "editor-field";
  const title = document.createElement("span"); title.className = "editor-field-caption"; title.textContent = caption;
  const error = document.createElement("p"); error.className = "editor-notice editor-field-error";
  error.dataset["testid"] = `${testid}-error`; error.hidden = true;
  label.append(title);
  return { label, error };
}

function appendObjectProperties(
  root: HTMLElement, document: Document, course: CourseV1, area: AreaV1, selected: PlacedObject, host: InspectorHost,
): void {
  const panel = document.createElement("section");
  panel.className = "editor-area-panel";
  panel.dataset["testid"] = "object-properties";
  panel.dataset["objectId"] = selected.id;
  panel.dataset["kind"] = selected.kind;
  const heading = document.createElement("h3"); heading.className = "editor-section-heading"; heading.textContent = "배치된 오브젝트";
  panel.append(heading);
  const patch = (next: Record<string, unknown>) => {
    const object = liveObject(host, area.id, selected.id);
    return object ? mergeObjectProps(object, next) : next;
  };
  const addInteger = (testid: string, caption: string, value: number, min: number, max: number, read: (n: number) => Record<string, unknown>) => {
    const { label, error } = fieldShell(document, caption, testid);
    const input = integerControl(document, testid, value, min, max);
    bindObjectField(host, area.id, selected.id, input, error, label, () => patch(read(Number(input.value))));
    label.append(input, error); panel.append(label);
  };
  const addChoice = (testid: string, caption: string, value: string, options: readonly { value: string; label: string }[], read: (value: string) => Record<string, unknown>) => {
    const { label, error } = fieldShell(document, caption, testid);
    const select = choiceControl(document, testid, value, options);
    bindObjectField(host, area.id, selected.id, select, error, label, () => patch(read(select.value)));
    label.append(select, error); panel.append(label);
  };
  switch (selected.kind) {
    case "pipe": {
      addInteger("object-prop-height", "높이", selected.props.height, 2, 16, height => ({ height }));
      addChoice("object-prop-entrance", "입구", selected.props.entrance, [
        { value: "none", label: "none" }, { value: "down", label: "down" }, { value: "up", label: "up" },
      ], entrance => ({ entrance }));
      const destValue = selected.props.destination ? `${selected.props.destination.areaId}:${selected.props.destination.pipeId}` : "";
      const destOptions = [{ value: "", label: "-" }, ...course.areas.flatMap(item => pipesIn(item).filter(pipe => pipe.id !== selected.id).map(pipe => ({
        value: `${item.id}:${pipe.id}`, label: `${item.name} · ${pipe.props.entrance}`,
      })))];
      addChoice("object-prop-destination", "연결 토관", destValue, destOptions, value => {
        const sep = value.indexOf(":");
        if (sep === -1) return { destination: undefined };
        return { destination: { areaId: value.slice(0, sep), pipeId: value.slice(sep + 1) } };
      });
      break;
    }
    case "platform": {
      addChoice("object-prop-motion", "이동", selected.props.motion, [
        { value: "horizontal", label: "horizontal" }, { value: "vertical", label: "vertical" },
        { value: "falling", label: "falling" }, { value: "balance", label: "balance" },
      ], motion => ({ motion }));
      addInteger("object-prop-length", "길이", selected.props.length, 2, 8, length => ({ length }));
      addInteger("object-prop-travel", "이동 거리", selected.props.travel, 1, 32, travel => ({ travel }));
      addChoice("object-prop-speed", "속도", String(selected.props.speed), [
        { value: "0.5", label: "0.5" }, { value: "1", label: "1" }, { value: "2", label: "2" },
      ], value => ({ speed: Number(value) }));
      if (selected.props.motion === "balance") {
        const pairValue = selected.props.pairId ?? "";
        const pairOptions = [{ value: "", label: "-" }, ...area.objects.filter(object => object.kind === "platform" && object.id !== selected.id).map(object => ({
          value: object.id, label: object.id.slice(0, 8),
        }))];
        addChoice("object-prop-pairId", "균형 짝", pairValue, pairOptions, pairId => ({ pairId: pairId === "" ? undefined : pairId }));
      }
      break;
    }
    case "flagGoal":
      addInteger("object-prop-height", "깃대 높이", selected.props.height, 4, 12, height => ({ height }));
      break;
    case "castleGoal": {
      addInteger("object-prop-bridge-x", "가로 위치", selected.props.bridge.x, 0, area.width - 1, x => ({ bridge: { x } }));
      addInteger("object-prop-bridge-y", "세로 위치", selected.props.bridge.y, 0, area.height - 1, y => ({ bridge: { y } }));
      addInteger("object-prop-bridge-width", "너비", selected.props.bridge.width, 1, 64, width => ({ bridge: { width } }));
      addChoice("object-prop-bridge-height", "높이", "1", [{ value: "1", label: "1" }], () => ({ bridge: { height: 1 } }));
      const bowserValue = selected.props.bowserId ?? "";
      const bowserOptions = [{ value: "", label: "-" }, ...area.objects.filter(object => object.kind === "bowser").map(object => ({
        value: object.id, label: object.id.slice(0, 8),
      }))];
      addChoice("object-prop-bowserId", "쿠파", bowserValue, bowserOptions, bowserId => ({ bowserId: bowserId === "" ? undefined : bowserId }));
      break;
    }
    case "koopa":
      addChoice("object-prop-color", "색상", selected.props.color, [
        { value: "green", label: "green" }, { value: "red", label: "red" },
      ], color => ({ color }));
      break;
    case "paratroopa":
      addChoice("object-prop-color", "색상", selected.props.color, [
        { value: "green", label: "green" }, { value: "red", label: "red" },
      ], color => ({ color }));
      addChoice("object-prop-motion", "이동", selected.props.motion, [
        { value: "hop", label: "hop" }, { value: "vertical", label: "vertical" },
      ], motion => ({ motion }));
      break;
    case "piranha": {
      const pipeOptions = pipesIn(area).map(pipe => ({
        value: pipe.id, label: `${pipe.props.entrance} · ${pipe.id.slice(0, 8)}`,
      }));
      addChoice("object-prop-pipeId", "붙일 토관", selected.props.pipeId, pipeOptions, pipeId => ({ pipeId }));
      break;
    }
    case "cheep":
      addChoice("object-prop-color", "색상", selected.props.color, [
        { value: "green", label: "green" }, { value: "red", label: "red" },
      ], color => ({ color }));
      addChoice("object-prop-mode", "이동", selected.props.mode, [
        { value: "swim", label: "swim" }, { value: "leap", label: "leap" },
      ], mode => ({ mode }));
      break;
    case "firebar":
      addInteger("object-prop-length", "길이", selected.props.length, 3, 12, length => ({ length }));
      addChoice("object-prop-direction", "회전 방향", selected.props.direction, [
        { value: "cw", label: "cw" }, { value: "ccw", label: "ccw" },
      ], direction => ({ direction }));
      addChoice("object-prop-speed", "회전 속도", selected.props.speed, [
        { value: "slow", label: "slow" }, { value: "normal", label: "normal" }, { value: "fast", label: "fast" },
      ], speed => ({ speed }));
      break;
    case "warpZone":
      for (const index of [0, 1, 2] as const) {
        const testid = `object-prop-pipeIds-${index}`;
        const current = selected.props.pipeIds[index] ?? "";
        const options = [{ value: "", label: "-" }, ...pipesIn(area).map(pipe => ({
          value: pipe.id, label: pipe.props.entrance,
        }))];
        addChoice(testid, `목적지 토관 ${index + 1}`, current, options, value => {
          const object = liveObject(host, area.id, selected.id);
          const slots: [string | null, string | null, string | null] = object?.kind === "warpZone"
            ? [...object.props.pipeIds] : [null, null, null];
          slots[index] = value === "" ? null : value;
          return { pipeIds: slots };
        });
      }
      break;
    case "spring": case "goomba": case "buzzy": case "billCannon": case "hammerBro":
    case "lakitu": case "blooper": case "podoboo": case "bowser": {
      const note = document.createElement("p"); note.className = "editor-notice"; note.dataset["testid"] = "object-prop-empty";
      note.textContent = "설정할 속성이 없습니다";
      panel.append(note);
      break;
    }
    default: break;
  }
  root.append(panel);
}

export function renderInspector(
  root: HTMLElement, course: CourseV1, area: AreaV1, kind: PaletteKind, host: InspectorHost, selected?: PlacedObject,
): void {
  const document = root.ownerDocument, previewKind = selected?.kind ?? kind, entry = EDITOR_CATALOG[previewKind];
  root.replaceChildren();
  const heading = document.createElement("h2"); heading.textContent = selected ? "배치된 오브젝트 속성" : "속성 미리보기";
  const subheading = document.createElement("p"); subheading.className = "editor-eyebrow"; subheading.textContent = `${CATALOG_CATEGORIES[entry.category]} / ${entry.placeable ? "배치 요소" : "자동 생성"}`;
  const hero = document.createElement("div"); hero.className = "editor-inspector-hero";
  const name = document.createElement("h3"); name.textContent = entry.label; name.dataset["testid"] = "preview-kind"; name.dataset["kind"] = previewKind;
  hero.append(catalogIcon(document, previewKind, area.theme, 80), name);
  const properties = document.createElement("dl"); properties.className = "editor-facts";
  const row = (label: string, value: string) => { const dt = document.createElement("dt"), dd = document.createElement("dd"); dt.textContent = label; dd.textContent = value; properties.append(dt, dd); };
  row("기준 격자", "16×16픽셀");
  if (!selected) {
    if ("defaults" in entry && typeof entry.defaults !== "function") {
      for (const [key, value] of Object.entries(entry.defaults)) {
        const field = Object.entries(entry.properties).find(([prop]) => prop === key)?.[1];
        row(field?.label ?? key, typeof value === "object" ? JSON.stringify(value) : String(value));
      }
    } else row("기본 속성", kind === "piranha" ? "연결할 토관이 필요합니다" : "배치 위치에서 결정됩니다");
  }
  const notice = document.createElement("p"); notice.className = "editor-notice"; notice.textContent = "타일 그리기·지우기·채우기를 사용할 수 있습니다. 선택 도구로 복사·이동하고, 시작/목표는 아래에서 배치합니다.";
  const draft = document.createElement("label");
  const error = document.createElement("p"); error.className = "editor-notice"; error.dataset["testid"] = "property-error"; error.hidden = true;
  if (!selected && kind === "platform") {
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
  if (selected) appendObjectProperties(root, document, course, area, selected, host);
  if (!selected && kind === "platform") root.append(draft, error);
  root.append(areaPanel, pipePanel);
}
