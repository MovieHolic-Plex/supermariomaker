import type { AutosaveSession } from "../storage/autosave";
import type { CourseRecord, DatabaseHandle, StorageError } from "../storage/db";
import {
  createLibraryCourse,
  deleteLibraryCourse,
  duplicateLibraryCourse,
  listCourses,
  openLibraryCourse,
  renameLibraryCourse,
  resolveLibraryConflict,
  switchOpenCourse,
  type LibraryNow,
} from "../storage/library";

export type LibraryView = Readonly<{
  element: HTMLElement;
  dispose: () => void;
  refresh: () => Promise<void>;
}>;

export type LibraryViewOptions = Readonly<{
  db: DatabaseHandle;
  now?: LibraryNow;
  current?: AutosaveSession;
  onOpen?: (record: CourseRecord) => void;
}>;

type DialogState =
  | Readonly<{ kind: "none" }>
  | Readonly<{ kind: "delete"; id: string }>
  | Readonly<{ kind: "rename"; id: string; title: string }>
  | Readonly<{ kind: "dirty-switch"; targetId: string }>
  | Readonly<{ kind: "conflict"; storedRevision: number }>
  | Readonly<{ kind: "error"; error: StorageError }>;

function testid(element: HTMLElement, id: string): void {
  element.dataset["testid"] = id;
}

function button(label: string, id: string): HTMLButtonElement {
  const element = document.createElement("button");
  element.type = "button";
  element.textContent = label;
  testid(element, id);
  return element;
}

export function mountLibrary(root: HTMLElement, options: LibraryViewOptions): LibraryView {
  const events = new AbortController();
  const createOptions = options.now ? { now: options.now } : {};
  let records: readonly CourseRecord[] = [];
  let dialog: DialogState = { kind: "none" };
  let disposed = false;

  const element = document.createElement("section");
  testid(element, "library");
  element.className = "library";
  const style = document.createElement("style");
  style.textContent = `
    [data-testid=library] { max-width:720px; margin:24px auto; padding:24px; background:var(--surface); border:1px solid var(--border); }
    [data-testid=library] h1 { font-size:28px; margin:0 0 8px; }
    [data-testid=library] p { margin:0 0 16px; word-break:keep-all; }
    [data-testid=library] button { min-height:44px; margin:0 8px 12px 0; padding:8px 16px; }
    [data-testid=library] input { display:block; width:100%; min-height:44px; margin:8px 0 16px; padding:8px; font:inherit; }
    [data-testid=library] [data-testid=library-blank], [data-testid=course-list] { margin:16px 0; }
    [data-testid=library] [data-testid=course-list] { list-style:none; padding:0; }
    [data-testid=library] [data-testid=course-list] li { display:flex; flex-wrap:wrap; gap:8px; align-items:center; padding:12px 0; border-top:1px solid var(--border); }
    [data-testid=library] [data-testid=library-dialog] { margin:16px 0; padding:16px; border:2px solid var(--border); }
    [data-testid=library] [hidden] { display:none; }
  `;
  const heading = document.createElement("p");
  heading.className = "eyebrow";
  heading.textContent = "나의 코스";
  const title = document.createElement("h1");
  title.textContent = "코스 보관함";
  const newCourse = button("새 코스 만들기", "new-course");
  const form = document.createElement("form");
  form.hidden = true;
  const label = document.createElement("label");
  label.htmlFor = "course-title";
  label.textContent = "코스 이름";
  const titleInput = document.createElement("input");
  titleInput.id = "course-title";
  testid(titleInput, "course-title");
  titleInput.required = true;
  titleInput.maxLength = 80;
  titleInput.value = "새 코스";
  titleInput.autocomplete = "off";
  const create = document.createElement("button");
  create.type = "submit";
  testid(create, "create-course");
  create.textContent = "작업실 열기";
  form.append(label, titleInput, create);
  const blank = document.createElement("div");
  testid(blank, "library-blank");
  const blankText = document.createElement("p");
  blankText.textContent = "저장된 코스가 없습니다. 새 코스를 만들어 편집을 시작하세요.";
  blank.append(blankText);
  const list = document.createElement("ul");
  testid(list, "course-list");
  const dialogBox = document.createElement("section");
  testid(dialogBox, "library-dialog");
  dialogBox.hidden = true;
  dialogBox.setAttribute("role", "dialog");
  element.append(style, heading, title, newCourse, form, blank, list, dialogBox);
  root.replaceChildren(element);

  function showCreate(): void {
    form.hidden = false;
    newCourse.hidden = true;
    titleInput.focus();
    titleInput.select();
  }

  function renderList(): void {
    const empty = records.length === 0;
    blank.hidden = !empty;
    list.hidden = empty;
    newCourse.hidden = !form.hidden;
    list.replaceChildren();
    for (const record of records) {
      const item = document.createElement("li");
      item.dataset["courseId"] = record.id;
      const name = document.createElement("strong");
      name.textContent = record.title;
      const open = button("열기", "open-course");
      const rename = button("이름 변경", "rename-course");
      const duplicate = button("복제", "duplicate-course");
      const remove = button("삭제", "delete-course");
      open.addEventListener("click", () => { void requestOpen(record.id); }, { signal: events.signal });
      rename.addEventListener("click", () => { dialog = { kind: "rename", id: record.id, title: record.title }; renderDialog(); }, { signal: events.signal });
      duplicate.addEventListener("click", () => { void onDuplicate(record.id); }, { signal: events.signal });
      remove.addEventListener("click", () => { dialog = { kind: "delete", id: record.id }; renderDialog(); }, { signal: events.signal });
      item.append(name, open, rename, duplicate, remove);
      list.append(item);
    }
  }

  function renderDialog(): void {
    dialogBox.replaceChildren();
    testid(dialogBox, "library-dialog");
    delete dialogBox.dataset["errorKind"];
    if (dialog.kind === "none") {
      dialogBox.hidden = true;
      return;
    }
    dialogBox.hidden = false;
    const message = document.createElement("p");
    const confirm = button("확인", "confirm");
    const cancel = button("취소", "cancel");
    if (dialog.kind === "delete") {
      message.textContent = "이 코스를 삭제합니다. 로컬 저장소에서는 되돌릴 수 없습니다.";
      confirm.addEventListener("click", () => { void onDelete(true); }, { signal: events.signal });
      cancel.addEventListener("click", () => { void onDelete(false); }, { signal: events.signal });
      dialogBox.append(message, confirm, cancel);
      return;
    }
    if (dialog.kind === "rename") {
      message.textContent = "코스 이름을 입력하세요. 앞뒤 공백 없이 1–80자여야 합니다.";
      const input = document.createElement("input");
      testid(input, "rename-title");
      input.value = dialog.title;
      input.maxLength = 80;
      confirm.addEventListener("click", () => { void onRename(input.value); }, { signal: events.signal });
      cancel.addEventListener("click", () => { dialog = { kind: "none" }; renderDialog(); }, { signal: events.signal });
      dialogBox.append(message, input, confirm, cancel);
      return;
    }
    if (dialog.kind === "dirty-switch") {
      message.textContent = "저장하지 않은 변경이 있습니다.";
      confirm.textContent = "저장하고 열기";
      const discard = button("버리고 열기", "discard-course");
      confirm.addEventListener("click", () => { void onSwitch("save-and-open"); }, { signal: events.signal });
      discard.addEventListener("click", () => { void onSwitch("discard-and-open"); }, { signal: events.signal });
      cancel.addEventListener("click", () => { void onSwitch("cancel"); }, { signal: events.signal });
      dialogBox.append(message, confirm, discard, cancel);
      return;
    }
    if (dialog.kind === "conflict") {
      testid(dialogBox, "error-dialog");
      message.textContent = "저장된 코스가 더 최신입니다. 다시 불러오거나 사본으로 저장하세요.";
      confirm.textContent = "사본 저장";
      const reload = button("다시 불러오기", "reload-course");
      confirm.addEventListener("click", () => { void onConflict("save-copy"); }, { signal: events.signal });
      reload.addEventListener("click", () => { void onConflict("reload"); }, { signal: events.signal });
      cancel.addEventListener("click", () => { dialog = { kind: "none" }; renderDialog(); }, { signal: events.signal });
      dialogBox.append(message, reload, confirm, cancel);
      return;
    }
    testid(dialogBox, "error-dialog");
    dialogBox.dataset["errorKind"] = dialog.error.kind;
    message.textContent = "저장에 실패했습니다. 편집 내용은 유지됩니다.";
    cancel.textContent = "닫기";
    cancel.addEventListener("click", () => { dialog = { kind: "none" }; renderDialog(); }, { signal: events.signal });
    dialogBox.append(message, cancel);
  }

  async function refresh(): Promise<void> {
    if (disposed) return;
    records = await listCourses(options.db);
    if (disposed) return;
    renderList();
    renderDialog();
  }

  async function requestOpen(id: string): Promise<void> {
    const current = options.current;
    if (current && current.status().dirty) {
      dialog = { kind: "dirty-switch", targetId: id };
      renderDialog();
      return;
    }
    const opened = await openLibraryCourse(options.db, id);
    if (opened.status === "opened") options.onOpen?.(opened.record);
  }

  async function onSwitch(action: "save-and-open" | "discard-and-open" | "cancel"): Promise<void> {
    if (dialog.kind !== "dirty-switch" || !options.current) return;
    const targetId = dialog.targetId;
    const result = await switchOpenCourse(options.db, options.current, action === "cancel" ? { action } : { action, targetId });
    if (result.status === "cancelled") {
      dialog = { kind: "none" };
      renderDialog();
      return;
    }
    if (result.status === "save-failed") {
      dialog = { kind: "error", error: result.error };
      renderDialog();
      return;
    }
    if (result.status === "conflict") {
      dialog = { kind: "conflict", storedRevision: result.storedRevision };
      renderDialog();
      return;
    }
    dialog = { kind: "none" };
    renderDialog();
    if (result.status === "opened") options.onOpen?.(result.record);
  }

  async function onConflict(decision: "reload" | "save-copy"): Promise<void> {
    if (!options.current) return;
    const result = await resolveLibraryConflict(options.db, options.current, decision, createOptions);
    dialog = { kind: "none" };
    if (result.status === "failed") dialog = { kind: "error", error: result.error };
    await refresh();
    if (result.status === "reloaded" || result.status === "copied") options.onOpen?.(result.record);
  }

  async function onDelete(confirmed: boolean): Promise<void> {
    if (dialog.kind !== "delete") return;
    const id = dialog.id;
    const session = options.current;
    const result = session
      ? await deleteLibraryCourse(options.db, id, { confirmed }, { session })
      : await deleteLibraryCourse(options.db, id, { confirmed });
    dialog = { kind: "none" };
    if (result.status === "failed") dialog = { kind: "error", error: result.error };
    await refresh();
  }

  async function onRename(titleValue: string): Promise<void> {
    if (dialog.kind !== "rename") return;
    const result = await renameLibraryCourse(options.db, dialog.id, titleValue, createOptions);
    if (result.status === "invalid") {
      dialogBox.querySelector("p")?.replaceChildren(document.createTextNode("이름을 1–80자로 입력하고 앞뒤 공백을 제거하세요."));
      return;
    }
    dialog = { kind: "none" };
    if (result.status === "failed") dialog = { kind: "error", error: result.error };
    await refresh();
  }

  async function onDuplicate(id: string): Promise<void> {
    const result = await duplicateLibraryCourse(options.db, id, createOptions);
    if (result.status === "failed") {
      dialog = { kind: "error", error: result.error };
      renderDialog();
      return;
    }
    await refresh();
  }

  newCourse.addEventListener("click", showCreate, { signal: events.signal });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void (async () => {
      const created = await createLibraryCourse(options.db, { ...createOptions, title: titleInput.value.trim() });
      if (created.status === "invalid") {
        titleInput.setCustomValidity("코스 이름을 1–80자로 입력해 주세요.");
        titleInput.reportValidity();
        return;
      }
      if (created.status !== "created") {
        dialog = { kind: "error", error: created.status === "failed" ? created.error : { kind: "conflict", name: "constraint" } };
        renderDialog();
        return;
      }
      await refresh();
      options.onOpen?.(created.record);
    })();
  }, { signal: events.signal });

  void refresh();

  return {
    element,
    async refresh() { await refresh(); },
    dispose() {
      disposed = true;
      events.abort();
      element.remove();
    },
  };
}
