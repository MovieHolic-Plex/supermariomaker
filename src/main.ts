import { mountAudioGallery } from "./ui/audio-gallery";
import { mountAssetGallery } from "./render/asset-gallery";
import { mountFixtureGallery } from "./ui/fixture-gallery";
import { mountPlayGallery } from "./ui/play-gallery";
import { createNewCourse } from "./level/catalog";
import { validateCourse } from "./level/validate";
import { mountNormalEditor } from "./ui/editor-gallery";

const app = document.getElementById("app");
if (!app) throw new Error("Missing app mount");

if (new URLSearchParams(location.search).get("qa") === "audio") {
  mountAudioGallery(app);
} else if (new URLSearchParams(location.search).get("qa") === "assets") {
  mountAssetGallery(app);
} else if (new URLSearchParams(location.search).get("qa") === "play") {
  mountPlayGallery(app);
} else if (new URLSearchParams(location.search).get("qa") === "fixture") {
  mountFixtureGallery(app);
} else {
  const context = document.createElement("canvas").getContext("2d");
  const editorAvailable = context && typeof structuredClone === "function"
    && typeof ResizeObserver === "function" && typeof globalThis.crypto?.randomUUID === "function";
  let storageAvailable = false;
  try {
    storageAvailable = typeof globalThis.indexedDB !== "undefined";
  } catch (error) {
    // Browser policy may deny access to the getter itself, before IDB.open.
    if (!(error instanceof DOMException && error.name === "SecurityError")) throw error;
  }
  const audioAvailable = typeof globalThis.AudioContext !== "undefined";

  const header = document.createElement("header");
  header.innerHTML = '<span class="brand">SUPER MARIO / COURSE MAKER</span><span class="stage">작업실 기초 버전</span>';
  const main = document.createElement("main");
  app.replaceChildren(header, main);

  if (!editorAvailable || !storageAvailable || !audioAvailable) {
    const alert = document.createElement("section");
    alert.className = "notice";
    alert.dataset["testid"] = "error-dialog";
    alert.setAttribute("role", "alert");
    const message = document.createElement("p");
    message.textContent = !editorAvailable
      ? "필수 브라우저 기능을 사용할 수 없습니다. 최신 Chrome, Edge 또는 Firefox에서 열어 주세요."
      : !storageAvailable
        ? "로컬 저장 불가: 사이트 저장 권한을 확인해 주세요. 메모리에서 코스를 볼 수 있지만 저장과 내보내기는 아직 지원하지 않습니다."
        : "소리 기능을 사용할 수 없습니다. 최신 브라우저에서 다시 열어 주세요. 작업실은 계속 사용할 수 있습니다.";
    const retry = document.createElement("button");
    retry.dataset["testid"] = "retry";
    retry.textContent = "다시 시도";
    retry.addEventListener("click", () => location.reload());
    alert.append(message, retry);
    main.append(alert);
  }

  if (editorAvailable) {
    const library = document.createElement("section");
    library.dataset["testid"] = "library";
    library.className = "library";
    library.innerHTML = '<p class="eyebrow">나의 코스</p><h1>새로운 모험의 시작</h1><p>첫 코스의 이름을 정하고 작업실을 열어 보세요.</p><p class="muted">코스 화면 이동·확대와 요소 미리보기를 사용할 수 있습니다. 편집, 플레이, 저장 및 파일 기능은 아직 제공되지 않습니다.</p>';
    const newCourse = document.createElement("button");
    newCourse.dataset["testid"] = "new-course";
    newCourse.textContent = "새 코스 만들기";
    const form = document.createElement("form");
    form.hidden = true;
    const label = document.createElement("label");
    label.htmlFor = "course-title";
    label.textContent = "코스 이름";
    const title = document.createElement("input");
    title.id = "course-title";
    title.dataset["testid"] = "course-title";
    title.required = true;
    title.maxLength = 80;
    title.value = "새 코스";
    title.autocomplete = "off";
    title.addEventListener("input", () => title.setCustomValidity(""));
    const create = document.createElement("button");
    create.type = "submit";
    create.dataset["testid"] = "create-course";
    create.textContent = "작업실 열기";
    form.append(label, title, create);
    newCourse.addEventListener("click", () => {
      form.hidden = false;
      newCourse.hidden = true;
      title.focus();
      title.select();
    });
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const name = title.value.trim();
      if (name.length === 0) {
        title.setCustomValidity("코스 이름을 입력해 주세요.");
        title.reportValidity();
        return;
      }
      // The catalog owns the exact seed; the form title crosses the existing validator once.
      try {
        const seed = createNewCourse({ courseId: crypto.randomUUID(), areaId: crypto.randomUUID(), goalId: crypto.randomUUID() });
        if (!seed.ok) throw new Error(`${seed.error.code}: ${seed.error.message}`);
        const result = validateCourse({ ...seed.value, title: name });
        if (!result.ok) {
          title.setCustomValidity(result.error.message); title.reportValidity(); return;
        }
        const host = document.createElement("div"), editorRoot = document.createElement("div");
        host.className = "normal-editor-host"; editorRoot.className = "normal-editor-root";
        const notice = main.querySelector('[data-testid="error-dialog"]');
        host.append(editorRoot); app.append(host);
        const editor = mountNormalEditor(editorRoot, result.value);
        if (notice) host.prepend(notice);
        app.replaceChildren(host);
        editor.element.querySelector<HTMLElement>('[data-testid="editor-canvas"]')?.focus();
        document.title = `${result.value.title} | 코스 메이커`;
      } catch (error) {
        app.querySelector(".normal-editor-host")?.remove();
        const failure = document.createElement("p"); failure.setAttribute("role", "alert");
        failure.dataset["testid"] = "create-error";
        failure.textContent = `코스를 열지 못했습니다. 다시 시도해 주세요. ${error instanceof Error ? error.message : String(error)}`;
        form.querySelector('[data-testid="create-error"]')?.remove(); form.append(failure);
      }
    });
    library.append(newCourse, form);
    main.append(library);
  }
}
