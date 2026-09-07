// allow: SIZE_OK - this contract-owned module is the complete v1 trust boundary;
// per-kind parsing and cross-document invariants must agree before a value escapes.
import { BLOCK_CONTENTS, COURSE_LIMITS, OBJECT_KINDS, THEMES, TILE_KINDS } from "./types";
import type { AreaV1, Bounds, Bridge, CourseStart, CourseV1, PlacedObject, PreviewOptions, TileCell, ValidationCode, ValidationIssue, ValidationResult } from "./types";

class InvalidCourse extends Error {
  override readonly name = "InvalidCourse";
  constructor(readonly issue: ValidationIssue) { super(issue.message); }
}
function fail(code: ValidationCode, path: string, message: string): never {
  throw new InvalidCourse({ code, path, message });
}
function attempt<T>(parse: () => T): ValidationResult<T> {
  try { return { ok: true, value: parse() }; }
  catch (error) {
    if (error instanceof InvalidCourse) return { ok: false, error: error.issue };
    throw error;
  }
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
/** Native JSON boundary reader: no runtime dependency or unchecked cast. */
class Field {
  constructor(readonly value: unknown, readonly path: string) {}
  object(keys: readonly string[]): this {
    if (!isRecord(this.value)) fail("invalid_type", this.path, "Expected an object");
    const prototype: unknown = Object.getPrototypeOf(this.value);
    if (prototype !== Object.prototype && prototype !== null) fail("invalid_type", this.path, "Expected plain JSON data");
    for (const key of Reflect.ownKeys(this.value)) {
      if (typeof key !== "string" || !keys.includes(key)) fail("unknown_field", `${this.path}.${String(key)}`, "Unknown property");
      const descriptor = Object.getOwnPropertyDescriptor(this.value, key);
      if (descriptor?.get || descriptor?.set) fail("invalid_type", `${this.path}.${key}`, "Expected a data property");
    }
    return this;
  }
  at(key: string): Field {
    if (!isRecord(this.value)) fail("invalid_type", this.path, "Expected an object");
    return new Field(Object.hasOwn(this.value, key) ? this.value[key] : undefined, `${this.path}.${key}`);
  }
  has(key: string): boolean { return isRecord(this.value) && Object.hasOwn(this.value, key); }
  array(): readonly Field[] {
    if (!Array.isArray(this.value)) fail("invalid_type", this.path, "Expected an array");
    return Array.from(this.value, (value: unknown, i) => new Field(value, `${this.path}[${i}]`));
  }
  text(): string {
    if (typeof this.value !== "string") fail("invalid_type", this.path, "Expected text");
    return this.value;
  }
  uuid(): string {
    const text = this.text();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(text)) fail("invalid_id", this.path, "Expected a UUID");
    return text.toLowerCase();
  }
  integer(min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER): number {
    if (typeof this.value !== "number") fail("invalid_type", this.path, "Expected a number");
    if (!Number.isSafeInteger(this.value) || this.value < min || this.value > max) fail("invalid_value", this.path, "Integer outside allowed range");
    return this.value;
  }
  choice<T extends string | number>(choices: readonly T[], code: ValidationCode = "invalid_value"): T {
    const selected = choices.find((choice) => choice === this.value);
    if (selected === undefined) fail(code, this.path, "Unsupported value");
    return selected;
  }
}
function readStart(field: Field): CourseStart {
  field.object(["areaId", "x", "y"]);
  return { areaId: field.at("areaId").uuid(), x: field.at("x").integer(), y: field.at("y").integer() };
}
function readBridge(field: Field): Bridge {
  field.object(["x", "y", "width", "height"]);
  return { x: field.at("x").integer(), y: field.at("y").integer(), width: field.at("width").integer(1, 64), height: field.at("height").choice([1]) };
}
function readTile(field: Field): TileCell {
  field.object(["x", "y", "kind", "content"]);
  const position = { x: field.at("x").integer(), y: field.at("y").integer() };
  const kind = field.at("kind").choice(TILE_KINDS, "unknown_kind");
  switch (kind) {
    case "brick": case "question": case "hidden":
      return { ...position, kind, ...(field.has("content") ? { content: field.at("content").choice(BLOCK_CONTENTS) } : {}) };
    case "ground": case "used": case "hard": case "coin":
      field.object(["x", "y", "kind"]);
      return { ...position, kind };
    default: return unreachable(kind);
  }
}
function readObject(field: Field): PlacedObject {
  field.object(["id", "kind", "x", "y", "props"]);
  const base = { id: field.at("id").uuid(), x: field.at("x").integer(), y: field.at("y").integer() };
  if (base.x % 16 !== 0 || base.y % 16 !== 0) fail("invalid_value", field.path, "Objects must use the 16-pixel grid");
  const kind = field.at("kind").choice(OBJECT_KINDS, "unknown_kind");
  const props = field.at("props");
  switch (kind) {
    case "pipe": {
      props.object(["height", "entrance", "destination"]);
      const height = props.at("height").integer(2, 16);
      const entrance = props.at("entrance").choice(["none", "down", "up"]);
      if (!props.has("destination")) return { ...base, kind, props: { height, entrance } };
      const destination = props.at("destination").object(["areaId", "pipeId"]);
      return { ...base, kind, props: { height, entrance, destination: { areaId: destination.at("areaId").uuid(), pipeId: destination.at("pipeId").uuid() } } };
    }
    case "platform": {
      props.object(["motion", "length", "travel", "speed", "pairId"]);
      const dimensions = { length: props.at("length").integer(2, 8), travel: props.at("travel").integer(1, 32), speed: props.at("speed").choice([0.5, 1, 2]) };
      const motion = props.at("motion").choice(["horizontal", "vertical", "falling", "balance"]);
      switch (motion) {
        case "balance": return { ...base, kind, props: { ...dimensions, motion, ...(props.has("pairId") ? { pairId: props.at("pairId").uuid() } : {}) } };
        case "horizontal": case "vertical": case "falling":
          props.object(["motion", "length", "travel", "speed"]);
          return { ...base, kind, props: { ...dimensions, motion } };
        default: return unreachable(motion);
      }
    }
    case "flagGoal":
      props.object(["height"]);
      return { ...base, kind, props: { height: props.at("height").integer(4, 12) } };
    case "castleGoal":
      props.object(["bridge", "bowserId"]);
      return { ...base, kind, props: { bridge: readBridge(props.at("bridge")), ...(props.has("bowserId") ? { bowserId: props.at("bowserId").uuid() } : {}) } };
    case "koopa":
      props.object(["color"]);
      return { ...base, kind, props: { color: props.at("color").choice(["green", "red"]) } };
    case "paratroopa":
      props.object(["color", "motion"]);
      return { ...base, kind, props: { color: props.at("color").choice(["green", "red"]), motion: props.at("motion").choice(["hop", "vertical"]) } };
    case "piranha":
      props.object(["pipeId"]);
      return { ...base, kind, props: { pipeId: props.at("pipeId").uuid() } };
    case "cheep":
      props.object(["color", "mode"]);
      return { ...base, kind, props: { color: props.at("color").choice(["green", "red"]), mode: props.at("mode").choice(["swim", "leap"]) } };
    case "firebar":
      props.object(["length", "direction", "speed"]);
      return { ...base, kind, props: { length: props.at("length").integer(3, 12), direction: props.at("direction").choice(["cw", "ccw"]), speed: props.at("speed").choice(["slow", "normal", "fast"]) } };
    case "warpZone": {
      props.object(["pipeIds"]);
      const slots = props.at("pipeIds").array();
      if (slots.length !== 3) fail("invalid_value", props.path, "Warp zones require exactly three slots");
      const [first, second, third] = slots;
      if (!first || !second || !third) fail("invalid_value", props.path, "Missing warp slot");
      return { ...base, kind, props: { pipeIds: [first.value === null ? null : first.uuid(), second.value === null ? null : second.uuid(), third.value === null ? null : third.uuid()] } };
    }
    case "spring": case "goomba": case "buzzy": case "billCannon": case "hammerBro":
    case "lakitu": case "blooper": case "podoboo": case "bowser":
      props.object([]);
      return { ...base, kind, props: {} };
    default: return unreachable(kind);
  }
}
function unreachable(value: never): never {
  return fail("unknown_kind", "$", `Unsupported variant: ${String(value)}`);
}

/** Authored collider extents, also available to the catalog's placement preview. */
export function objectBounds(object: PlacedObject): Bounds {
  let width = 16;
  let height = 16;
  switch (object.kind) {
    case "pipe": width = 32; height = object.props.height * 16; break;
    case "platform": width = object.props.length * 16; height = 8; break;
    case "bowser": width = 32; height = 32; break;
    case "hammerBro": height = 24; break;
    case "flagGoal": height = object.props.height * 16; break;
    case "castleGoal": case "spring": case "goomba": case "koopa": case "paratroopa":
    case "piranha": case "buzzy": case "billCannon": case "lakitu": case "cheep":
    case "blooper": case "podoboo": case "firebar": case "warpZone": break;
    default: return unreachable(object);
  }
  return { x: object.x - width / 2, y: object.y - height, width, height };
}
function fits(bounds: Bounds, area: AreaV1): boolean {
  return bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= area.width * 16 && bounds.y + bounds.height <= area.height * 16;
}
function overlaps(a: Bounds, b: Bounds): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}
function bridgeBounds(bridge: Bridge): Bounds {
  return { x: bridge.x * 16, y: bridge.y * 16, width: bridge.width * 16, height: 16 };
}
function startBounds(start: CourseStart): Bounds { return { x: start.x - 6, y: start.y - 15, width: 12, height: 15 }; }

function readCourse(root: Field): CourseV1 {
  root.object(["format", "version", "id", "title", "revision", "mainAreaId", "start", "timerSeconds", "areas"]);
  const format = root.at("format").choice(["smb1-maker"]);
  const version = root.at("version").choice([1], "unsupported_version");
  const id = root.at("id").uuid();
  const title = root.at("title").text();
  if (title.trim() !== title || title.length < 1 || title.length > 80) fail("invalid_value", "$.title", "Title must be trimmed and 1-80 characters");
  const revision = root.at("revision").integer(0);
  const mainAreaId = root.at("mainAreaId").uuid();
  const start = readStart(root.at("start"));
  const timerSeconds = root.at("timerSeconds").integer(0, 999);
  if (timerSeconds > 0 && timerSeconds < 30) fail("invalid_value", "$.timerSeconds", "Timer must be zero or 30-999");
  const areaFields = root.at("areas").array();
  if (areaFields.length < 1 || areaFields.length > COURSE_LIMITS.areas) fail("limit_exceeded", "$.areas", "Course needs 1-16 areas");
  const sources = areaFields.map((field) => {
    field.object(["id", "name", "theme", "width", "height", "tiles", "objects"]);
    return { field, tiles: field.at("tiles").array(), objects: field.at("objects").array() };
  });
  if (sources.reduce((total, source) => total + source.tiles.length, 0) > COURSE_LIMITS.tiles) fail("limit_exceeded", "$.areas", "Too many populated cells");
  if (sources.reduce((total, source) => total + source.objects.length, 0) > COURSE_LIMITS.objects) fail("limit_exceeded", "$.areas", "Too many placed objects");
  const areas: AreaV1[] = sources.map(({ field, tiles, objects }) => ({
    id: field.at("id").uuid(), name: field.at("name").text(), theme: field.at("theme").choice(THEMES),
    width: field.at("width").integer(COURSE_LIMITS.minWidth, COURSE_LIMITS.maxWidth),
    height: field.at("height").integer(COURSE_LIMITS.minHeight, COURSE_LIMITS.maxHeight),
    tiles: tiles.map(readTile), objects: objects.map(readObject),
  }));
  const course: CourseV1 = { format, version, id, title, revision, mainAreaId, start, timerSeconds, areas };
  checkDocument(course);
  return course;
}
function checkDocument(course: CourseV1): void {
  const ids = new Set([course.id]);
  const areaIndex = new Map(course.areas.map((area) => [area.id, area]));
  const objectIndex = new Map<string, Readonly<{ area: AreaV1; object: PlacedObject }>>();
  for (const [i, area] of course.areas.entries()) {
    const path = `$.areas[${i}]`;
    if (ids.has(area.id)) fail("duplicate_id", `${path}.id`, "IDs must be unique throughout the course");
    ids.add(area.id);
    const cells = new Set<number>();
    for (const [j, tile] of area.tiles.entries()) {
      if (tile.x < 0 || tile.y < 0 || tile.x >= area.width || tile.y >= area.height) fail("out_of_bounds", `${path}.tiles[${j}]`, "Cell outside area");
      const key = tile.y * area.width + tile.x;
      if (cells.has(key)) fail("duplicate_cell", `${path}.tiles[${j}]`, "Only one cell may occupy each coordinate");
      cells.add(key);
    }
    for (const [j, object] of area.objects.entries()) {
      const objectPath = `${path}.objects[${j}]`;
      if (ids.has(object.id)) fail("duplicate_id", `${objectPath}.id`, "IDs must be unique throughout the course");
      ids.add(object.id);
      objectIndex.set(object.id, { area, object });
      if (!fits(objectBounds(object), area)) fail("out_of_bounds", objectPath, "Entire object collider must fit the area");
      if (object.kind === "castleGoal") {
        const bridge = object.props.bridge;
        if (!fits(bridgeBounds(bridge), area)) fail("out_of_bounds", `${objectPath}.props.bridge`, "Entire bridge must fit the area");
        for (let x = bridge.x; x < bridge.x + bridge.width; x++) {
          if (cells.has(bridge.y * area.width + x)) fail("occupied_bridge", `${objectPath}.props.bridge`, "Bridge must overlay empty cells");
        }
      }
    }
  }
  if (!areaIndex.has(course.mainAreaId)) fail("invalid_reference", "$.mainAreaId", "Main area does not exist");
  const startArea = areaIndex.get(course.start.areaId);
  if (!startArea) fail("invalid_reference", "$.start.areaId", "Start area does not exist");
  if (!fits(startBounds(course.start), startArea)) fail("out_of_bounds", "$.start", "Entire player collider must fit the start area");
  for (const [i, area] of course.areas.entries()) {
    for (const [j, object] of area.objects.entries()) {
      const path = `$.areas[${i}].objects[${j}].props`;
      const local = (id: string) => {
        const target = objectIndex.get(id);
        return target?.area.id === area.id ? target.object : undefined;
      };
      switch (object.kind) {
        case "pipe": {
          const destination = object.props.destination;
          if (!destination) break;
          const target = objectIndex.get(destination.pipeId);
          if (!target || target.area.id !== destination.areaId || target.object.kind !== "pipe" || target.object.id === object.id
            || target.object.props.destination?.areaId !== area.id || target.object.props.destination.pipeId !== object.id) {
            fail("invalid_reference", `${path}.destination`, "Pipe links must name distinct reciprocal pipes");
          }
          break;
        }
        case "platform": {
          if (object.props.motion !== "balance" || !object.props.pairId) break;
          const target = local(object.props.pairId);
          if (!target || target.kind !== "platform" || target.id === object.id || target.props.motion !== "balance" || target.props.pairId !== object.id) {
            fail("invalid_reference", `${path}.pairId`, "Balance pairs must be distinct, reciprocal and in the same area");
          }
          break;
        }
        case "piranha": {
          const target = local(object.props.pipeId);
          if (!target || target.kind !== "pipe" || object.x !== target.x || object.y !== target.y - target.props.height * 16) {
            fail("invalid_reference", `${path}.pipeId`, "Piranha must be attached at its same-area pipe mouth");
          }
          break;
        }
        case "castleGoal":
          if (object.props.bowserId && local(object.props.bowserId)?.kind !== "bowser") fail("invalid_reference", `${path}.bowserId`, "Bowser must exist in the same area");
          break;
        case "warpZone": {
          const slots = object.props.pipeIds.filter((id) => id !== null);
          if (new Set(slots).size !== slots.length || slots.some((id) => local(id)?.kind !== "pipe")) fail("invalid_reference", `${path}.pipeIds`, "Warp slots must name distinct same-area pipes");
          break;
        }
        case "spring": case "flagGoal": case "goomba": case "koopa": case "paratroopa":
        case "buzzy": case "billCannon": case "hammerBro": case "lakitu": case "cheep":
        case "blooper": case "podoboo": case "firebar": case "bowser": break;
        default: unreachable(object);
      }
    }
  }
}

/** Valid incomplete drafts are accepted; no mutation or partially parsed value escapes. */
export function validateCourse(input: unknown): ValidationResult<CourseV1> {
  return attempt(() => readCourse(new Field(input, "$")));
}
/** Preview requires a clear small-player spawn and a goal unless explicitly bypassed. */
export function validatePreview(input: unknown, options: PreviewOptions = {}): ValidationResult<CourseStart> {
  return attempt(() => {
    const course = readCourse(new Field(input, "$"));
    const start = options.spawnOverride === undefined ? course.start : readStart(new Field(options.spawnOverride, "$.spawnOverride"));
    const area = course.areas.find((candidate) => candidate.id === start.areaId);
    const path = options.spawnOverride === undefined ? "$.start" : "$.spawnOverride";
    if (!area) fail("invalid_reference", path, "Spawn area does not exist");
    const bounds = startBounds(start);
    if (!fits(bounds, area)) fail("out_of_bounds", path, "Entire player collider must fit the spawn area");
    for (const tile of area.tiles) {
      if (tile.kind !== "coin" && tile.kind !== "hidden" && overlaps(bounds, { x: tile.x * 16, y: tile.y * 16, width: 16, height: 16 })) {
        fail("start_blocked", path, "Spawn intersects solid terrain");
      }
    }
    for (const object of area.objects) {
      switch (object.kind) {
        case "pipe": case "platform": case "spring": case "billCannon": case "firebar":
          if (overlaps(bounds, objectBounds(object))) fail("start_blocked", path, "Spawn intersects a solid object");
          break;
        case "castleGoal":
          if (overlaps(bounds, bridgeBounds(object.props.bridge))) fail("start_blocked", path, "Spawn intersects a bridge");
          break;
        case "flagGoal": case "goomba": case "koopa": case "paratroopa": case "piranha":
        case "buzzy": case "hammerBro": case "lakitu": case "cheep": case "blooper":
        case "podoboo": case "bowser": case "warpZone": break;
        default: unreachable(object);
      }
    }
    if (!options.allowNoGoal && !course.areas.some((candidate) => candidate.objects.some((object) => object.kind === "flagGoal" || object.kind === "castleGoal"))) {
      fail("goal_required", "$.areas", "Preview requires a goal or explicit goal-free testing");
    }
    return start;
  });
}
