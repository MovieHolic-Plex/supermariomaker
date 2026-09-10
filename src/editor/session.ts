import { EMPTY_INPUT, InputBuffer } from "../input";
import type { InputFrame, PauseReason } from "../input";
import { createRun, pauseRun, restartRun, resumeRun, retryRun, stepRun } from "../game/run";
import type { Run, RunMode } from "../game/run";
import type { GameEvent } from "../game/state";
import type { CourseStart, CourseV1, PreviewOptions, ValidationIssue, ValidationResult } from "../level/types";
import { validatePreview } from "../level/validate";
import type { EditorHistory } from "./history";
import { emptySelection, type EditorSelection } from "./selection";
import type { Viewport } from "./viewport";

export type SessionMode = "EDIT" | RunMode;
export type EnterPlayOptions = PreviewOptions & {
  pending?: CourseV1 | ValidationResult<CourseV1>;
};
export type EnterPlayResult =
  | Readonly<{ ok: true; mode: "PLAYING" }>
  | Readonly<{ ok: false; error: ValidationIssue; mode: "EDIT" }>;

const defaultViewport: Viewport = { x: 0, y: 0, zoom: 1 };

export type EditorSession = {
  mode(): SessionMode;
  history(): EditorHistory;
  document(): CourseV1;
  playSource(): CourseV1 | null;
  run(): Run | null;
  selection(): EditorSelection;
  viewport(): Viewport;
  lastInput(): InputFrame;
  setSelection(selection: EditorSelection): void;
  setViewport(viewport: Viewport): void;
  enterPlay(options?: EnterPlayOptions): EnterPlayResult;
  pause(reason?: PauseReason): void;
  resume(): void;
  retry(): void;
  restart(): void;
  returnToEdit(): void;
  step(input?: InputFrame): GameEvent[];
};

/** Edit/play host: one Run from an immutable authored clone. No second clock or runtime. */
export function createEditorSession(input: {
  history: EditorHistory;
  selection?: EditorSelection;
  viewport?: Viewport;
  input?: InputBuffer;
}): EditorSession {
  const history = input.history;
  const buffer = input.input ?? new InputBuffer();
  let run: Run | null = null;
  let selection = input.selection ?? emptySelection(history.document().mainAreaId);
  let viewport = input.viewport ?? defaultViewport;
  let lastInput: InputFrame = EMPTY_INPUT;
  const editing = (): boolean => run === null;
  const release = (): void => { buffer.clear(); lastInput = EMPTY_INPUT; };
  return {
    mode: () => run?.mode ?? "EDIT",
    history: () => history,
    document: () => history.document(),
    playSource: () => run?.authored ?? null,
    run: () => run,
    selection: () => selection,
    viewport: () => viewport,
    lastInput: () => lastInput,
    setSelection(next) { if (editing()) selection = next; },
    setViewport(next) { if (editing()) viewport = next; },
    enterPlay(options = {}) {
      if (!editing()) return { ok: false, error: { code: "invalid_value", path: "$", message: "Already playing" }, mode: "EDIT" };
      if (options.pending !== undefined) {
        const outcome = history.commit(options.pending);
        if (outcome.status === "rejected") return { ok: false, error: outcome.error, mode: "EDIT" };
      }
      const preview: PreviewOptions = {
        ...(options.allowNoGoal ? { allowNoGoal: true } : {}),
        ...(options.spawnOverride ? { spawnOverride: options.spawnOverride } : {}),
      };
      const checked = validatePreview(history.document(), preview);
      if (!checked.ok) return { ok: false, error: checked.error, mode: "EDIT" };
      run = createRun(history.document(), options.spawnOverride);
      release();
      return { ok: true, mode: "PLAYING" };
    },
    pause(reason = "button") { if (run) { pauseRun(run, reason); release(); } },
    resume() { if (run) { resumeRun(run); release(); } },
    retry() { if (run) { retryRun(run); release(); } },
    restart() { if (run) { restartRun(run); release(); } },
    returnToEdit() { run = null; release(); },
    step(frame) {
      if (!run) return [];
      lastInput = frame ?? buffer.consume();
      return stepRun(run, lastInput);
    },
  };
}

export type { CourseStart, PauseReason };
