import { createNewCourse } from "../level/catalog";
import type { CourseV1, ValidationIssue } from "../level/types";
import { validateCourse } from "../level/validate";
import type { AutosaveSession } from "./autosave";
import {
  COURSES_STORE, requestResult, transactionTerminal,
  type CourseRecord, type DatabaseHandle, type StorageError, type TransactionLike,
} from "./db";
import { readCourse, rememberOpen } from "./host";

export type LibraryNow = () => number;
export type LibraryIds = Readonly<{ courseId: string; areaId: string; goalId: string }>;

export type CreateCourseResult =
  | Readonly<{ status: "created"; record: CourseRecord }>
  | Readonly<{ status: "invalid"; error: ValidationIssue }>
  | Readonly<{ status: "conflict"; storedRevision: number }>
  | Readonly<{ status: "failed"; error: StorageError }>;

export type RenameCourseResult =
  | Readonly<{ status: "renamed"; record: CourseRecord }>
  | Readonly<{ status: "invalid"; error: ValidationIssue }>
  | Readonly<{ status: "missing" }>
  | Readonly<{ status: "failed"; error: StorageError }>;

export type DuplicateCourseResult =
  | Readonly<{ status: "duplicated"; record: CourseRecord; sourceId: string }>
  | Readonly<{ status: "missing" }>
  | Readonly<{ status: "failed"; error: StorageError }>;

export type OpenCourseResult =
  | Readonly<{ status: "opened"; record: CourseRecord }>
  | Readonly<{ status: "missing" }>;

export type DeleteCourseResult =
  | Readonly<{ status: "cancelled"; id: string }>
  | Readonly<{ status: "deleted"; id: string }>
  | Readonly<{ status: "failed"; error: StorageError }>;

export type SwitchCourseRequest =
  | Readonly<{ action: "save-and-open"; targetId: string }>
  | Readonly<{ action: "discard-and-open"; targetId: string }>
  | Readonly<{ action: "cancel" }>;

export type SwitchCourseResult =
  | Readonly<{ status: "opened"; record: CourseRecord }>
  | Readonly<{ status: "cancelled" }>
  | Readonly<{ status: "save-failed"; error: StorageError; document: CourseV1 }>
  | Readonly<{ status: "conflict"; storedRevision: number; document: CourseV1 }>
  | Readonly<{ status: "missing" }>
  | Readonly<{ status: "deleted"; document: CourseV1 }>;

export type ResolveConflictResult =
  | Readonly<{ status: "reloaded"; record: CourseRecord }>
  | Readonly<{ status: "copied"; record: CourseRecord; sourceId: string }>
  | Readonly<{ status: "missing" }>
  | Readonly<{ status: "failed"; error: StorageError }>;

function cloneRecord(record: CourseRecord): CourseRecord {
  return structuredClone(record);
}

function errorName(error: unknown): string {
  if (error && typeof error === "object" && "name" in error && typeof error.name === "string") return error.name;
  return "AbortError";
}

function failedError(tx: TransactionLike, caught?: unknown): StorageError {
  const name = errorName(tx.error ?? caught);
  return { kind: name === "QuotaExceededError" ? "quota" : "abort", name };
}

function asRecord(value: unknown): CourseRecord | undefined {
  if (value === undefined || value === null || typeof value !== "object") return undefined;
  if (!("document" in value) || !("id" in value) || !("title" in value) || !("updatedAt" in value)) return undefined;
  const record = value as CourseRecord;
  if (typeof record.id !== "string" || typeof record.title !== "string" || typeof record.updatedAt !== "number") return undefined;
  return record;
}

function newUuid(): string {
  return globalThis.crypto.randomUUID();
}

function toRecord(document: CourseV1, updatedAt: number): CourseRecord {
  return { id: document.id, title: document.title, updatedAt, document };
}

async function insertRecord(db: DatabaseHandle, record: CourseRecord): Promise<CreateCourseResult> {
  const tx = db.transaction([COURSES_STORE], "readwrite");
  const terminal = transactionTerminal(tx);
  try {
    const store = tx.objectStore(COURSES_STORE);
    const existing = asRecord(await requestResult(store.get(record.id)));
    if (existing !== undefined) {
      tx.abort();
      await terminal;
      return { status: "conflict", storedRevision: existing.document.revision };
    }
    await requestResult(store.put(record));
    const end = await terminal;
    if (end === "complete") return { status: "created", record };
    return { status: "failed", error: failedError(tx) };
  } catch (caught) {
    await terminal;
    return { status: "failed", error: failedError(tx, caught) };
  }
}

export async function listCourses(db: DatabaseHandle): Promise<readonly CourseRecord[]> {
  const tx = db.transaction([COURSES_STORE], "readonly");
  const terminal = transactionTerminal(tx);
  try {
    const rows = await requestResult(tx.objectStore(COURSES_STORE).getAll());
    if (await terminal !== "complete") return [];
    if (!Array.isArray(rows)) return [];
    const records: CourseRecord[] = [];
    for (const row of rows) {
      const record = asRecord(row);
      if (record) records.push(cloneRecord(record));
    }
    records.sort((left, right) => right.updatedAt - left.updatedAt || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
    return records;
  } catch {
    await terminal;
    return [];
  }
}

export async function createLibraryCourse(
  db: DatabaseHandle,
  options: Readonly<{ now?: LibraryNow; ids?: LibraryIds; title?: string }> = {},
): Promise<CreateCourseResult> {
  const ids = options.ids ?? { courseId: newUuid(), areaId: newUuid(), goalId: newUuid() };
  const seed = createNewCourse(ids);
  if (!seed.ok) return { status: "invalid", error: seed.error };
  const parsed = options.title === undefined ? seed : validateCourse({ ...seed.value, title: options.title });
  if (!parsed.ok) return { status: "invalid", error: parsed.error };
  const document = { ...parsed.value, revision: 0 };
  const record = toRecord(document, (options.now ?? Date.now)());
  const inserted = await insertRecord(db, record);
  if (inserted.status === "created") await rememberOpen(db, document);
  return inserted;
}

export async function renameLibraryCourse(
  db: DatabaseHandle,
  id: string,
  title: string,
  options: Readonly<{ now?: LibraryNow }> = {},
): Promise<RenameCourseResult> {
  const tx = db.transaction([COURSES_STORE], "readwrite");
  const terminal = transactionTerminal(tx);
  try {
    const store = tx.objectStore(COURSES_STORE);
    const existing = asRecord(await requestResult(store.get(id)));
    if (existing === undefined) {
      tx.abort();
      await terminal;
      return { status: "missing" };
    }
    const parsed = validateCourse({ ...existing.document, title, revision: existing.document.revision + 1 });
    if (!parsed.ok) {
      tx.abort();
      await terminal;
      return { status: "invalid", error: parsed.error };
    }
    const record = toRecord(parsed.value, (options.now ?? Date.now)());
    await requestResult(store.put(record));
    const end = await terminal;
    if (end === "complete") return { status: "renamed", record };
    return { status: "failed", error: failedError(tx) };
  } catch (caught) {
    await terminal;
    return { status: "failed", error: failedError(tx, caught) };
  }
}

export async function duplicateLibraryCourse(
  db: DatabaseHandle,
  sourceId: string,
  options: Readonly<{ now?: LibraryNow; newCourseId?: string }> = {},
): Promise<DuplicateCourseResult> {
  const tx = db.transaction([COURSES_STORE], "readwrite");
  const terminal = transactionTerminal(tx);
  try {
    const store = tx.objectStore(COURSES_STORE);
    const source = asRecord(await requestResult(store.get(sourceId)));
    if (source === undefined) {
      tx.abort();
      await terminal;
      return { status: "missing" };
    }
    const newCourseId = options.newCourseId ?? newUuid();
    const parsed = validateCourse({ ...source.document, id: newCourseId, revision: 0 });
    if (!parsed.ok) {
      tx.abort();
      await terminal;
      return { status: "failed", error: { kind: "abort", name: parsed.error.code } };
    }
    const existingCopy = asRecord(await requestResult(store.get(parsed.value.id)));
    if (existingCopy !== undefined) {
      tx.abort();
      await terminal;
      return { status: "failed", error: { kind: "conflict", name: "constraint" } };
    }
    const record = toRecord(parsed.value, (options.now ?? Date.now)());
    await requestResult(store.put(record));
    const end = await terminal;
    if (end === "complete") return { status: "duplicated", record, sourceId };
    return { status: "failed", error: failedError(tx) };
  } catch (caught) {
    await terminal;
    return { status: "failed", error: failedError(tx, caught) };
  }
}

export async function openLibraryCourse(db: DatabaseHandle, id: string): Promise<OpenCourseResult> {
  const loaded = await readCourse(db, id);
  if (!loaded.found) return { status: "missing" };
  await rememberOpen(db, loaded.value.document);
  return { status: "opened", record: loaded.value };
}

export async function deleteLibraryCourse(
  db: DatabaseHandle,
  id: string,
  confirmation: Readonly<{ confirmed: boolean }>,
  options?: Readonly<{ session: AutosaveSession }>,
): Promise<DeleteCourseResult> {
  if (!confirmation.confirmed) return { status: "cancelled", id };
  if (options !== undefined && options.session.document().id === id) {
    const outcome = await options.session.deleteCourse();
    if (outcome.status === "deleted") return { status: "deleted", id };
    return { status: "failed", error: outcome.error };
  }
  const tx = db.transaction([COURSES_STORE], "readwrite");
  const terminal = transactionTerminal(tx);
  try {
    await requestResult(tx.objectStore(COURSES_STORE).delete(id));
    const end = await terminal;
    if (end !== "complete") return { status: "failed", error: failedError(tx) };
    return { status: "deleted", id };
  } catch (caught) {
    await terminal;
    return { status: "failed", error: failedError(tx, caught) };
  }
}

export async function switchOpenCourse(
  db: DatabaseHandle,
  session: AutosaveSession,
  request: SwitchCourseRequest,
): Promise<SwitchCourseResult> {
  if (request.action === "cancel") return { status: "cancelled" };
  if (request.action === "save-and-open" && session.status().dirty) {
    const outcome = await session.requestSave();
    if (outcome.status === "failed") {
      return { status: "save-failed", error: outcome.error, document: session.document() };
    }
    if (outcome.status === "conflict") {
      return { status: "conflict", storedRevision: outcome.storedRevision, document: session.document() };
    }
    if (outcome.status === "deleted") return { status: "deleted", document: session.document() };
    if (outcome.status === "cancelled") {
      return { status: "save-failed", error: { kind: "abort", name: "AbortError" }, document: session.document() };
    }
  }
  return openLibraryCourse(db, request.targetId);
}

export async function resolveLibraryConflict(
  db: DatabaseHandle,
  session: AutosaveSession,
  decision: "reload" | "save-copy",
  options: Readonly<{ now?: LibraryNow; newCourseId?: string }> = {},
): Promise<ResolveConflictResult> {
  if (decision === "reload") {
    const loaded = await readCourse(db, session.document().id);
    if (!loaded.found) return { status: "missing" };
    return { status: "reloaded", record: loaded.value };
  }
  const newCourseId = options.newCourseId ?? newUuid();
  const parsed = validateCourse({ ...session.document(), id: newCourseId, revision: 0 });
  if (!parsed.ok) return { status: "failed", error: { kind: "abort", name: parsed.error.code } };
  const record = toRecord(parsed.value, (options.now ?? Date.now)());
  const inserted = await insertRecord(db, record);
  if (inserted.status === "created") return { status: "copied", record: inserted.record, sourceId: session.document().id };
  if (inserted.status === "failed") return inserted;
  return { status: "failed", error: { kind: "conflict", name: "constraint" } };
}
