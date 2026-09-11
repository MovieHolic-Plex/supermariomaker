import { parseCourse, serializeCourse } from "../level/serialize";
import { COURSE_LIMITS, type CourseV1, type ValidationIssue, type ValidationResult } from "../level/types";
import { validateCourse } from "../level/validate";
import {
  COURSES_STORE, requestResult, transactionTerminal,
  type CourseRecord, type DatabaseHandle, type StorageError, type TransactionLike,
} from "./db";

export const COURSE_FILE_MIME = "application/json";
export const COURSE_FILE_SUFFIX = ".smb1.json";

export type CourseDownload = Readonly<{
  blob: Blob;
  filename: string;
  mimeType: typeof COURSE_FILE_MIME;
}>;

export type ImportCourseFileOptions = Readonly<{
  now?: () => number;
  newCourseId?: string;
}>;

export type ImportCourseFileResult =
  | Readonly<{ status: "imported"; record: CourseRecord }>
  | Readonly<{ status: "invalid"; error: ValidationIssue }>
  | Readonly<{ status: "failed"; error: StorageError }>;

const encoder = new TextEncoder();
const tooLarge = {
  ok: false,
  error: { code: "file_too_large" as const, path: "$", message: "코스 파일은 UTF-8 기준 32 MiB를 넘을 수 없습니다." },
} as const;

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

function toRecord(document: CourseV1, updatedAt: number): CourseRecord {
  return { id: document.id, title: document.title, updatedAt, document };
}

/** Size is decided from raw bytes so an oversized payload never reaches JSON.parse. */
export function readCourseFile(bytes: Uint8Array): ValidationResult<CourseV1> {
  if (bytes.byteLength > COURSE_LIMITS.fileBytes) return tooLarge;
  return parseCourse(bytes);
}

/** Basename only: title plus `.smb1.json`, with path/markup characters replaced. */
export function sanitizeCourseFilename(title: string): string {
  const replaced = title.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").replace(/^\.+/, "").replace(/\.+$/, "").trim();
  const base = replaced.length > 0 ? replaced : "course";
  return `${base}${COURSE_FILE_SUFFIX}`;
}

/** Validated JSON Blob for a later UI-triggered download. Not a confirmed disk write. */
export function exportCourseFile(course: CourseV1): ValidationResult<CourseDownload> {
  const serialized = serializeCourse(course);
  if (!serialized.ok) return serialized;
  return {
    ok: true,
    value: {
      blob: new Blob([encoder.encode(serialized.value)], { type: COURSE_FILE_MIME }),
      filename: sanitizeCourseFilename(course.title),
      mimeType: COURSE_FILE_MIME,
    },
  };
}

/** New course id and revision 0; area and object ids stay as authored. */
export function assignImportedIdentity(course: CourseV1, newCourseId: string): ValidationResult<CourseV1> {
  return validateCourse({ ...course, id: newCourseId, revision: 0 });
}

async function insertImportedRecord(db: DatabaseHandle, record: CourseRecord): Promise<ImportCourseFileResult> {
  const tx = db.transaction([COURSES_STORE], "readwrite");
  const terminal = transactionTerminal(tx);
  try {
    const store = tx.objectStore(COURSES_STORE);
    const existing = asRecord(await requestResult(store.get(record.id)));
    if (existing !== undefined) {
      tx.abort();
      await terminal;
      return { status: "failed", error: { kind: "conflict", name: "constraint" } };
    }
    await requestResult(store.put(record));
    const end = await terminal;
    if (end === "complete") return { status: "imported", record };
    return { status: "failed", error: failedError(tx) };
  } catch (caught) {
    await terminal;
    return { status: "failed", error: failedError(tx, caught) };
  }
}

/**
 * Validate the whole file, then insert a NEW library id. Does not switch last-open or the caller's session.
 * Library `createLibraryCourse` must not be used here: it would remember the open course.
 */
export async function importCourseFile(
  db: DatabaseHandle,
  bytes: Uint8Array,
  options: ImportCourseFileOptions = {},
): Promise<ImportCourseFileResult> {
  const read = readCourseFile(bytes);
  if (!read.ok) return { status: "invalid", error: read.error };
  const prepared = assignImportedIdentity(read.value, options.newCourseId ?? globalThis.crypto.randomUUID());
  if (!prepared.ok) return { status: "invalid", error: prepared.error };
  const now = options.now ?? Date.now;
  return insertImportedRecord(db, toRecord(prepared.value, now()));
}
