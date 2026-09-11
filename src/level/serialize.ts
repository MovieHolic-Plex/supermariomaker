import { COURSE_LIMITS, type CourseV1, type ValidationResult } from "./types";
import { validateCourse } from "./validate";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const tooLarge = { ok: false, error: { code: "file_too_large", path: "$", message: "코스 파일은 UTF-8 기준 32 MiB를 넘을 수 없습니다." } } as const;

/** Decode bytes strictly and validate the whole replacement before returning it. */
export function parseCourse(input: string | Uint8Array): ValidationResult<CourseV1> {
  const bytes = typeof input === "string" ? encoder.encode(input) : input;
  if (bytes.byteLength > COURSE_LIMITS.fileBytes) return tooLarge;
  let text: string;
  try { text = typeof input === "string" ? input : decoder.decode(bytes); }
  catch (error) {
    if (error instanceof TypeError) return { ok: false, error: { code: "invalid_utf8", path: "$", message: "파일이 올바른 UTF-8이 아닙니다." } };
    throw error;
  }
  let parsed: unknown;
  try { parsed = JSON.parse(text); }
  catch (error) {
    if (error instanceof SyntaxError) return { ok: false, error: { code: "malformed_json", path: "$", message: "파일이 올바른 JSON이 아닙니다." } };
    throw error;
  }
  return validateCourse(parsed);
}
const compareIds = (a: Readonly<{ id: string }>, b: Readonly<{ id: string }>) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
/** Stable key order, area/object UUID order, and row-major sparse cells; no input sorting. */
function canonical(course: CourseV1): string {
  const ordered = { ...course, areas: [...course.areas].sort(compareIds).map((area) => ({
    ...area, tiles: [...area.tiles].sort((a, b) => a.y - b.y || a.x - b.x), objects: [...area.objects].sort(compareIds),
  })) };
  return JSON.stringify(ordered, (_key, value: unknown) => {
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
    }
    return value;
  });
}
/** Export current valid authored content, including the storage revision token. */
export function serializeCourse(input: unknown): ValidationResult<string> {
  const parsed = validateCourse(input);
  if (!parsed.ok) return parsed;
  const text = canonical(parsed.value);
  if (encoder.encode(text).byteLength > COURSE_LIMITS.fileBytes) return tooLarge;
  return { ok: true, value: text };
}
/** History/dirty identity is separate from persistence serialization. Inputs are typed drafts. */
export function authoredContentEqual(left: CourseV1, right: CourseV1): boolean {
  return canonical({ ...left, revision: 0 }) === canonical({ ...right, revision: 0 });
}
