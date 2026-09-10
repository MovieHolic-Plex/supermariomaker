import { describe, expect, test } from "bun:test";
import { setCourseFields } from "../src/editor/commands";
import { createHistory } from "../src/editor/history";
import { authoredContentEqual } from "../src/level/serialize";
import type { CourseV1, ValidationResult } from "../src/level/types";
import {
  COURSES_STORE, SETTINGS_STORE, createMemoryDatabase, openDatabase, requestResult, transactionTerminal,
  type DbEvent,
} from "../src/storage/db";
import { createAutosave } from "../src/storage/autosave";
import { createNewCourseFixture } from "./fixtures/factory";

function ok<T>(result: ValidationResult<T>): T {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(`${result.error.code} ${result.error.path}: ${result.error.message}`);
  return result.value;
}

function titled(course: CourseV1, title: string): CourseV1 {
  return ok(setCourseFields(course, { title }));
}

function kinds(events: readonly DbEvent[]): string[] {
  return events.map((event) => {
    if (event.kind === "request") return `${event.op}:${event.status}`;
    return event.kind;
  });
}

describe("openDatabase", () => {
  test("unavailable factory is distinct from a stored zero", async () => {
    const opened = await openDatabase({ factory: undefined });
    expect(opened.ok).toBe(false);
    if (opened.ok) throw new Error("expected unavailable");
    expect(opened.error.kind).toBe("unavailable");
  });
});

describe("IndexedDB adapter event ordering", () => {
  test("commit order is request success then complete, never abort", async () => {
    const db = createMemoryDatabase();
    const origin = createNewCourseFixture();
    const tx = db.transaction([COURSES_STORE], "readwrite");
    const terminal = transactionTerminal(tx);
    const store = tx.objectStore(COURSES_STORE);
    const put = store.put({ id: origin.id, title: origin.title, updatedAt: 1, document: origin });
    await requestResult(put);
    expect(await terminal).toBe("complete");
    expect(kinds(db.events()).filter((item) => item === "complete" || item === "abort")).toEqual(["complete"]);
    expect(kinds(db.events()).at(-1)).toBe("complete");
    const getIndex = db.events().findIndex((event) => event.kind === "request" && event.op === "put" && event.status === "success");
    const completeIndex = db.events().findIndex((event) => event.kind === "complete");
    expect(getIndex).toBeGreaterThanOrEqual(0);
    expect(completeIndex).toBeGreaterThan(getIndex);
  });

  test("abort order is request error then abort, and complete never fires", async () => {
    const db = createMemoryDatabase();
    db.failNextPut("abort");
    const origin = createNewCourseFixture();
    const tx = db.transaction([COURSES_STORE], "readwrite");
    const terminal = transactionTerminal(tx);
    const store = tx.objectStore(COURSES_STORE);
    const put = store.put({ id: origin.id, title: origin.title, updatedAt: 1, document: origin });
    const putResult = requestResult(put);
    await expect(putResult).rejects.toMatchObject({ name: "AbortError" });
    expect(await terminal).toBe("abort");
    const sequence = kinds(db.events());
    expect(sequence.includes("complete")).toBe(false);
    expect(sequence.at(-1)).toBe("abort");
    const errorIndex = db.events().findIndex((event) => event.kind === "request" && event.status === "error");
    const abortIndex = db.events().findIndex((event) => event.kind === "abort");
    expect(errorIndex).toBeGreaterThanOrEqual(0);
    expect(abortIndex).toBeGreaterThan(errorIndex);
  });

  test("quota failure is request error then abort", async () => {
    const db = createMemoryDatabase();
    db.failNextPut("quota");
    const origin = createNewCourseFixture();
    const tx = db.transaction([COURSES_STORE], "readwrite");
    const terminal = transactionTerminal(tx);
    const put = tx.objectStore(COURSES_STORE).put({ id: origin.id, title: origin.title, updatedAt: 1, document: origin });
    await expect(requestResult(put)).rejects.toMatchObject({ name: "QuotaExceededError" });
    expect(await terminal).toBe("abort");
    expect(kinds(db.events()).at(-1)).toBe("abort");
    expect(kinds(db.events()).includes("complete")).toBe(false);
  });
});

describe("absent versus stored zero", () => {
  test("missing setting is not the number zero", async () => {
    const db = createMemoryDatabase();
    expect(db.getSetting("timerSeconds")).toEqual({ found: false });
    const tx = db.transaction([SETTINGS_STORE], "readwrite");
    const terminal = transactionTerminal(tx);
    await requestResult(tx.objectStore(SETTINGS_STORE).put({ key: "timerSeconds", value: 0 }));
    expect(await terminal).toBe("complete");
    expect(db.getSetting("timerSeconds")).toEqual({ found: true, value: 0 });
  });

  test("missing course is not a revision-zero record", async () => {
    const db = createMemoryDatabase();
    const origin = createNewCourseFixture();
    expect(db.getCourse(origin.id)).toEqual({ found: false });
    const session = createAutosave({ db, document: origin, now: () => 1 });
    expect(session.status().expectedStoredRevision).toBe(null);
    const saved = await session.requestSave();
    expect(saved.status).toBe("saved");
    if (saved.status !== "saved") throw new Error("expected saved");
    expect(saved.revision).toBe(0);
    expect(session.status().expectedStoredRevision).toBe(0);
    const loaded = db.getCourse(origin.id);
    expect(loaded.found).toBe(true);
    if (!loaded.found) throw new Error("expected present");
    expect(loaded.value.document.revision).toBe(0);
  });
});

describe("immutable snapshots and A-save/B-edit", () => {
  test("a later edit cannot change the in-flight snapshot", async () => {
    const db = createMemoryDatabase();
    const origin = createNewCourseFixture();
    const session = createAutosave({ db, document: origin, now: () => 1 });
    const mutable = titled(origin, "save-a") as CourseV1 & { title: string };
    db.holdNextComplete();
    session.setDocument(mutable);
    const waitingPut = db.waitForRequest("put");
    const saveA = session.requestSave();
    await waitingPut;
    mutable.title = "mutated-after-request";
    session.setDocument(titled(origin, "save-b"));
    db.releaseHeldComplete();
    const result = await saveA;
    expect(result.status).toBe("saved");
    const stored = db.getCourse(origin.id);
    expect(stored.found).toBe(true);
    if (!stored.found) throw new Error("expected present");
    expect(stored.value.document.title).toBe("save-a");
    expect(session.status().dirty).toBe(true);
    expect(session.document().title).toBe("save-b");
  });
});

describe("serialized coalesced writes", () => {
  test("queued writes take expected revision after predecessor commit", async () => {
    const db = createMemoryDatabase();
    const origin = createNewCourseFixture();
    db.seedCourse({ id: origin.id, title: origin.title, updatedAt: 0, document: origin });
    const session = createAutosave({
      db, document: origin, now: () => 1, expectedStoredRevision: 0,
    });
    db.holdNextComplete();
    session.setDocument(titled(origin, "save-a"));
    const firstPut = db.waitForRequest("put");
    const saveA = session.requestSave();
    await firstPut;
    session.setDocument(titled(origin, "save-b"));
    const saveB = session.requestSave();
    db.releaseHeldComplete();
    const [resultA, resultB] = await Promise.all([saveA, saveB]);
    expect(resultA.status).toBe("saved");
    expect(resultB.status).toBe("saved");
    if (resultA.status !== "saved" || resultB.status !== "saved") throw new Error("expected both saved");
    expect(resultA.revision).toBe(1);
    expect(resultB.revision).toBe(2);
    const stored = db.getCourse(origin.id);
    expect(stored.found).toBe(true);
    if (!stored.found) throw new Error("expected present");
    expect(stored.value.document.title).toBe("save-b");
    expect(stored.value.document.revision).toBe(2);
    expect(session.status().error).toBe(null);
  });

  test("queue state coalesces to the newest snapshot without a timer", async () => {
    const db = createMemoryDatabase();
    const origin = createNewCourseFixture();
    db.seedCourse({ id: origin.id, title: origin.title, updatedAt: 0, document: origin });
    const session = createAutosave({
      db, document: origin, now: () => 1, expectedStoredRevision: 0,
    });
    db.holdNextComplete();
    session.setDocument(titled(origin, "save-a"));
    const firstPut = db.waitForRequest("put");
    const saveA = session.requestSave();
    await firstPut;
    session.setDocument(titled(origin, "save-b"));
    const saveB = session.requestSave();
    session.setDocument(titled(origin, "save-c"));
    const saveC = session.requestSave();
    db.releaseHeldComplete();
    const [resultA, resultB, resultC] = await Promise.all([saveA, saveB, saveC]);
    expect(resultA.status).toBe("saved");
    expect(resultB.status).toBe("coalesced");
    expect(resultC.status).toBe("saved");
    const stored = db.getCourse(origin.id);
    expect(stored.found).toBe(true);
    if (!stored.found) throw new Error("expected present");
    expect(stored.value.document.title).toBe("save-c");
    expect(stored.value.document.revision).toBe(2);
  });
});

describe("content-based dirty indicator", () => {
  test("undo to saved content clears dirty and ignores the revision token", async () => {
    const origin = createNewCourseFixture();
    const history = createHistory(origin);
    const db = createMemoryDatabase();
    const session = createAutosave({ db, document: history.document(), now: () => 1 });
    const inserted = await session.requestSave();
    expect(inserted.status).toBe("saved");
    expect(session.status().dirty).toBe(false);
    expect(session.status().expectedStoredRevision).toBe(0);
    expect(history.commit(titled(history.document(), "edited")).status).toBe("committed");
    session.setDocument(history.document());
    expect(session.status().dirty).toBe(true);
    expect(history.undo()).toBe(true);
    session.setDocument(history.document());
    expect(session.status().dirty).toBe(false);
    session.setDocument({ ...history.document(), revision: 7 });
    expect(session.status().dirty).toBe(false);
    expect(authoredContentEqual(session.document(), origin)).toBe(true);
    expect(session.document().revision).toBe(7);
    expect(session.status().expectedStoredRevision).toBe(0);
  });
});

describe("revision compare-and-set", () => {
  test("stale revision is rejected and does not overwrite newer data", async () => {
    const origin = createNewCourseFixture();
    const db = createMemoryDatabase();
    db.seedCourse({ id: origin.id, title: origin.title, updatedAt: 0, document: origin });
    const newer = titled(origin, "tab-a");
    db.seedCourse({
      id: origin.id, title: newer.title, updatedAt: 2, document: { ...newer, revision: 1 },
    });
    const session = createAutosave({
      db, document: origin, now: () => 3, expectedStoredRevision: 0,
    });
    session.setDocument(titled(origin, "tab-b"));
    const result = await session.requestSave();
    expect(result.status).toBe("conflict");
    if (result.status !== "conflict") throw new Error("expected conflict");
    expect(result.storedRevision).toBe(1);
    const stored = db.getCourse(origin.id);
    expect(stored.found).toBe(true);
    if (!stored.found) throw new Error("expected present");
    expect(stored.value.document.title).toBe("tab-a");
    expect(stored.value.document.revision).toBe(1);
    expect(session.document().title).toBe("tab-b");
    expect(session.status().dirty).toBe(true);
    expect(session.status().expectedStoredRevision).toBe(0);
  });
});

describe("failure handling", () => {
  test("transaction abort retains dirty state and offers retry or export", async () => {
    const origin = createNewCourseFixture();
    const db = createMemoryDatabase();
    const session = createAutosave({ db, document: titled(origin, "dirty"), now: () => 1 });
    db.failNextPut("abort");
    const result = await session.requestSave();
    expect(result.status).toBe("failed");
    if (result.status !== "failed") throw new Error("expected failed");
    expect(result.error.kind).toBe("abort");
    expect(session.status().dirty).toBe(true);
    expect(session.status().error?.kind).toBe("abort");
    expect(session.status().recovery).toEqual(["retry", "export"]);
    expect(session.status().expectedStoredRevision).toBe(null);
    expect(db.getCourse(origin.id)).toEqual({ found: false });
  });

  test("quota error retains dirty state and offers retry or export", async () => {
    const origin = createNewCourseFixture();
    const db = createMemoryDatabase();
    const session = createAutosave({ db, document: titled(origin, "dirty"), now: () => 1 });
    db.failNextPut("quota");
    const result = await session.requestSave();
    expect(result.status).toBe("failed");
    if (result.status !== "failed") throw new Error("expected failed");
    expect(result.error.kind).toBe("quota");
    expect(session.status().dirty).toBe(true);
    expect(session.status().error?.kind).toBe("quota");
    expect(session.status().recovery).toEqual(["retry", "export"]);
    expect(session.status().expectedStoredRevision).toBe(null);
  });

  test("delete drains the queue and does not resurrect the record", async () => {
    const origin = createNewCourseFixture();
    const db = createMemoryDatabase();
    db.seedCourse({ id: origin.id, title: origin.title, updatedAt: 0, document: origin });
    const session = createAutosave({
      db, document: origin, now: () => 1, expectedStoredRevision: 0,
    });
    db.holdNextComplete();
    session.setDocument(titled(origin, "save-a"));
    const firstPut = db.waitForRequest("put");
    const saveA = session.requestSave();
    await firstPut;
    session.setDocument(titled(origin, "save-b"));
    const saveB = session.requestSave();
    const deleted = session.deleteCourse();
    const [resultA, resultB, resultDelete] = await Promise.all([saveA, saveB, deleted]);
    expect(resultDelete.status).toBe("deleted");
    expect(resultA.status === "cancelled" || resultA.status === "failed").toBe(true);
    expect(resultB.status === "cancelled" || resultB.status === "coalesced").toBe(true);
    expect(db.getCourse(origin.id)).toEqual({ found: false });
    const late = await session.requestSave();
    expect(late.status).toBe("deleted");
    expect(db.getCourse(origin.id)).toEqual({ found: false });
  });
});
