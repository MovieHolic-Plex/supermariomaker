import type { AreaV1, CourseStart, CourseV1, TileCell } from "../level/types";
import { validatePreview } from "../level/validate";
import { PHYSICS } from "./physics";
import { playerBounds, sweepAxis } from "./collision";
import type { Contact } from "./collision";
import type { BlockEvent, BlockState } from "./blocks";
import type { ItemEvent, ItemState } from "./items";
import type { CombatState, ProgressEvent, ProgressState } from "./player";
import { createGroundState } from "./enemies-ground";
import type { GroundEvent, GroundState } from "./enemies-ground";
import { createClimbState } from "./climb";
import type { ClimbEvent, ClimbState } from "./climb";
import { createPlatformState } from "./platforms";
import type { PlatformEvent, PlatformFeatureState } from "./platforms";

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
  platforms: PlatformFeatureState;
}
export interface Runtime {
  readonly course: CourseV1;
  readonly areas: Map<string, RuntimeArea>;
  areaId: string;
  /** Last area whose platform/climb features were processed; not authored state. */
  featureAreaId: string;
  tick: number;
  seed: number;
  player: PlayerState;
  contacts: Contact[];
  climb: ClimbState;
  progress: ProgressState;
  combat: CombatState;
  blocks: BlockState;
  items: ItemState;
  ground: GroundState;
}
export type GameEvent =
  | Readonly<{ type: "jump"; tick: number }>
  | Readonly<{ type: "contact"; tick: number; contact: Contact }>
  | BlockEvent | ItemEvent | ProgressEvent | GroundEvent | PlatformEvent | ClimbEvent;

/** Validates the spawn at this boundary. Goal-free permission belongs to the host's explicit action. */
export function createRuntime(course: CourseV1, spawnOverride?: CourseStart): Runtime {
  const checked = validatePreview(course, { allowNoGoal: true, ...(spawnOverride ? { spawnOverride } : {}) });
  if (!checked.ok) throw new Error(`${checked.error.code}: ${checked.error.message}`);
  const copy = structuredClone(course), start = checked.value;
  const runtime: Runtime = {
    course: copy, areas: new Map(copy.areas.map(source => {
      const area: RuntimeArea = { source, tiles: new Map(source.tiles.map(tile => [tile.y * source.width + tile.x, { ...tile }])),
        platforms: { areaId: source.id, bodies: [] } };
      area.platforms = createPlatformState(area);
      return [source.id, area];
    })),
    areaId: start.areaId, featureAreaId: start.areaId, tick: 0, seed: 0x534d4231,
    progress: { lives: 3, coins: 0, score: 0 }, combat: { starTicks: 0, invulnerabilityTicks: 0, defeated: false },
    blocks: { multiCoins: {}, pending: [] }, items: { actors: [], pending: [], nextId: 1 },
    ground: { actors: new Map(), stompChain: 0 }, climb: createClimbState(),
    player: { x: start.x, y: start.y, vx: 0, vy: 0, form: "small", crouched: false, grounded: false, facing: 1, skidding: false, risingTicks: 0 }, contacts: [],
  };
  const support = sweepAxis(currentArea(runtime), playerBounds(runtime.player), 1 / PHYSICS.snap, "y");
  runtime.player.grounded = support.distance === 0 && support.contacts.length > 0;
  runtime.contacts = support.contacts;
  runtime.ground = createGroundState(runtime);
  return runtime;
}
export function currentArea(runtime: Runtime): RuntimeArea {
  const area = runtime.areas.get(runtime.areaId);
  if (!area) throw new Error(`Runtime area missing: ${runtime.areaId}`);
  return area;
}
/** The same logical viewport drives activation and presentation; no renderer/DOM dependency. */
export function runtimeViewport(runtime: Runtime) {
  const area = currentArea(runtime);
  return {
    x: Math.round(Math.max(0, Math.min(area.source.width * 16 - 256, runtime.player.x - 128))),
    y: Math.round(Math.max(0, Math.min(area.source.height * 16 - 240, runtime.player.y - 160))),
    width: 256, height: 240,
  };
}
/** Detached observation. No Maps, DOM objects, live references, setters or authoring writers. */
export function snapshot(runtime: Runtime) {
  return structuredClone({ tick: runtime.tick, seed: runtime.seed, areaId: runtime.areaId,
    player: runtime.player, contacts: runtime.contacts, climb: runtime.climb, platforms: currentArea(runtime).platforms,
    progress: runtime.progress, combat: runtime.combat, blocks: runtime.blocks, items: runtime.items,
    ground: { actors: [...runtime.ground.actors.values()], stompChain: runtime.ground.stompChain },
    areas: [...runtime.areas.values()].map(area => ({ id: area.source.id, tiles: [...area.tiles.values()], platforms: area.platforms })) });
}
export type RuntimeSnapshot = ReturnType<typeof snapshot>;
