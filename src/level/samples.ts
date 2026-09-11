import { THEMES } from "./types";
import type { AreaV1, CourseV1, PlacedObject, Theme, TileCell } from "./types";
import { validateCourse } from "./validate";

const WIDTH = 48;
const HEIGHT = 15;

function id(index: number): string {
  return `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
}

function checked(input: CourseV1): CourseV1 {
  const result = validateCourse(input);
  if (!result.ok) throw new Error(`${result.error.code} at ${result.error.path}: ${result.error.message}`);
  return result.value;
}

function floor(kind: "ground" | "hard", skip = new Set<number>(), width = WIDTH): TileCell[] {
  const tiles: TileCell[] = [];
  for (const y of [13, 14]) {
    for (let x = 0; x < width; x++) if (!skip.has(x)) tiles.push({ x, y, kind });
  }
  return tiles;
}

function cage(x0: number, yFloor: number, span: number): TileCell[] {
  const tiles: TileCell[] = [];
  for (let x = x0; x < x0 + span; x++) tiles.push({ x, y: yFloor, kind: "hard" });
  for (const x of [x0 - 1, x0 + span]) {
    tiles.push({ x, y: yFloor - 1, kind: "hard" });
    tiles.push({ x, y: yFloor - 2, kind: "hard" });
  }
  return tiles;
}

function area(fields: Omit<AreaV1, "width" | "height"> & { width?: number; height?: number }): AreaV1 {
  return { width: WIDTH, height: HEIGHT, ...fields };
}

function overworld(): CourseV1 {
  const courseId = id(0x2100), mainId = id(0x2101), galleryId = id(0x2102);
  const flagId = id(0x2103), springId = id(0x2104);
  const pipeMain = id(0x2105), pipeGallery = id(0x2106);
  const platformH = id(0x2107), platformV = id(0x2108), platformFall = id(0x2109);
  const balanceA = id(0x210a), balanceB = id(0x210b);
  const goombaId = id(0x210c), koopaGreen = id(0x210d), koopaRed = id(0x210e);
  const paraHop = id(0x210f), paraVert = id(0x2110);
  const warpId = id(0x2111), warpPipeA = id(0x2112), warpPipeB = id(0x2113), warpPipeC = id(0x2114);
  const tiles: TileCell[] = [
    ...floor("ground"),
    { x: 8, y: 11, kind: "coin" }, { x: 9, y: 11, kind: "coin" }, { x: 10, y: 11, kind: "coin" },
    { x: 12, y: 9, kind: "brick", content: "none" },
    { x: 13, y: 9, kind: "brick", content: "multiCoin" },
    { x: 14, y: 9, kind: "brick", content: "vine" },
    { x: 15, y: 9, kind: "question", content: "coin" },
    { x: 16, y: 9, kind: "question", content: "powerup" },
    { x: 17, y: 9, kind: "question", content: "star" },
    { x: 18, y: 9, kind: "question", content: "oneUp" },
    { x: 19, y: 8, kind: "hidden", content: "coin" },
    { x: 20, y: 9, kind: "used" },
    { x: 21, y: 9, kind: "hard" },
    ...cage(4, 6, 4),
    ...cage(10, 6, 4),
    ...cage(24, 6, 4),
  ];
  const objects: PlacedObject[] = [
    { id: flagId, kind: "flagGoal", x: 560, y: 208, props: { height: 9 } },
    { id: springId, kind: "spring", x: 672, y: 208, props: {} },
    { id: platformH, kind: "platform", x: 160, y: 48, props: { motion: "horizontal", length: 3, travel: 4, speed: 1 } },
    { id: platformV, kind: "platform", x: 256, y: 48, props: { motion: "vertical", length: 3, travel: 3, speed: 0.5 } },
    { id: platformFall, kind: "platform", x: 320, y: 48, props: { motion: "falling", length: 3, travel: 8, speed: 1 } },
    { id: balanceA, kind: "platform", x: 80, y: 32, props: { motion: "balance", length: 3, travel: 2, speed: 1, pairId: balanceB } },
    { id: balanceB, kind: "platform", x: 144, y: 32, props: { motion: "balance", length: 3, travel: 2, speed: 1, pairId: balanceA } },
    { id: pipeMain, kind: "pipe", x: 432, y: 160, props: { height: 3, entrance: "down", destination: { areaId: galleryId, pipeId: pipeGallery } } },
    { id: goombaId, kind: "goomba", x: 416, y: 96, props: {} },
    { id: koopaGreen, kind: "koopa", x: 192, y: 96, props: { color: "green" } },
    { id: koopaRed, kind: "koopa", x: 80, y: 96, props: { color: "red" } },
    { id: paraHop, kind: "paratroopa", x: 208, y: 96, props: { color: "green", motion: "hop" } },
    { id: paraVert, kind: "paratroopa", x: 32, y: 64, props: { color: "red", motion: "vertical" } },
  ];
  const galleryObjects: PlacedObject[] = [
    { id: pipeGallery, kind: "pipe", x: 16, y: 208, props: { height: 3, entrance: "down", destination: { areaId: mainId, pipeId: pipeMain } } },
    { id: warpPipeA, kind: "pipe", x: 80, y: 208, props: { height: 3, entrance: "none" } },
    { id: warpPipeB, kind: "pipe", x: 160, y: 208, props: { height: 3, entrance: "none" } },
    { id: warpPipeC, kind: "pipe", x: 240, y: 208, props: { height: 3, entrance: "none" } },
    { id: warpId, kind: "warpZone", x: 160, y: 144, props: { pipeIds: [warpPipeA, warpPipeB, warpPipeC] } },
  ];
  return checked({
    format: "smb1-maker", version: 1, id: courseId, title: "솔바람 능선", revision: 0,
    mainAreaId: mainId, start: { areaId: mainId, x: 40, y: 208 }, timerSeconds: 400,
    areas: [
      area({ id: mainId, name: "능선", theme: "overworld", tiles, objects }),
      area({ id: galleryId, name: "워프 골목", theme: "overworld", width: 32, tiles: floor("ground", new Set(), 32), objects: galleryObjects }),
    ],
  });
}

function underground(): CourseV1 {
  const courseId = id(0x2200), mainId = id(0x2201), galleryId = id(0x2202);
  const flagId = id(0x2203), pipeMain = id(0x2204), pipeGallery = id(0x2205), piranhaId = id(0x2206);
  const buzzyId = id(0x2207), cannonId = id(0x2208), lakituId = id(0x2209);
  const tiles: TileCell[] = [
    ...floor("ground"),
    { x: 5, y: 9, kind: "hard" },
    { x: 6, y: 9, kind: "used" },
    { x: 7, y: 8, kind: "hidden", content: "star" },
    { x: 8, y: 11, kind: "coin" },
    { x: 9, y: 9, kind: "brick", content: "oneUp" },
    ...cage(16, 6, 4),
    ...cage(22, 6, 3),
  ];
  const objects: PlacedObject[] = [
    { id: flagId, kind: "flagGoal", x: 560, y: 208, props: { height: 8 } },
    { id: pipeMain, kind: "pipe", x: 400, y: 160, props: { height: 3, entrance: "down", destination: { areaId: galleryId, pipeId: pipeGallery } } },
    { id: piranhaId, kind: "piranha", x: 400, y: 112, props: { pipeId: pipeMain } },
    { id: buzzyId, kind: "buzzy", x: 288, y: 96, props: {} },
    { id: cannonId, kind: "billCannon", x: 368, y: 96, props: {} },
  ];
  return checked({
    format: "smb1-maker", version: 1, id: courseId, title: "등잔 굴", revision: 0,
    mainAreaId: mainId, start: { areaId: mainId, x: 40, y: 208 }, timerSeconds: 400,
    areas: [
      area({ id: mainId, name: "굴", theme: "underground", tiles, objects }),
      area({
        id: galleryId, name: "구름 틈", theme: "underground", width: 32, tiles: floor("ground", new Set(), 32),
        objects: [
          { id: pipeGallery, kind: "pipe", x: 16, y: 208, props: { height: 3, entrance: "down", destination: { areaId: mainId, pipeId: pipeMain } } },
          { id: lakituId, kind: "lakitu", x: 160, y: 96, props: {} },
        ],
      }),
    ],
  });
}

function underwater(): CourseV1 {
  const courseId = id(0x2300), mainId = id(0x2301), galleryId = id(0x2302);
  const flagId = id(0x2303), pipeMain = id(0x2304), pipeGallery = id(0x2305);
  const cheepRed = id(0x2306), cheepGreen = id(0x2307), cheepLeap = id(0x2308), blooperId = id(0x2309);
  const tiles: TileCell[] = [
    ...floor("ground"),
    { x: 10, y: 11, kind: "coin" }, { x: 11, y: 11, kind: "coin" }, { x: 12, y: 10, kind: "coin" },
    { x: 22, y: 9, kind: "hard" },
  ];
  const objects: PlacedObject[] = [
    { id: flagId, kind: "flagGoal", x: 560, y: 208, props: { height: 6 } },
    { id: pipeMain, kind: "pipe", x: 432, y: 160, props: { height: 3, entrance: "down", destination: { areaId: galleryId, pipeId: pipeGallery } } },
    { id: cheepRed, kind: "cheep", x: 704, y: 96, props: { color: "red", mode: "swim" } },
    { id: cheepGreen, kind: "cheep", x: 720, y: 128, props: { color: "green", mode: "swim" } },
    { id: cheepLeap, kind: "cheep", x: 16, y: 208, props: { color: "red", mode: "leap" } },
  ];
  return checked({
    format: "smb1-maker", version: 1, id: courseId, title: "청파 수로", revision: 0,
    mainAreaId: mainId, start: { areaId: mainId, x: 80, y: 208 }, timerSeconds: 400,
    areas: [
      area({ id: mainId, name: "수로", theme: "underwater", tiles, objects }),
      area({
        id: galleryId, name: "먹물 방", theme: "underwater", width: 32, tiles: floor("ground", new Set(), 32),
        objects: [
          { id: pipeGallery, kind: "pipe", x: 16, y: 208, props: { height: 3, entrance: "down", destination: { areaId: mainId, pipeId: pipeMain } } },
          { id: blooperId, kind: "blooper", x: 160, y: 128, props: {} },
        ],
      }),
    ],
  });
}

function castle(): CourseV1 {
  const courseId = id(0x2400), mainId = id(0x2401), galleryId = id(0x2402);
  const axeId = id(0x2403), bowserId = id(0x2404), firebarId = id(0x2405), podobooId = id(0x2406);
  const pipeMain = id(0x2407), pipeGallery = id(0x2408), hammerId = id(0x2409);
  const pit = new Set([32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43]);
  const tiles: TileCell[] = [
    ...floor("ground", pit),
    { x: 8, y: 9, kind: "hard" },
    { x: 9, y: 9, kind: "used" },
    ...cage(32, 6, 6),
  ];
  const objects: PlacedObject[] = [
    { id: bowserId, kind: "bowser", x: 560, y: 96, props: {} },
    {
      id: axeId, kind: "castleGoal", x: 704, y: 208,
      props: { bridge: { x: 32, y: 13, width: 12, height: 1 }, bowserId },
    },
    { id: firebarId, kind: "firebar", x: 192, y: 64, props: { length: 3, direction: "cw", speed: "slow" } },
    { id: podobooId, kind: "podoboo", x: 16, y: 240, props: {} },
    { id: pipeMain, kind: "pipe", x: 480, y: 160, props: { height: 3, entrance: "down", destination: { areaId: galleryId, pipeId: pipeGallery } } },
  ];
  return checked({
    format: "smb1-maker", version: 1, id: courseId, title: "불씨 성", revision: 0,
    mainAreaId: mainId, start: { areaId: mainId, x: 80, y: 208 }, timerSeconds: 400,
    areas: [
      area({ id: mainId, name: "성", theme: "castle", tiles, objects }),
      area({
        id: galleryId, name: "해머 방", theme: "castle", width: 32, tiles: floor("ground", new Set(), 32),
        objects: [
          { id: pipeGallery, kind: "pipe", x: 16, y: 208, props: { height: 3, entrance: "down", destination: { areaId: mainId, pipeId: pipeMain } } },
          { id: hammerId, kind: "hammerBro", x: 160, y: 208, props: {} },
        ],
      }),
    ],
  });
}

const BUILDERS: Record<Theme, () => CourseV1> = {
  overworld, underground, underwater, castle,
};

export function sampleCourse(theme: Theme): CourseV1 {
  return BUILDERS[theme]();
}

export function sampleCourses(): CourseV1[] {
  return THEMES.map((theme) => sampleCourse(theme));
}
