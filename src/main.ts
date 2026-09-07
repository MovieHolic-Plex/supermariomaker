import { mountAudioGallery } from "./ui/audio-gallery";
import { mountAssetGallery } from "./render/asset-gallery";

const app = document.getElementById("app");
if (!app) throw new Error("Missing app mount");

if (new URLSearchParams(location.search).get("qa") === "audio") {
  mountAudioGallery(app);
} else if (new URLSearchParams(location.search).get("qa") === "assets") {
  mountAssetGallery(app);
} else {
  const canvas = document.createElement("canvas");
  canvas.width = 768;
  canvas.height = 320;
  canvas.dataset["testid"] = "editor-canvas";
  canvas.setAttribute("aria-label", "편집 작업 영역 — 편집 도구는 아직 준비 중입니다");
  const context = canvas.getContext("2d");
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

  if (!context || !storageAvailable || !audioAvailable || typeof structuredClone !== "function") {
    const alert = document.createElement("section");
    alert.className = "notice";
    alert.dataset["testid"] = "error-dialog";
    alert.setAttribute("role", "alert");
    const message = document.createElement("p");
    message.textContent = !context || typeof structuredClone !== "function"
      ? "필수 브라우저 기능을 사용할 수 없습니다. 최신 Chrome, Edge 또는 Firefox에서 열어 주세요."
      : !storageAvailable
        ? "로컬 저장 불가: 브라우저의 사이트 저장 권한을 확인해 주세요. 이 기초 버전에서는 제목 입력과 작업실 열기만 가능합니다."
        : "소리 기능을 사용할 수 없습니다. 최신 브라우저에서 다시 열어 주세요. 작업실은 계속 사용할 수 있습니다.";
    const retry = document.createElement("button");
    retry.dataset["testid"] = "retry";
    retry.textContent = "다시 시도";
    retry.addEventListener("click", () => location.reload());
    alert.append(message, retry);
    main.append(alert);
  }

  if (context && typeof structuredClone === "function") {
    const library = document.createElement("section");
    library.dataset["testid"] = "library";
    library.className = "library";
    library.innerHTML = '<p class="eyebrow">나의 코스</p><h1>새로운 모험의 시작</h1><p>첫 코스의 이름을 정하고 작업실을 열어 보세요.</p><p class="muted">현재는 기초 화면입니다. 코스 편집, 플레이, 저장 및 파일 기능은 아직 제공되지 않습니다.</p>';
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
      const workspace = document.createElement("section");
      workspace.className = "workspace";
      const heading = document.createElement("h1");
      heading.textContent = name;
      heading.tabIndex = -1;
      const status = document.createElement("p");
      status.dataset["testid"] = "save-status";
      status.textContent = "저장 기능 준비 중 — 이 제목은 저장되지 않습니다.";
      const description = document.createElement("p");
      description.textContent = "편집 작업 영역 · 편집 도구와 플레이 기능은 준비 중입니다.";
      workspace.append(heading, status, description, canvas);
      library.replaceWith(workspace);
      heading.focus();
      document.title = `${name} | 코스 메이커`;
    });
    library.append(newCourse, form);
    main.append(library);
  }
}
