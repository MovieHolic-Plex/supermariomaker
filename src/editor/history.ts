import { authoredContentEqual } from "../level/serialize";
import type { CourseV1, ValidationIssue, ValidationResult } from "../level/types";
import { validateCourse } from "../level/validate";

export const HISTORY_CAP = 200;

export type HistorySnapshot = Readonly<{
  document: CourseV1;
  undoCount: number;
  redoCount: number;
  dirty: boolean;
  generation: number;
}>;

export type CommitOutcome =
  | Readonly<{ status: "committed"; document: CourseV1 }>
  | Readonly<{ status: "noop"; document: CourseV1 }>
  | Readonly<{ status: "rejected"; document: CourseV1; error: ValidationIssue }>;

export type EditorHistory = {
  document(): CourseV1;
  snapshot(): HistorySnapshot;
  commit(input: CourseV1 | ValidationResult<CourseV1>): CommitOutcome;
  undo(): boolean;
  redo(): boolean;
  markSaved(): void;
};

function asResult(input: CourseV1 | ValidationResult<CourseV1>): ValidationResult<CourseV1> {
  return Object.hasOwn(input, "ok") ? input as ValidationResult<CourseV1> : validateCourse(input);
}

/** Snapshot stack: dirty is authored-content identity against the saved document, not stack depth. */
export function createHistory(initial: CourseV1): EditorHistory {
  const parsed = validateCourse(initial);
  if (!parsed.ok) throw new Error(`${parsed.error.code}: ${parsed.error.message}`);
  let current = parsed.value;
  let saved = current;
  const undoStack: CourseV1[] = [];
  const redoStack: CourseV1[] = [];
  let generation = 0;
  return {
    document: () => current,
    snapshot: () => ({
      document: current,
      undoCount: undoStack.length,
      redoCount: redoStack.length,
      dirty: !authoredContentEqual(current, saved),
      generation,
    }),
    commit(input) {
      const result = asResult(input);
      if (!result.ok) return { status: "rejected", document: current, error: result.error };
      if (authoredContentEqual(current, result.value)) return { status: "noop", document: current };
      undoStack.push(current);
      if (undoStack.length > HISTORY_CAP) undoStack.shift();
      redoStack.length = 0;
      current = result.value;
      generation += 1;
      return { status: "committed", document: current };
    },
    undo() {
      const previous = undoStack.pop();
      if (!previous) return false;
      redoStack.push(current);
      current = previous;
      generation += 1;
      return true;
    },
    redo() {
      const next = redoStack.pop();
      if (!next) return false;
      undoStack.push(current);
      current = next;
      generation += 1;
      return true;
    },
    markSaved() { saved = current; },
  };
}
