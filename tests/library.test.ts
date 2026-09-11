import { describe, expect, test } from "bun:test";
import { setCourseFields } from "../src/editor/commands";
import { createNewCourse } from "../src/level/catalog";
import type { CourseV1, ValidationResult } from "../src/level/types";
import { createAutosave } from "../src/storage/autosave";
import { createMemoryDatabase } from "../src/storage/db";
import {
  createLibraryCourse,
  deleteLibraryCourse,
  duplicateLibraryCourse,
  listCourses,
  openLibraryCourse,
  renameLibraryCourse,
  resolveLibraryConflict,
  switchOpenCourse,
} from "../src/storage/library";
import { createNewCourseFixture, fixtureId, fixtureValue } from "./fixtures/factory";

function ok<T>(result: ValidationResult<T>): T {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(`${result.error.code} ${result.error.path}: ${result.error.message}`);
  return result.value;
}

function titled(course: CourseV1, title: string): CourseV1 {
  return ok(setCourseFields(course, { title }));
}

function secondCourse(): CourseV1 {
  return fixtureValue(createNewCourse({ courseId: fixtureId(4), areaId: fixtureId(5), goalId: fixtureId(6) }));
}

describe("listCourses", () => {
  test("orders stored records by updated-at descending", async () => {
    const db = createMemoryDatabase();
    const origin = createNewCourseFixture();
    const other = titled(secondCourse(), "두번째");
    db.seedCourse({ id: other.id, title: other.title, updatedAt: 10, document: other });
    db.seedCourse({ id: origin.id, title: origin.title, updatedAt: 30, document: origin });
    const third = titled(fixtureValue(createNewCourse({
      courseId: fixtureId(7), areaId: fixtureId(8), goalId: fixtureId(9),
    })), "세번째");
    db.seedCourse({ id: third.id, title: third.title, updatedAt: 20, document: third });
    const listed = await listCourses(db);
    expect(listed.map((record) => record.id)).toEqual([origin.id, third.id, other.id]);
    expect(listed.map((record) => record.updatedAt)).toEqual([30, 20, 10]);
  });
});

describe("createLibraryCourse", () => {
  test("inserts a new course id at revision zero", async () => {
    const db = createMemoryDatabase();
    const created = await createLibraryCourse(db, {
      now: () => 5,
      ids: { courseId: fixtureId(20), areaId: fixtureId(21), goalId: fixtureId(22) },
      title: "첫 코스",
    });
    expect(created.status).toBe("created");
    if (created.status !== "created") throw new Error("expected created");
    expect(created.record.id).toBe(fixtureId(20));
    expect(created.record.document.id).toBe(fixtureId(20));
    expect(created.record.document.revision).toBe(0);
    expect(created.record.document.title).toBe("첫 코스");
    expect(created.record.updatedAt).toBe(5);
    expect(db.getCourse(fixtureId(20))).toEqual({ found: true, value: created.record });
  });
});

describe("duplicateLibraryCourse", () => {
  test("mints a new course id and never aliases the source record", async () => {
    const db = createMemoryDatabase();
    const origin = titled(createNewCourseFixture(), "원본");
    db.seedCourse({ id: origin.id, title: origin.title, updatedAt: 1, document: { ...origin, revision: 3 } });
    const duplicated = await duplicateLibraryCourse(db, origin.id, {
      now: () => 9,
      newCourseId: fixtureId(30),
    });
    expect(duplicated.status).toBe("duplicated");
    if (duplicated.status !== "duplicated") throw new Error("expected duplicated");
    expect(duplicated.sourceId).toBe(origin.id);
    expect(duplicated.record.id).toBe(fixtureId(30));
    expect(duplicated.record.id).not.toBe(origin.id);
    expect(duplicated.record.document.id).toBe(fixtureId(30));
    expect(duplicated.record.document.id).not.toBe(origin.id);
    expect(duplicated.record.document.revision).toBe(0);
    expect(duplicated.record.document.title).toBe("원본");
    expect(duplicated.record.document.areas).toEqual(origin.areas);
    expect(duplicated.record.updatedAt).toBe(9);
    const source = db.getCourse(origin.id);
    expect(source.found).toBe(true);
    if (!source.found) throw new Error("expected source present");
    expect(source.value.document.id).toBe(origin.id);
    expect(source.value.document.revision).toBe(3);
    expect(source.value.document.title).toBe("원본");
    const copy = db.getCourse(fixtureId(30));
    expect(copy.found).toBe(true);
    if (!copy.found) throw new Error("expected copy present");
    expect(copy.value.document.id).toBe(fixtureId(30));
    expect(copy.value).toEqual(duplicated.record);
    expect(copy.value.document).not.toBe(source.value.document);
  });
});

describe("deleteLibraryCourse", () => {
  test("cancel preserves the entry untouched", async () => {
    const db = createMemoryDatabase();
    const origin = createNewCourseFixture();
    const stored = { id: origin.id, title: origin.title, updatedAt: 4, document: origin };
    db.seedCourse(stored);
    const cancelled = await deleteLibraryCourse(db, origin.id, { confirmed: false });
    expect(cancelled.status).toBe("cancelled");
    if (cancelled.status !== "cancelled") throw new Error("expected cancelled");
    expect(cancelled.id).toBe(origin.id);
    expect(db.getCourse(origin.id)).toEqual({ found: true, value: stored });
    const listed = await listCourses(db);
    expect(listed.map((record) => record.id)).toEqual([origin.id]);
  });

  test("confirmed delete removes the stored record", async () => {
    const db = createMemoryDatabase();
    const origin = createNewCourseFixture();
    db.seedCourse({ id: origin.id, title: origin.title, updatedAt: 4, document: origin });
    const deleted = await deleteLibraryCourse(db, origin.id, { confirmed: true });
    expect(deleted.status).toBe("deleted");
    if (deleted.status !== "deleted") throw new Error("expected deleted");
    expect(deleted.id).toBe(origin.id);
    expect(db.getCourse(origin.id)).toEqual({ found: false });
    expect(await listCourses(db)).toEqual([]);
  });
});

describe("renameLibraryCourse", () => {
  test("rejects invalid titles without writing", async () => {
    const db = createMemoryDatabase();
    const origin = titled(createNewCourseFixture(), "유지");
    const stored = { id: origin.id, title: origin.title, updatedAt: 2, document: origin };
    db.seedCourse(stored);
    const empty = await renameLibraryCourse(db, origin.id, "", { now: () => 8 });
    expect(empty.status).toBe("invalid");
    if (empty.status !== "invalid") throw new Error("expected invalid");
    expect(empty.error.code).toBe("invalid_value");
    expect(empty.error.path).toBe("$.title");
    const padded = await renameLibraryCourse(db, origin.id, " 공백 ", { now: () => 8 });
    expect(padded.status).toBe("invalid");
    const tooLong = await renameLibraryCourse(db, origin.id, "x".repeat(81), { now: () => 8 });
    expect(tooLong.status).toBe("invalid");
    expect(db.getCourse(origin.id)).toEqual({ found: true, value: stored });
  });

  test("writes a trimmed 1-80 title and bumps revision", async () => {
    const db = createMemoryDatabase();
    const origin = titled(createNewCourseFixture(), "이전");
    db.seedCourse({ id: origin.id, title: origin.title, updatedAt: 2, document: { ...origin, revision: 1 } });
    const renamed = await renameLibraryCourse(db, origin.id, "다음 이름", { now: () => 11 });
    expect(renamed.status).toBe("renamed");
    if (renamed.status !== "renamed") throw new Error("expected renamed");
    expect(renamed.record.title).toBe("다음 이름");
    expect(renamed.record.document.title).toBe("다음 이름");
    expect(renamed.record.document.revision).toBe(2);
    expect(renamed.record.updatedAt).toBe(11);
    const stored = db.getCourse(origin.id);
    expect(stored.found).toBe(true);
    if (!stored.found) throw new Error("expected present");
    expect(stored.value.document.title).toBe("다음 이름");
    expect(stored.value.document.revision).toBe(2);
  });
});

describe("switchOpenCourse", () => {
  test("a failed save does not discard the edit or open the target", async () => {
    const db = createMemoryDatabase();
    const origin = createNewCourseFixture();
    const other = secondCourse();
    db.seedCourse({ id: other.id, title: other.title, updatedAt: 1, document: other });
    const session = createAutosave({ db, document: origin, now: () => 3 });
    const inserted = await session.requestSave();
    expect(inserted.status).toBe("saved");
    session.setDocument(titled(origin, "저장실패"));
    expect(session.status().dirty).toBe(true);
    db.failNextPut("abort");
    const switched = await switchOpenCourse(db, session, { action: "save-and-open", targetId: other.id });
    expect(switched.status).toBe("save-failed");
    if (switched.status !== "save-failed") throw new Error("expected save-failed");
    expect(switched.error.kind).toBe("abort");
    expect(session.document().title).toBe("저장실패");
    expect(session.status().dirty).toBe(true);
    expect(session.status().expectedStoredRevision).toBe(0);
    const storedOrigin = db.getCourse(origin.id);
    expect(storedOrigin.found).toBe(true);
    if (!storedOrigin.found) throw new Error("expected origin present");
    expect(storedOrigin.value.document.title).toBe(origin.title);
    expect(db.getCourse(other.id).found).toBe(true);
  });
});

describe("resolveLibraryConflict", () => {
  test("save-a-copy keeps both documents and never overwrites the stored revision", async () => {
    const db = createMemoryDatabase();
    const origin = createNewCourseFixture();
    db.seedCourse({ id: origin.id, title: origin.title, updatedAt: 0, document: origin });
    const newer = titled(origin, "탭A");
    db.seedCourse({
      id: origin.id, title: newer.title, updatedAt: 2, document: { ...newer, revision: 1 },
    });
    const session = createAutosave({
      db, document: origin, now: () => 3, expectedStoredRevision: 0,
    });
    session.setDocument(titled(origin, "탭B"));
    const save = await session.requestSave();
    expect(save.status).toBe("conflict");
    if (save.status !== "conflict") throw new Error("expected conflict");
    expect(save.storedRevision).toBe(1);
    const copied = await resolveLibraryConflict(db, session, "save-copy", {
      now: () => 4,
      newCourseId: fixtureId(40),
    });
    expect(copied.status).toBe("copied");
    if (copied.status !== "copied") throw new Error("expected copied");
    expect(copied.sourceId).toBe(origin.id);
    expect(copied.record.id).toBe(fixtureId(40));
    expect(copied.record.document.id).toBe(fixtureId(40));
    expect(copied.record.document.title).toBe("탭B");
    expect(copied.record.document.revision).toBe(0);
    const storedOriginal = db.getCourse(origin.id);
    expect(storedOriginal.found).toBe(true);
    if (!storedOriginal.found) throw new Error("expected original present");
    expect(storedOriginal.value.document.title).toBe("탭A");
    expect(storedOriginal.value.document.revision).toBe(1);
    expect(storedOriginal.value.document.id).toBe(origin.id);
    const storedCopy = db.getCourse(fixtureId(40));
    expect(storedCopy.found).toBe(true);
    if (!storedCopy.found) throw new Error("expected copy present");
    expect(storedCopy.value.document.title).toBe("탭B");
    expect(storedCopy.value.document.id).toBe(fixtureId(40));
    expect(session.document().title).toBe("탭B");
    expect(session.document().id).toBe(origin.id);
  });

  test("reload returns the newer stored record without writing the local edit", async () => {
    const db = createMemoryDatabase();
    const origin = createNewCourseFixture();
    const newer = titled(origin, "탭A");
    db.seedCourse({
      id: origin.id, title: newer.title, updatedAt: 2, document: { ...newer, revision: 1 },
    });
    const session = createAutosave({
      db, document: origin, now: () => 3, expectedStoredRevision: 0,
    });
    session.setDocument(titled(origin, "탭B"));
    const reloaded = await resolveLibraryConflict(db, session, "reload");
    expect(reloaded.status).toBe("reloaded");
    if (reloaded.status !== "reloaded") throw new Error("expected reloaded");
    expect(reloaded.record.document.title).toBe("탭A");
    expect(reloaded.record.document.revision).toBe(1);
    expect(db.getCourse(origin.id)).toEqual({ found: true, value: reloaded.record });
    expect(session.document().title).toBe("탭B");
  });
});

describe("openLibraryCourse", () => {
  test("opens the stored record by id", async () => {
    const db = createMemoryDatabase();
    const origin = createNewCourseFixture();
    db.seedCourse({ id: origin.id, title: origin.title, updatedAt: 1, document: origin });
    const opened = await openLibraryCourse(db, origin.id);
    expect(opened.status).toBe("opened");
    if (opened.status !== "opened") throw new Error("expected opened");
    expect(opened.record.document.id).toBe(origin.id);
    const missing = await openLibraryCourse(db, fixtureId(99));
    expect(missing.status).toBe("missing");
  });
});
