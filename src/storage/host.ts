import type { CourseV1 } from "../level/types";
import {
  COURSES_STORE, SETTINGS_STORE, requestResult, transactionTerminal,
  type CourseRecord, type DatabaseHandle, type GetResult, type SettingRecord,
} from "./db";

export const LAST_OPEN_KEY = "lastOpenCourseId";

export async function readSetting(db: DatabaseHandle, key: string): Promise<GetResult<unknown>> {
  const tx = db.transaction([SETTINGS_STORE], "readonly");
  const terminal = transactionTerminal(tx);
  try {
    const record = await requestResult(tx.objectStore(SETTINGS_STORE).get(key));
    if (await terminal !== "complete") return { found: false };
    if (record === undefined || record === null) return { found: false };
    if (typeof record === "object" && "value" in record) return { found: true, value: (record as SettingRecord).value };
    return { found: false };
  } catch {
    await terminal;
    return { found: false };
  }
}

export async function writeSetting(db: DatabaseHandle, key: string, value: unknown): Promise<boolean> {
  const tx = db.transaction([SETTINGS_STORE], "readwrite");
  const terminal = transactionTerminal(tx);
  try {
    await requestResult(tx.objectStore(SETTINGS_STORE).put({ key, value }));
    return await terminal === "complete";
  } catch {
    await terminal;
    return false;
  }
}

export async function readCourse(db: DatabaseHandle, id: string): Promise<GetResult<CourseRecord>> {
  const tx = db.transaction([COURSES_STORE], "readonly");
  const terminal = transactionTerminal(tx);
  try {
    const record = await requestResult(tx.objectStore(COURSES_STORE).get(id));
    if (await terminal !== "complete") return { found: false };
    if (record === undefined || record === null || typeof record !== "object" || !("document" in record)) return { found: false };
    return { found: true, value: structuredClone(record) as CourseRecord };
  } catch {
    await terminal;
    return { found: false };
  }
}

export async function loadLastOpen(db: DatabaseHandle): Promise<CourseRecord | null> {
  const last = await readSetting(db, LAST_OPEN_KEY);
  if (!last.found || typeof last.value !== "string") return null;
  const course = await readCourse(db, last.value);
  return course.found ? course.value : null;
}

export async function rememberOpen(db: DatabaseHandle, course: CourseV1): Promise<void> {
  await writeSetting(db, LAST_OPEN_KEY, course.id);
}
