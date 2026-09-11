import type { CourseV1, PlacedObject, TileCell } from "../../src/level/types";
import { parseCourse, serializeCourse } from "../../src/level/serialize";
import { createNewCourseFixture, fixtureId, fixtureValue } from "./factory";

export const AREA_IDS = {
  main: fixtureId(2),
  dest: fixtureId(1300),
  blocked: fixtureId(1301),
  pipeMain: fixtureId(1310),
  pipeDest: fixtureId(1311),
  pipeBlocked: fixtureId(1312),
  pipeWarpA: fixtureId(1313),
  pipeWarpB: fixtureId(1314),
  pipeReturn: fixtureId(1315),
  pipeFar: fixtureId(1316),
  pipeFarDest: fixtureId(1317),
  goomba: fixtureId(1320),
  warp: fixtureId(1321),
  piranha: fixtureId(1322),
  piranhaFar: fixtureId(1323),
} as const;

function ground(width: number, height = 15): TileCell[] {
  return Array.from({ length: width * 2 }, (_, i) => ({ x: i % width, y: height - 2 + Math.floor(i / width), kind: "ground" }));
}

function roundTrip(course: CourseV1): CourseV1 {
  return fixtureValue(parseCourse(fixtureValue(serializeCourse(course))));
}

/** Reciprocal down-pipes, start standing on the main mouth, a far pipe exists for crop tests. */
export function createLinkedAreasFixture(): CourseV1 {
  const seed = createNewCourseFixture();
  const main = seed.areas[0];
  if (!main) throw new Error("main area missing");
  const destObjects: PlacedObject[] = [
    { id: AREA_IDS.pipeDest, kind: "pipe", x: 80, y: 208, props: { height: 3, entrance: "down", destination: { areaId: main.id, pipeId: AREA_IDS.pipeMain } } },
    { id: AREA_IDS.pipeReturn, kind: "pipe", x: 160, y: 208, props: { height: 3, entrance: "down", destination: { areaId: main.id, pipeId: AREA_IDS.pipeWarpA } } },
    { id: AREA_IDS.pipeFarDest, kind: "pipe", x: 240, y: 208, props: { height: 3, entrance: "down", destination: { areaId: main.id, pipeId: AREA_IDS.pipeFar } } },
  ];
  const dest = {
    id: AREA_IDS.dest, name: "지하", theme: "underground" as const, width: 32, height: 15,
    tiles: ground(32), objects: destObjects,
  };
  const mainObjects: PlacedObject[] = [
    ...main.objects,
    { id: AREA_IDS.pipeMain, kind: "pipe", x: 80, y: 208, props: { height: 3, entrance: "down", destination: { areaId: dest.id, pipeId: AREA_IDS.pipeDest } } },
    { id: AREA_IDS.piranha, kind: "piranha", x: 80, y: 160, props: { pipeId: AREA_IDS.pipeMain } },
    { id: AREA_IDS.pipeWarpA, kind: "pipe", x: 160, y: 208, props: { height: 3, entrance: "down", destination: { areaId: dest.id, pipeId: AREA_IDS.pipeReturn } } },
    { id: AREA_IDS.pipeWarpB, kind: "pipe", x: 224, y: 208, props: { height: 3, entrance: "none" } },
    { id: AREA_IDS.pipeFar, kind: "pipe", x: 640, y: 208, props: { height: 3, entrance: "down", destination: { areaId: dest.id, pipeId: AREA_IDS.pipeFarDest } } },
    { id: AREA_IDS.piranhaFar, kind: "piranha", x: 640, y: 160, props: { pipeId: AREA_IDS.pipeFar } },
    { id: AREA_IDS.goomba, kind: "goomba", x: 320, y: 208, props: {} },
    { id: AREA_IDS.warp, kind: "warpZone", x: 160, y: 144, props: { pipeIds: [AREA_IDS.pipeMain, AREA_IDS.pipeFar, null] } },
  ];
  return roundTrip({
    ...seed, title: "Areas: linked", start: { areaId: main.id, x: 80, y: 160 },
    areas: [{ ...main, objects: mainObjects }, dest],
  });
}

/** Destination mouth is occupied, so entry must be rejected without moving the player. */
export function createBlockedExitFixture(): CourseV1 {
  const seed = createNewCourseFixture();
  const main = seed.areas[0];
  if (!main) throw new Error("main area missing");
  const blocked: TileCell[] = [
    { x: 4, y: 9, kind: "hard" }, { x: 5, y: 9, kind: "hard" },
  ];
  const dest = {
    id: AREA_IDS.blocked, name: "막힘", theme: "castle" as const, width: 32, height: 15,
    tiles: [...ground(32), ...blocked],
    objects: [
      { id: AREA_IDS.pipeBlocked, kind: "pipe" as const, x: 80, y: 208, props: { height: 3, entrance: "down" as const, destination: { areaId: main.id, pipeId: AREA_IDS.pipeMain } } },
    ],
  };
  return roundTrip({
    ...seed, title: "Areas: blocked-exit", start: { areaId: main.id, x: 80, y: 160 },
    areas: [{
      ...main,
      objects: [
        ...main.objects,
        { id: AREA_IDS.pipeMain, kind: "pipe", x: 80, y: 208, props: { height: 3, entrance: "down", destination: { areaId: dest.id, pipeId: AREA_IDS.pipeBlocked } } },
      ],
    }, dest],
  });
}

export type AreasPlayCase = "linked" | "blocked";

export function createAreasPlayFixture(which: AreasPlayCase): CourseV1 {
  return which === "blocked" ? createBlockedExitFixture() : createLinkedAreasFixture();
}
