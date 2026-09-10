import { describe, expect, test } from "bun:test";
import { createNewCourse } from "../src/level/catalog";
import { authoredContentEqual, parseCourse, serializeCourse } from "../src/level/serialize";
import { COURSE_LIMITS, type CourseV1, type ValidationResult } from "../src/level/types";
import { createAutosave } from "../src/storage/autosave";
import { createMemoryDatabase } from "../src/storage/db";
import {
  COURSE_FILE_MIME,
  exportCourseFile,
  importCourseFile,
  readCourseFile,
  sanitizeCourseFilename,
} from "../src/storage/files";
import { loadLastOpen, rememberOpen } from "../src/storage/host";
import {
  createAllKindsFixture,
  createInvalidFixture,
  createNewCourseFixture,
  fixtureId,
  fixtureValue,
} from "./fixtures/factory";

const encoder = new TextEncoder();

function ok<T>(result: ValidationResult<T>): T {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(`${result.error.code} ${result.error.path}: ${result.error.message}`);
  return result.value;
}

function bytesOf(course: CourseV1): Uint8Array {
  return encoder.encode(ok(serializeCourse(course)));
}

function authoredWithoutIdentity(course: CourseV1): CourseV1 {
  return { ...course, id: fixtureId(0), revision: 0 };
}

function otherOpenCourse(): CourseV1 {
  return fixtureValue(createNewCourse({ courseId: fixtureId(60), areaId: fixtureId(61), goalId: fixtureId(62) }));
}

describe("readCourseFile", () => {
  test("rejects invalid bytes before any library write", async () => {
    const db = createMemoryDatabase();
    const current = createNewCourseFixture();
    const stored = { id: current.id, title: current.title, updatedAt: 1, document: current };
    db.seedCourse(stored);
    await rememberOpen(db, current);
    const malformed = encoder.encode("{");
    const read = readCourseFile(malformed);
    expect(read.ok).toBe(false);
    if (read.ok) throw new Error("expected invalid bytes");
    expect(read.error.code).toBe("malformed_json");
    const before = db.events().length;
    const imported = await importCourseFile(db, malformed, { newCourseId: fixtureId(80) });
    expect(imported.status).toBe("invalid");
    if (imported.status !== "invalid") throw new Error("expected invalid");
    expect(imported.error.code).toBe("malformed_json");
    expect(db.getCourse(current.id)).toEqual({ found: true, value: stored });
    expect(db.getCourse(fixtureId(80))).toEqual({ found: false });
    expect(db.events().slice(before).some((event) => event.kind === "request" && event.op === "put")).toBe(false);
  });

  test("rejects an unsupported version", () => {
    const fixture = createInvalidFixture("unknown-version");
    const read = readCourseFile(encoder.encode(fixture.json));
    expect(read.ok).toBe(false);
    if (read.ok) throw new Error("expected unsupported version");
    expect(read.error.code).toBe("unsupported_version");
    expect(fixture.error.code).toBe("unsupported_version");
  });

  test("rejects invalid properties", () => {
    const extra = { ...createNewCourseFixture(), extra: true };
    const unknown = readCourseFile(encoder.encode(JSON.stringify(extra)));
    expect(unknown.ok).toBe(false);
    if (unknown.ok) throw new Error("expected unknown field");
    expect(unknown.error.code).toBe("unknown_field");
    const zero = createInvalidFixture("platform-length-zero");
    const invalid = readCourseFile(encoder.encode(zero.json));
    expect(invalid.ok).toBe(false);
    if (invalid.ok) throw new Error("expected invalid properties");
    expect(invalid.error.code).toBe("invalid_value");
  });

  test("rejects broken links", () => {
    const dangling = createInvalidFixture("dangling-piranha");
    const piranha = readCourseFile(encoder.encode(dangling.json));
    expect(piranha.ok).toBe(false);
    if (piranha.ok) throw new Error("expected dangling piranha");
    expect(piranha.error.code).toBe("invalid_reference");
    const pipe = createInvalidFixture("nonreciprocal-pipe");
    const broken = readCourseFile(encoder.encode(pipe.json));
    expect(broken.ok).toBe(false);
    if (broken.ok) throw new Error("expected broken pipe");
    expect(broken.error.code).toBe("invalid_reference");
  });

  test("enforces the 32 MiB boundary on raw bytes before parsing", () => {
    const oversized = new Uint8Array(COURSE_LIMITS.fileBytes + 1);
    expect(oversized.byteLength).toBe(COURSE_LIMITS.fileBytes + 1);
    const read = readCourseFile(oversized);
    expect(read.ok).toBe(false);
    if (read.ok) throw new Error("expected file_too_large");
    expect(read.error.code).toBe("file_too_large");
    expect(read.error.path).toBe("$");
    const parsed = parseCourse(oversized);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error.code).toBe("file_too_large");
  });
});

describe("sanitizeCourseFilename", () => {
  test("normalizes title into a .smb1.json basename without markup or path separators", () => {
    expect(sanitizeCourseFilename("새 코스")).toBe("새 코스.smb1.json");
    expect(sanitizeCourseFilename("a/b:c*?\"<>|")).toBe("a_b_c______.smb1.json");
    expect(sanitizeCourseFilename("<script>")).toBe("_script_.smb1.json");
    expect(sanitizeCourseFilename("...")).toBe("course.smb1.json");
    expect(sanitizeCourseFilename("새 코스.smb1.json").endsWith(".smb1.json")).toBe(true);
  });
});

describe("exportCourseFile", () => {
  test("produces a JSON Blob whose bytes round-trip the authored document", async () => {
    const source = { ...createAllKindsFixture(), timerSeconds: 0, revision: 7 };
    const exported = exportCourseFile(source);
    expect(exported.ok).toBe(true);
    if (!exported.ok) throw new Error("expected export");
    expect(exported.value.mimeType).toBe(COURSE_FILE_MIME);
    expect(exported.value.blob.type.startsWith(COURSE_FILE_MIME)).toBe(true);
    expect(exported.value.filename).toBe("모든 종류.smb1.json");
    const blobBytes = new Uint8Array(await exported.value.blob.arrayBuffer());
    expect(blobBytes.byteLength).toBeGreaterThan(0);
    expect(blobBytes.byteLength).toBeLessThanOrEqual(COURSE_LIMITS.fileBytes);
    const parsed = ok(parseCourse(blobBytes));
    expect(parsed.timerSeconds).toBe(0);
    expect(parsed.revision).toBe(7);
    expect(parsed.id).toBe(source.id);
    expect(parsed.areas).toEqual(source.areas);
    expect(authoredContentEqual(parsed, source)).toBe(true);
  });
});

describe("importCourseFile", () => {
  test("round trip preserves everything except course id and revision metadata", async () => {
    const db = createMemoryDatabase();
    const source = {
      ...createAllKindsFixture(),
      timerSeconds: 999,
      revision: 4,
    };
    const current = otherOpenCourse();
    db.seedCourse({ id: current.id, title: current.title, updatedAt: 1, document: current });
    await rememberOpen(db, current);
    const exported = exportCourseFile(source);
    expect(exported.ok).toBe(true);
    if (!exported.ok) throw new Error("expected export");
    const blobBytes = new Uint8Array(await exported.value.blob.arrayBuffer());
    const imported = await importCourseFile(db, blobBytes, {
      now: () => 11,
      newCourseId: fixtureId(50),
    });
    expect(imported.status).toBe("imported");
    if (imported.status !== "imported") throw new Error("expected imported");
    expect(imported.record.id).toBe(fixtureId(50));
    expect(imported.record.document.id).toBe(fixtureId(50));
    expect(imported.record.document.id).not.toBe(source.id);
    expect(imported.record.document.revision).toBe(0);
    expect(imported.record.updatedAt).toBe(11);
    expect(imported.record.document.title).toBe(source.title);
    expect(imported.record.document.timerSeconds).toBe(999);
    expect(imported.record.document.mainAreaId).toBe(source.mainAreaId);
    expect(imported.record.document.start).toEqual(source.start);
    expect(imported.record.document.areas).toEqual(source.areas);
    const coins = imported.record.document.areas.flatMap((area) => area.tiles.filter((tile) => tile.kind === "coin"));
    expect(coins.length).toBeGreaterThan(0);
    expect(authoredContentEqual(authoredWithoutIdentity(imported.record.document), authoredWithoutIdentity(source))).toBe(true);
    expect(db.getCourse(source.id)).toEqual({ found: false });
    expect(db.getCourse(current.id).found).toBe(true);
    const last = await loadLastOpen(db);
    expect(last?.id).toBe(current.id);
    const stored = db.getCourse(fixtureId(50));
    expect(stored.found).toBe(true);
    if (!stored.found) throw new Error("expected stored import");
    expect(stored.value.document.id).toBe(fixtureId(50));
    expect(stored.value.document.areas.map((area) => area.id)).toEqual(source.areas.map((area) => area.id));
    expect(stored.value.document.areas.flatMap((area) => area.objects.map((object) => object.id)))
      .toEqual(source.areas.flatMap((area) => area.objects.map((object) => object.id)));
  });

  test("never overwrites an existing course using the id inside the file", async () => {
    const db = createMemoryDatabase();
    const source = createNewCourseFixture();
    const stored = { id: source.id, title: source.title, updatedAt: 2, document: { ...source, revision: 3 } };
    db.seedCourse(stored);
    const imported = await importCourseFile(db, bytesOf(source), {
      now: () => 8,
      newCourseId: fixtureId(51),
    });
    expect(imported.status).toBe("imported");
    if (imported.status !== "imported") throw new Error("expected imported");
    expect(imported.record.id).toBe(fixtureId(51));
    expect(imported.record.document.id).toBe(fixtureId(51));
    expect(db.getCourse(source.id)).toEqual({ found: true, value: stored });
    expect(db.getCourse(fixtureId(51)).found).toBe(true);
  });

  test("insertion failure leaves the current course unchanged", async () => {
    const db = createMemoryDatabase();
    const current = createNewCourseFixture();
    const stored = { id: current.id, title: current.title, updatedAt: 3, document: current };
    db.seedCourse(stored);
    await rememberOpen(db, current);
    const session = createAutosave({
      db, document: current, now: () => 4, expectedStoredRevision: 0,
    });
    const source = { ...createAllKindsFixture(), title: "가져오기", timerSeconds: 30 };
    db.failNextPut("quota");
    const imported = await importCourseFile(db, bytesOf(source), {
      now: () => 9,
      newCourseId: fixtureId(52),
    });
    expect(imported.status).toBe("failed");
    if (imported.status !== "failed") throw new Error("expected failed");
    expect(imported.error.kind).toBe("quota");
    expect(imported.error.name).toBe("QuotaExceededError");
    expect(db.getCourse(current.id)).toEqual({ found: true, value: stored });
    expect(db.getCourse(fixtureId(52))).toEqual({ found: false });
    expect(session.document().id).toBe(current.id);
    expect(session.document()).toEqual(current);
    expect(session.status().dirty).toBe(false);
    const last = await loadLastOpen(db);
    expect(last?.id).toBe(current.id);
    expect(last?.document).toEqual(current);
  });

  test("invalid documents never reach a write", async () => {
    const db = createMemoryDatabase();
    const current = createNewCourseFixture();
    db.seedCourse({ id: current.id, title: current.title, updatedAt: 1, document: current });
    const oversized = new Uint8Array(COURSE_LIMITS.fileBytes + 1);
    const tooLarge = await importCourseFile(db, oversized, { newCourseId: fixtureId(53) });
    expect(tooLarge.status).toBe("invalid");
    if (tooLarge.status !== "invalid") throw new Error("expected invalid");
    expect(tooLarge.error.code).toBe("file_too_large");
    const utf8 = await importCourseFile(db, new Uint8Array([0xc3, 0x28]), { newCourseId: fixtureId(54) });
    expect(utf8.status).toBe("invalid");
    if (utf8.status !== "invalid") throw new Error("expected invalid utf8");
    expect(utf8.error.code).toBe("invalid_utf8");
    expect(db.getCourse(fixtureId(53))).toEqual({ found: false });
    expect(db.getCourse(fixtureId(54))).toEqual({ found: false });
    expect(db.events().some((event) => event.kind === "request" && event.op === "put")).toBe(false);
  });
});
