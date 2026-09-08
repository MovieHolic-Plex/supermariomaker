import type { AreaV1, CourseStart, CourseV1, TileCell } from "../level/types";
import { validatePreview } from "../level/validate";
import { PHYSICS } from "./physics";
import { playerBounds, sweepAxis } from "./collision";
import type { Contact } from "./collision";
import type { BlockEvent, BlockState } from "./blocks";
import type { ItemEvent, ItemState } from "./items";
import type { CombatState, ProgressEvent, ProgressState } from "./player";

export interface PlayerState {
  /** Bottom-center, pixels. Velocity is pixels per authoritative tick. */
  x: number; y: number; vx: number; vy: number;
  form: "small" | "super" | "fire";
  crouched: boolean; grounded: boolean; facing: -1 | 1; skidding: boolean;
  risingTicks: number;
}
export interface RuntimeArea {
  readonly source: AreaV1;
  /** Runtime terrain only. Coordinate key = y * source.width + x; stable ID is independent of kind. */
  readonly tiles: Map<number, TileCell>;
}
export interface Runtime {
  readonly course: CourseV1;
  readonly areas: Map<string, RuntimeArea>;
  areaId: string;
  tick: number;
  seed: number;
  player: PlayerState;
  contacts: Contact[];
  progress: ProgressState;
  combat: CombatState;
  blocks: BlockState;
  items: ItemState;
}
export type GameEvent =
  | Readonly<{ type: "jump"; tick: number }>
  | Readonly<{ type: "contact"; tick: number; contact: Contact }>
  | BlockEvent | ItemEvent | ProgressEvent;

/** Validates the spawn at this boundary. Goal-free permission belongs to the host's explicit action. */
export function createRuntime(course: CourseV1, spawnOverride?: CourseStart): Runtime {
  const checked = validatePreview(course, { allowNoGoal: true, ...(spawnOverride ? { spawnOverride } : {}) });
  if (!checked.ok) throw new Error(`${checked.error.code}: ${checked.error.message}`);
  const copy = structuredClone(course), start = checked.value;
  const runtime: Runtime = {
    course: copy, areas: new Map(copy.areas.map(source => [source.id, { source, tiles: new Map(source.tiles.map(tile => [tile.y * source.width + tile.x, { ...tile }])) }])),
    areaId: start.areaId, tick: 0, seed: 0x534d4231,
    progress: { lives: 3, coins: 0, score: 0 }, combat: { starTicks: 0, invulnerabilityTicks: 0, defeated: false },
    blocks: { multiCoins: {}, pending: [] }, items: { actors: [], pending: [], nextId: 1 },
    player: { x: start.x, y: start.y, vx: 0, vy: 0, form: "small", crouched: false, grounded: false, facing: 1, skidding: false, risingTicks: 0 }, contacts: [],
  };
  const support = sweepAxis(currentArea(runtime), playerBounds(runtime.player), 1 / PHYSICS.snap, "y");
  runtime.player.grounded = support.distance === 0 && support.contacts.length > 0;
  return runtime;
}
export function currentArea(runtime: Runtime): RuntimeArea {
  const area = runtime.areas.get(runtime.areaId);
  if (!area) throw new Error(`Runtime area missing: ${runtime.areaId}`);
  return area;
}
/** Detached observation. No Maps, DOM objects, live references, setters or authoring writers. */
export function snapshot(runtime: Runtime) {
  return structuredClone({ tick: runtime.tick, seed: runtime.seed, areaId: runtime.areaId,
    player: runtime.player, contacts: runtime.contacts, progress: runtime.progress, combat: runtime.combat,
    blocks: runtime.blocks, items: runtime.items,
    areas: [...runtime.areas.values()].map(area => ({ id: area.source.id, tiles: [...area.tiles.values()] })) });
}
export type RuntimeSnapshot = ReturnType<typeof snapshot>;
