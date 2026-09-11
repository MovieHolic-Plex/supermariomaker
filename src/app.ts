import { createNewCourse } from "./level/catalog";
import { validateCourse } from "./level/validate";
import type { CourseV1 } from "./level/types";
import { openDatabase, type DatabaseHandle } from "./storage/db";
import { loadLastOpen } from "./storage/host";
import { mountNormalEditor, type EditorPersistence } from "./ui/editor-gallery";
import { mountLibrary } from "./ui/library";

export async function bootApp(app: HTMLElement): Promise<void> {
  const context = document.createElement("canvas").getContext("2d");
  const editorAvailable = context && typeof structuredClone === "function"
    && typeof ResizeObserver === "function" && typeof globalThis.crypto?.randomUUID === "function";
  let storageAvailable = false;
  try {
    storageAvailable = typeof globalThis.indexedDB !== "undefined";
  } catch (error) {
    if (!(error instanceof DOMException && error.name === "SecurityError")) throw error;
  }
  const audioAvailable = typeof globalThis.AudioContext !== "undefined";

  const header = document.createElement("header");
  header.innerHTML = '<span class="brand">슈퍼 마리오 / 코스 메이커</span><span class="stage">작업실 기초 버전</span>';
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

  let workspace: { dispose: () => void } | null = null;

  function openEditor(course: CourseV1, persistence: EditorPersistence, notice?: Element | null) {
    workspace?.dispose();
    const host = document.createElement("div"), editorRoot = document.createElement("div");
    host.className = "normal-editor-host"; editorRoot.className = "normal-editor-root";
    host.append(editorRoot);
    const editor = mountNormalEditor(editorRoot, course, {
      ...persistence,
      onOpenLibrary: () => {
        editor.dispose();
        workspace = null;
        void showLibrary(persistence, true);
      },
    });
    workspace = editor;
    if (notice) host.prepend(notice);
    app.replaceChildren(host);
    editor.element.querySelector<HTMLElement>('[data-testid="editor-canvas"]')?.focus();
    document.title = `${course.title} | 코스 메이커`;
  }

  function showMemoryLibrary(persistence: EditorPersistence) {
    const library = document.createElement("section");
    library.dataset["testid"] = "library";
    library.className = "library";
    library.innerHTML = '<p class="eyebrow">나의 코스</p><h1>새로운 모험의 시작</h1><p>첫 코스의 이름을 정하고 작업실을 열어 보세요.</p>';
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
      const seed = createNewCourse({ courseId: crypto.randomUUID(), areaId: crypto.randomUUID(), goalId: crypto.randomUUID() });
      if (!seed.ok) {
        title.setCustomValidity(seed.error.message);
        title.reportValidity();
        return;
      }
      const result = validateCourse({ ...seed.value, title: name });
      if (!result.ok) {
        title.setCustomValidity(result.error.message);
        title.reportValidity();
        return;
      }
      openEditor(result.value, { ...persistence, expectedStoredRevision: null }, main.querySelector('[data-testid="error-dialog"]'));
    });
    library.append(newCourse, form);
    main.append(library);
  }

  async function showLibrary(persistence: EditorPersistence, forceList = false) {
    workspace?.dispose();
    workspace = null;
    app.replaceChildren(header, main);
    main.replaceChildren();
    const notice = persistence.unavailable ? document.querySelector('[data-testid="error-dialog"]') : null;
    if (!editorAvailable) return;
    if (!persistence.db) {
      if (notice) main.append(notice);
      showMemoryLibrary(persistence);
      return;
    }
    const root = document.createElement("div");
    main.append(root);
    const view = mountLibrary(root, {
      db: persistence.db,
      onOpen: (record) => {
        view.dispose();
        openEditor(record.document, {
          db: persistence.db,
          expectedStoredRevision: record.document.revision,
          ...(persistence.unavailable === undefined ? {} : { unavailable: persistence.unavailable }),
        }, main.querySelector('[data-testid="error-dialog"]'));
      },
    });
    workspace = view;
    if (forceList) document.title = "코스 보관함 | 코스 메이커";
    void notice;
  }

  async function bootWorkspace() {
    let db: DatabaseHandle | null = null;
    let unavailable = !storageAvailable;
    if (storageAvailable) {
      const opened = await openDatabase();
      if (opened.ok) db = opened.db;
      else {
        unavailable = true;
        if (!main.querySelector('[data-testid="error-dialog"]')) {
          const alert = document.createElement("section");
          alert.className = "notice";
          alert.dataset["testid"] = "error-dialog";
          alert.setAttribute("role", "alert");
          const message = document.createElement("p");
          message.textContent = "로컬 저장 불가: 브라우저 저장소를 열 수 없습니다. 메모리에서 편집할 수 있습니다.";
          const retry = document.createElement("button");
          retry.dataset["testid"] = "retry";
          retry.textContent = "다시 시도";
          retry.addEventListener("click", () => location.reload());
          alert.append(message, retry);
          main.append(alert);
        }
      }
    }
    const persistence: EditorPersistence = { db, expectedStoredRevision: null, unavailable };
    if (db) {
      const last = await loadLastOpen(db);
      if (last) {
        const result = validateCourse(last.document);
        if (result.ok) {
          openEditor(result.value, { db, expectedStoredRevision: result.value.revision, unavailable: false }, main.querySelector('[data-testid="error-dialog"]'));
          return;
        }
      }
    }
    await showLibrary(persistence);
  }

  if (editorAvailable) await bootWorkspace();
}
