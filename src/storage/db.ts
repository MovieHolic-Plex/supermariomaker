import type { CourseV1 } from "../level/types";

export const DATABASE_NAME = "smb1-maker";
export const DATABASE_VERSION = 1;
export const COURSES_STORE = "courses";
export const SETTINGS_STORE = "settings";

export type CourseRecord = Readonly<{
  id: string;
  title: string;
  updatedAt: number;
  document: CourseV1;
}>;

export type SettingRecord = Readonly<{ key: string; value: unknown }>;

export type GetResult<T> = Readonly<{ found: false }> | Readonly<{ found: true; value: T }>;

export type StorageErrorKind = "abort" | "quota" | "conflict" | "deleted" | "unavailable";
export type StorageError = Readonly<{ kind: StorageErrorKind; name: string }>;

export type DbEvent =
  | Readonly<{ kind: "request"; op: "get" | "put" | "delete" | "getAll"; status: "success" | "error" }>
  | Readonly<{ kind: "complete" }>
  | Readonly<{ kind: "abort" }>;

export type RequestLike = {
  result: unknown;
  error: DOMException | Error | null;
  onsuccess: ((this: RequestLike, ev: Event) => unknown) | null;
  onerror: ((this: RequestLike, ev: Event) => unknown) | null;
};

export type ObjectStoreLike = {
  get(key: IDBValidKey): RequestLike;
  put(value: unknown): RequestLike;
  delete(key: IDBValidKey): RequestLike;
  /** ADDITIVE for task 19 library listing: enumerate through the transactional path. Not a second index. */
  getAll(): RequestLike;
};

export type TransactionLike = {
  objectStore(name: string): ObjectStoreLike;
  abort(): void;
  oncomplete: ((this: TransactionLike, ev: Event) => unknown) | null;
  onabort: ((this: TransactionLike, ev: Event) => unknown) | null;
  onerror: ((this: TransactionLike, ev: Event) => unknown) | null;
  readonly error: DOMException | Error | null;
};

export type TransactionFactory = (
  storeNames: readonly string[],
  mode: "readonly" | "readwrite",
) => TransactionLike;

export type DatabaseHandle = {
  transaction: TransactionFactory;
  close(): void;
};

export type OpenDatabaseOptions = Readonly<{ factory?: IDBFactory | undefined }>;
export type OpenDatabaseResult =
  | Readonly<{ ok: true; db: DatabaseHandle }>
  | Readonly<{ ok: false; error: StorageError }>;

export type MemoryDatabase = DatabaseHandle & {
  events(): readonly DbEvent[];
  holdNextComplete(): void;
  releaseHeldComplete(): void;
  failNextPut(kind: "quota" | "abort"): void;
  waitForRequest(op: "get" | "put" | "delete"): Promise<DbEvent>;
  getCourse(id: string): GetResult<CourseRecord>;
  getSetting(key: string): GetResult<unknown>;
  seedCourse(record: CourseRecord): void;
};

type FailKind = "quota" | "abort";
type StoreName = typeof COURSES_STORE | typeof SETTINGS_STORE;
type StoreOp = "get" | "put" | "delete" | "getAll";
type Waiter = Readonly<{ op: "get" | "put" | "delete"; resolve: (event: DbEvent) => void }>;

function namedError(name: string, message: string): DOMException | Error {
  if (typeof DOMException === "function") {
    try { return new DOMException(message, name); } catch { /* fall through */ }
  }
  const error = new Error(message);
  error.name = name;
  return error;
}

function abortError(): DOMException | Error {
  return namedError("AbortError", "The transaction was aborted.");
}

function quotaError(): DOMException | Error {
  return namedError("QuotaExceededError", "The quota has been exceeded.");
}

function asEvent(type: string): Event {
  if (typeof Event === "function") {
    try { return new Event(type); } catch { /* fall through */ }
  }
  return { type } as Event;
}

function storeKey(store: StoreName, value: unknown): string | undefined {
  if (value === null || typeof value !== "object") return undefined;
  if (store === COURSES_STORE && "id" in value && typeof value.id === "string") return value.id;
  if (store === SETTINGS_STORE && "key" in value && typeof value.key === "string") return value.key;
  return undefined;
}

class MemoryRequest implements RequestLike {
  result: unknown = undefined;
  error: DOMException | Error | null = null;
  onsuccess: ((this: RequestLike, ev: Event) => unknown) | null = null;
  onerror: ((this: RequestLike, ev: Event) => unknown) | null = null;
}

class MemoryTransaction implements TransactionLike {
  oncomplete: ((this: TransactionLike, ev: Event) => unknown) | null = null;
  onabort: ((this: TransactionLike, ev: Event) => unknown) | null = null;
  onerror: ((this: TransactionLike, ev: Event) => unknown) | null = null;
  error: DOMException | Error | null = null;
  private pending = 0;
  private aborted = false;
  private finished = false;
  private finishing = false;
  private readonly overlay = {
    [COURSES_STORE]: new Map<string, unknown>(),
    [SETTINGS_STORE]: new Map<string, unknown>(),
    deleted: {
      [COURSES_STORE]: new Set<string>(),
      [SETTINGS_STORE]: new Set<string>(),
    },
  };

  constructor(
    private readonly names: readonly string[],
    private readonly started: Promise<void>,
    private readonly db: MemoryDatabaseState,
    private readonly onTerminal: () => void,
  ) {
    void this.started.then(() => {
      if (this.pending === 0) void this.maybeFinish();
    });
  }

  objectStore(name: string): ObjectStoreLike {
    if (!this.names.includes(name)) throw new Error(`Store ${name} is not in this transaction`);
    if (name !== COURSES_STORE && name !== SETTINGS_STORE) throw new Error(`Unknown store ${name}`);
    const store = name;
    return {
      get: (key) => this.enqueue("get", store, key),
      put: (value) => this.enqueue("put", store, value),
      delete: (key) => this.enqueue("delete", store, key),
      getAll: () => this.enqueue("getAll", store, undefined),
    };
  }

  abort(): void {
    if (this.finished || this.aborted) return;
    this.aborted = true;
    this.error = this.error ?? abortError();
    if (this.finishing) this.db.releaseHeldComplete();
    else void this.maybeFinish();
  }

  private enqueue(
    op: StoreOp,
    store: StoreName,
    arg: unknown,
  ): RequestLike {
    this.pending += 1;
    const request = new MemoryRequest();
    void this.started.then(() => this.execute(op, store, arg, request));
    return request;
  }

  private execute(
    op: StoreOp,
    store: StoreName,
    arg: unknown,
    request: MemoryRequest,
  ): void {
    if (this.finished) return;
    if (this.aborted) {
      this.failRequest(request, op, this.error ?? abortError());
      return;
    }
    if (op === "getAll") {
      const values: unknown[] = [];
      const overlayKeys = new Set(this.overlay[store].keys());
      for (const key of this.db.committedKeys(store)) {
        if (this.overlay.deleted[store].has(key) || overlayKeys.has(key)) continue;
        const value = this.db.readCommitted(store, key);
        if (value !== undefined) values.push(value);
      }
      for (const value of this.overlay[store].values()) values.push(value);
      request.result = values;
      request.error = null;
      this.succeedRequest(request, "getAll");
      return;
    }
    if (op === "get") {
      request.result = this.read(store, String(arg));
      request.error = null;
      this.succeedRequest(request, "get");
      return;
    }
    if (op === "delete") {
      const key = String(arg);
      this.overlay[store].delete(key);
      this.overlay.deleted[store].add(key);
      request.result = undefined;
      request.error = null;
      this.succeedRequest(request, "delete");
      return;
    }
    const fail = this.db.consumeFail();
    if (fail) {
      const error = fail === "quota" ? quotaError() : abortError();
      this.aborted = true;
      this.error = error;
      this.failRequest(request, "put", error);
      return;
    }
    const key = storeKey(store, arg);
    if (key === undefined) {
      const error = namedError("DataError", "Missing key path");
      this.aborted = true;
      this.error = error;
      this.failRequest(request, "put", error);
      return;
    }
    this.overlay.deleted[store].delete(key);
    this.overlay[store].set(key, arg);
    request.result = arg;
    request.error = null;
    this.succeedRequest(request, "put");
  }

  private succeedRequest(request: MemoryRequest, op: StoreOp): void {
    this.db.emit({ kind: "request", op, status: "success" });
    request.onsuccess?.(asEvent("success"));
    this.pending -= 1;
    void this.maybeFinish();
  }

  private failRequest(request: MemoryRequest, op: StoreOp, error: DOMException | Error): void {
    request.result = undefined;
    request.error = error;
    this.db.emit({ kind: "request", op, status: "error" });
    request.onerror?.(asEvent("error"));
    this.pending -= 1;
    void this.maybeFinish();
  }

  private read(store: StoreName, key: string): unknown {
    if (this.overlay.deleted[store].has(key)) return undefined;
    if (this.overlay[store].has(key)) return this.overlay[store].get(key);
    return this.db.readCommitted(store, key);
  }

  private async maybeFinish(): Promise<void> {
    if (this.pending > 0 || this.finished) return;
    if (!this.aborted) {
      this.finishing = true;
      await this.db.awaitCompleteHold();
    }
    if (this.finished) return;
    if (this.pending > 0) {
      this.finishing = false;
      return;
    }
    this.finished = true;
    if (this.aborted) {
      this.db.emit({ kind: "abort" });
      this.onabort?.(asEvent("abort"));
      this.onTerminal();
      return;
    }
    this.commit();
    this.db.emit({ kind: "complete" });
    this.oncomplete?.(asEvent("complete"));
    this.onTerminal();
  }

  private commit(): void {
    for (const store of [COURSES_STORE, SETTINGS_STORE] as const) {
      for (const key of this.overlay.deleted[store]) this.db.commitDelete(store, key);
      for (const [key, value] of this.overlay[store]) this.db.commitPut(store, key, value);
    }
  }
}

class MemoryDatabaseState {
  readonly courses = new Map<string, CourseRecord>();
  readonly settings = new Map<string, SettingRecord>();
  readonly eventLog: DbEvent[] = [];
  private fail: FailKind | null = null;
  private completeHold: Promise<void> | null = null;
  private releaseHold: (() => void) | null = null;
  private waiters: Waiter[] = [];
  private tail: Promise<void> = Promise.resolve();

  transaction(storeNames: readonly string[], mode: "readonly" | "readwrite"): TransactionLike {
    void mode;
    let release!: () => void;
    const done = new Promise<void>((resolve) => { release = resolve; });
    const started = this.tail;
    this.tail = done;
    return new MemoryTransaction(storeNames, started, this, release);
  }

  emit(event: DbEvent): void {
    this.eventLog.push(event);
    if (event.kind !== "request") return;
    const pending = this.waiters;
    this.waiters = [];
    for (const waiter of pending) {
      if (waiter.op === event.op) waiter.resolve(event);
      else this.waiters.push(waiter);
    }
  }

  events(): readonly DbEvent[] { return this.eventLog; }

  holdNextComplete(): void {
    this.completeHold = new Promise<void>((resolve) => { this.releaseHold = resolve; });
  }

  releaseHeldComplete(): void {
    this.releaseHold?.();
    this.releaseHold = null;
    this.completeHold = null;
  }

  async awaitCompleteHold(): Promise<void> {
    const hold = this.completeHold;
    if (hold) await hold;
  }

  failNextPut(kind: FailKind): void { this.fail = kind; }
  consumeFail(): FailKind | null {
    const fail = this.fail;
    this.fail = null;
    return fail;
  }

  waitForRequest(op: "get" | "put" | "delete"): Promise<DbEvent> {
    for (const event of this.eventLog) {
      if (event.kind === "request" && event.op === op) return Promise.resolve(event);
    }
    return new Promise((resolve) => { this.waiters.push({ op, resolve }); });
  }

  committedKeys(store: StoreName): Iterable<string> {
    return store === COURSES_STORE ? this.courses.keys() : this.settings.keys();
  }

  readCommitted(store: StoreName, key: string): unknown {
    if (store === COURSES_STORE) return this.courses.get(key);
    return this.settings.get(key);
  }

  commitPut(store: StoreName, key: string, value: unknown): void {
    if (store === COURSES_STORE) this.courses.set(key, structuredClone(value) as CourseRecord);
    else this.settings.set(key, structuredClone(value) as SettingRecord);
  }

  commitDelete(store: StoreName, key: string): void {
    if (store === COURSES_STORE) this.courses.delete(key);
    else this.settings.delete(key);
  }

  getCourse(id: string): GetResult<CourseRecord> {
    if (!this.courses.has(id)) return { found: false };
    const value = this.courses.get(id);
    if (value === undefined) return { found: false };
    return { found: true, value: structuredClone(value) };
  }

  getSetting(key: string): GetResult<unknown> {
    if (!this.settings.has(key)) return { found: false };
    const record = this.settings.get(key);
    if (record === undefined) return { found: false };
    return { found: true, value: record.value };
  }

  seedCourse(record: CourseRecord): void {
    this.courses.set(record.id, structuredClone(record));
  }
}

export function createMemoryDatabase(): MemoryDatabase {
  const state = new MemoryDatabaseState();
  return {
    transaction: (storeNames, mode) => state.transaction(storeNames, mode),
    close() { return; },
    events: () => state.events(),
    holdNextComplete: () => state.holdNextComplete(),
    releaseHeldComplete: () => state.releaseHeldComplete(),
    failNextPut: (kind) => state.failNextPut(kind),
    waitForRequest: (op) => state.waitForRequest(op),
    getCourse: (id) => state.getCourse(id),
    getSetting: (key) => state.getSetting(key),
    seedCourse: (record) => state.seedCourse(record),
  };
}

export function requestResult(request: RequestLike): Promise<unknown> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? namedError("Error", "Request failed"));
  });
}

export function transactionTerminal(tx: TransactionLike): Promise<"complete" | "abort"> {
  return new Promise((resolve) => {
    const previousComplete = tx.oncomplete;
    const previousAbort = tx.onabort;
    tx.oncomplete = function (ev) {
      previousComplete?.call(this, ev);
      resolve("complete");
    };
    tx.onabort = function (ev) {
      previousAbort?.call(this, ev);
      resolve("abort");
    };
  });
}

function wrapIdbRequest(request: IDBRequest): RequestLike {
  const wrapped: RequestLike = {
    result: undefined,
    error: null,
    onsuccess: null,
    onerror: null,
  };
  request.onsuccess = (event) => {
    wrapped.result = request.result;
    wrapped.error = null;
    wrapped.onsuccess?.(event);
  };
  request.onerror = (event) => {
    wrapped.error = request.error;
    wrapped.onerror?.(event);
  };
  return wrapped;
}

function wrapIdbTransaction(tx: IDBTransaction): TransactionLike {
  const wrapped: TransactionLike = {
    objectStore(name) {
      const store = tx.objectStore(name);
      return {
        get: (key) => wrapIdbRequest(store.get(key)),
        put: (value) => wrapIdbRequest(store.put(value)),
        delete: (key) => wrapIdbRequest(store.delete(key)),
        getAll: () => wrapIdbRequest(store.getAll()),
      };
    },
    abort() { tx.abort(); },
    oncomplete: null,
    onabort: null,
    onerror: null,
    get error() { return tx.error; },
  };
  tx.oncomplete = (event) => { wrapped.oncomplete?.(event); };
  tx.onabort = (event) => { wrapped.onabort?.(event); };
  tx.onerror = (event) => { wrapped.onerror?.(event); };
  return wrapped;
}

export function openDatabase(options: OpenDatabaseOptions = {}): Promise<OpenDatabaseResult> {
  const factory = options.factory ?? (typeof indexedDB === "undefined" ? undefined : indexedDB);
  if (!factory) {
    return Promise.resolve({ ok: false, error: { kind: "unavailable", name: "unavailable" } });
  }
  return new Promise((resolve) => {
    let request: IDBOpenDBRequest;
    try { request = factory.open(DATABASE_NAME, DATABASE_VERSION); }
    catch (error) {
      const name = error instanceof Error ? error.name : "unavailable";
      resolve({ ok: false, error: { kind: "unavailable", name } });
      return;
    }
    request.onerror = () => {
      resolve({ ok: false, error: { kind: "unavailable", name: request.error?.name ?? "unavailable" } });
    };
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(COURSES_STORE)) db.createObjectStore(COURSES_STORE, { keyPath: "id" });
      if (!db.objectStoreNames.contains(SETTINGS_STORE)) db.createObjectStore(SETTINGS_STORE, { keyPath: "key" });
    };
    request.onsuccess = () => {
      const db = request.result;
      resolve({
        ok: true,
        db: {
          transaction(storeNames, mode) {
            return wrapIdbTransaction(db.transaction(storeNames.slice(), mode));
          },
          close() { db.close(); },
        },
      });
    };
  });
}
