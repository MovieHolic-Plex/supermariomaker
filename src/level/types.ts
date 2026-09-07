export const COURSE_LIMITS = {
  fileBytes: 32 * 1024 * 1024, areas: 16, tiles: 262144, objects: 4096,
  minWidth: 32, maxWidth: 4096, minHeight: 15, maxHeight: 128, grid: 16,
} as const;
export const THEMES = ["overworld", "underground", "underwater", "castle"] as const;
export const TILE_KINDS = ["ground", "brick", "question", "hidden", "used", "hard", "coin"] as const;
export const BLOCK_CONTENTS = ["none", "coin", "multiCoin", "powerup", "star", "oneUp", "vine"] as const;
export const OBJECT_KINDS = [
  "pipe", "platform", "spring", "flagGoal", "castleGoal", "goomba", "koopa", "paratroopa",
  "piranha", "buzzy", "billCannon", "hammerBro", "lakitu", "cheep", "blooper", "podoboo",
  "firebar", "bowser", "warpZone",
] as const;
export type Theme = typeof THEMES[number];
export type TileKind = typeof TILE_KINDS[number];
export type BlockContent = typeof BLOCK_CONTENTS[number];
export type ObjectKind = typeof OBJECT_KINDS[number];
export type EmptyProps = Readonly<Record<string, never>>;
export type TileCell = Readonly<{ x: number; y: number }> & (
  | Readonly<{ kind: "brick" | "question" | "hidden"; content?: BlockContent }>
  | Readonly<{ kind: "ground" | "used" | "hard" | "coin" }>
);
export type PipeDestination = Readonly<{ areaId: string; pipeId: string }>;
export type PipeProps = Readonly<{ height: number; entrance: "none" | "down" | "up"; destination?: PipeDestination }>;
export type PlatformProps = Readonly<{ length: number; travel: number; speed: 0.5 | 1 | 2 }> & (
  | Readonly<{ motion: "horizontal" | "vertical" | "falling" }>
  | Readonly<{ motion: "balance"; pairId?: string }>
);
export type Bridge = Readonly<{ x: number; y: number; width: number; height: 1 }>;
export type ObjectProps = {
  readonly pipe: PipeProps;
  readonly platform: PlatformProps;
  readonly spring: EmptyProps;
  readonly flagGoal: Readonly<{ height: number }>;
  readonly castleGoal: Readonly<{ bridge: Bridge; bowserId?: string }>;
  readonly goomba: EmptyProps;
  readonly koopa: Readonly<{ color: "green" | "red" }>;
  readonly paratroopa: Readonly<{ color: "green" | "red"; motion: "hop" | "vertical" }>;
  readonly piranha: Readonly<{ pipeId: string }>;
  readonly buzzy: EmptyProps;
  readonly billCannon: EmptyProps;
  readonly hammerBro: EmptyProps;
  readonly lakitu: EmptyProps;
  readonly cheep: Readonly<{ mode: "swim" | "leap"; color: "green" | "red" }>;
  readonly blooper: EmptyProps;
  readonly podoboo: EmptyProps;
  readonly firebar: Readonly<{ length: number; direction: "cw" | "ccw"; speed: "slow" | "normal" | "fast" }>;
  readonly bowser: EmptyProps;
  readonly warpZone: Readonly<{ pipeIds: readonly [string | null, string | null, string | null] }>;
};
/** All placed positions are bottom-center pixels; terrain and bridges use cells. */
export type PlacedObject = {
  [K in ObjectKind]: Readonly<{ id: string; kind: K; x: number; y: number; props: ObjectProps[K] }>
}[ObjectKind];
export type AreaV1 = Readonly<{
  id: string; name: string; theme: Theme; width: number; height: number;
  tiles: readonly TileCell[]; objects: readonly PlacedObject[];
}>;
export type CourseStart = Readonly<{ areaId: string; x: number; y: number }>;
export type CourseV1 = Readonly<{
  format: "smb1-maker"; version: 1; id: string; title: string; revision: number;
  mainAreaId: string; start: CourseStart; timerSeconds: number; areas: readonly AreaV1[];
}>;
export type ValidationCode =
  | "invalid_type" | "invalid_value" | "invalid_id" | "unknown_field" | "unknown_kind"
  | "unsupported_version" | "duplicate_id" | "duplicate_cell" | "out_of_bounds"
  | "limit_exceeded" | "invalid_reference" | "occupied_bridge" | "malformed_json"
  | "file_too_large" | "invalid_utf8" | "start_blocked" | "goal_required";
export type ValidationIssue = Readonly<{ code: ValidationCode; path: string; message: string }>;
export type ValidationResult<T> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; error: ValidationIssue }>;
export type PreviewOptions = Readonly<{ allowNoGoal?: boolean; spawnOverride?: CourseStart }>;
export type Bounds = Readonly<{ x: number; y: number; width: number; height: number }>;
