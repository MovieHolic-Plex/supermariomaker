import { authoredContentEqual } from "../level/serialize";
import type { CourseV1 } from "../level/types";
import {
  COURSES_STORE, requestResult, transactionTerminal,
  type CourseRecord, type DatabaseHandle, type StorageError, type TransactionLike,
} from "./db";

export type RecoveryAction = "retry" | "export" | "reload" | "save-copy";

export type AutosaveStatus = Readonly<{
  dirty: boolean;
  inFlight: boolean;
  queued: boolean;
  expectedStoredRevision: number | null;
  generation: number;
  error: StorageError | null;
  recovery: readonly RecoveryAction[] | null;
}>;

export type SaveOutcome =
  | Readonly<{ status: "saved"; revision: number; document: CourseV1 }>
  | Readonly<{ status: "coalesced" }>
  | Readonly<{ status: "cancelled" }>
  | Readonly<{ status: "conflict"; storedRevision: number }>
  | Readonly<{ status: "deleted" }>
  | Readonly<{ status: "failed"; error: StorageError }>;

export type DeleteOutcome =
  | Readonly<{ status: "deleted" }>
  | Readonly<{ status: "failed"; error: StorageError }>;

export type AutosaveOptions = Readonly<{
  db: DatabaseHandle;
  document: CourseV1;
  now?: () => number;
  expectedStoredRevision?: number | null;
}>;

type Job = {
  snapshot: CourseV1;
  resolve: (outcome: SaveOutcome) => void;
};

function cloneCourse(course: CourseV1): CourseV1 {
  return structuredClone(course);
}

function errorName(error: unknown): string {
  if (error && typeof error === "object" && "name" in error && typeof error.name === "string") return error.name;
  return "AbortError";
}

function failedFrom(tx: TransactionLike, caught?: unknown): SaveOutcome {
  const name = errorName(tx.error ?? caught);
  const kind = name === "QuotaExceededError" ? "quota" : "abort";
  return { status: "failed", error: { kind, name } };
}

function asRecord(value: unknown): CourseRecord | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || !("document" in value) || !("id" in value)) return undefined;
  return value as CourseRecord;
}

export type AutosaveSession = {
  status(): AutosaveStatus;
  document(): CourseV1;
  setDocument(document: CourseV1): void;
  requestSave(): Promise<SaveOutcome>;
  retry(): Promise<SaveOutcome>;
  deleteCourse(): Promise<DeleteOutcome>;
};

export function createAutosave(options: AutosaveOptions): AutosaveSession {
  const now = options.now ?? Date.now;
  let current = cloneCourse(options.document);
  let expectedStoredRevision = options.expectedStoredRevision ?? null;
  let lastSaved: CourseV1 | null = expectedStoredRevision === null ? null : cloneCourse(options.document);
  let generation = 0;
  let error: StorageError | null = null;
  let recovery: readonly RecoveryAction[] | null = null;
  let tombstone = false;
  let writing = false;
  let queued: Job | null = null;
  let activeTx: TransactionLike | null = null;
  let inFlight: Promise<SaveOutcome> | null = null;

  function dirty(): boolean {
    return lastSaved === null || !authoredContentEqual(current, lastSaved);
  }

  function status(): AutosaveStatus {
    return {
      dirty: dirty(),
      inFlight: writing,
      queued: queued !== null,
      expectedStoredRevision,
      generation,
      error,
      recovery,
    };
  }

  function setDocument(document: CourseV1): void {
    if (authoredContentEqual(current, document) && current.revision === document.revision) {
      current = document;
      return;
    }
    if (!authoredContentEqual(current, document)) generation += 1;
    current = document;
  }

  function toRecord(snapshot: CourseV1, revision: number): CourseRecord {
    const document = { ...snapshot, revision };
    return { id: document.id, title: document.title, updatedAt: now(), document };
  }

  async function commitSnapshot(snapshot: CourseV1, expected: number | null): Promise<SaveOutcome> {
    if (tombstone) return { status: "deleted" };
    const tx = options.db.transaction([COURSES_STORE], "readwrite");
    activeTx = tx;
    const terminal = transactionTerminal(tx);
    try {
      const store = tx.objectStore(COURSES_STORE);
      const existing = asRecord(await requestResult(store.get(snapshot.id)));
      if (tombstone) {
        tx.abort();
        await terminal;
        return { status: "cancelled" };
      }
      if (expected === null) {
        if (existing !== undefined) {
          tx.abort();
          await terminal;
          return { status: "conflict", storedRevision: existing.document.revision };
        }
        await requestResult(store.put(toRecord(snapshot, 0)));
      } else {
        if (existing === undefined) {
          tx.abort();
          await terminal;
          return { status: "deleted" };
        }
        if (existing.document.revision !== expected) {
          tx.abort();
          await terminal;
          return { status: "conflict", storedRevision: existing.document.revision };
        }
        await requestResult(store.put(toRecord(snapshot, expected + 1)));
      }
      const end = await terminal;
      if (end === "complete") {
        const revision = expected === null ? 0 : expected + 1;
        return { status: "saved", revision, document: { ...snapshot, revision } };
      }
      return failedFrom(tx);
    } catch (caught) {
      await terminal;
      if (tombstone) return { status: "cancelled" };
      return failedFrom(tx, caught);
    } finally {
      activeTx = null;
    }
  }

  function applyOutcome(outcome: SaveOutcome, snapshot: CourseV1): void {
    if (outcome.status === "saved") {
      expectedStoredRevision = outcome.revision;
      lastSaved = cloneCourse(snapshot);
      error = null;
      recovery = null;
      return;
    }
    if (outcome.status === "conflict") {
      error = { kind: "conflict", name: "constraint" };
      recovery = ["reload", "save-copy"];
      return;
    }
    if (outcome.status === "deleted") {
      error = { kind: "deleted", name: "deleted" };
      recovery = ["reload", "save-copy"];
      return;
    }
    if (outcome.status === "failed") {
      error = outcome.error;
      recovery = ["retry", "export"];
    }
  }

  async function perform(snapshot: CourseV1): Promise<SaveOutcome> {
    writing = true;
    const expected = expectedStoredRevision;
    const outcome = await commitSnapshot(snapshot, expected);
    applyOutcome(outcome, snapshot);
    const next = queued;
    queued = null;
    if (next) {
      if (tombstone) next.resolve({ status: "cancelled" });
      else next.resolve(await perform(next.snapshot));
    } else {
      writing = false;
    }
    return outcome;
  }

  function requestSave(): Promise<SaveOutcome> {
    if (tombstone) return Promise.resolve({ status: "deleted" });
    const snapshot = cloneCourse(current);
    if (writing) {
      if (queued) queued.resolve({ status: "coalesced" });
      return new Promise((resolve) => { queued = { snapshot, resolve }; });
    }
    const run = perform(snapshot);
    inFlight = run;
    void run.finally(() => { if (inFlight === run) inFlight = null; });
    return run;
  }

  function deleteCourse(): Promise<DeleteOutcome> {
    tombstone = true;
    if (queued) {
      queued.resolve({ status: "cancelled" });
      queued = null;
    }
    activeTx?.abort();
    const previous = inFlight ?? Promise.resolve();
    return previous.then(async () => {
      const tx = options.db.transaction([COURSES_STORE], "readwrite");
      const terminal = transactionTerminal(tx);
      try {
        await requestResult(tx.objectStore(COURSES_STORE).delete(current.id));
        const end = await terminal;
        if (end !== "complete") {
          return { status: "failed", error: { kind: "abort" as const, name: errorName(tx.error) } };
        }
        expectedStoredRevision = null;
        lastSaved = null;
        error = null;
        recovery = null;
        return { status: "deleted" as const };
      } catch (caught) {
        await terminal;
        return { status: "failed", error: { kind: "abort" as const, name: errorName(caught) } };
      }
    });
  }

  return {
    status,
    document: () => current,
    setDocument,
    requestSave,
    retry: () => requestSave(),
    deleteCourse,
  };
}
