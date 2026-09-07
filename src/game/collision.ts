import type { Bounds, TileCell } from "../level/types";
import { objectBounds } from "../level/validate";
import { PHYSICS } from "./physics";
import type { PlayerState, RuntimeArea } from "./state";

export type ContactSource =
  | Readonly<{ kind: "tile"; x: number; y: number; tile: TileCell }>
  | Readonly<{ kind: "object"; objectId: string; part: "body" | "bridge" }>
  | Readonly<{ kind: "boundary"; side: "left" | "right" | "top" }>;
export interface Collider extends Bounds {
  readonly id: string;
  readonly source: ContactSource;
  readonly belowOnly?: boolean;
}
export interface Contact {
  readonly id: string; readonly source: ContactSource;
  readonly axis: "x" | "y";
  /** Normal points away from the obstacle; time is fraction of requested axis displacement. */
  readonly normal: -1 | 1; readonly time: number;
}
export function playerBounds(player: PlayerState, height = player.form === "small" || player.crouched ? PHYSICS.smallHeight : PHYSICS.tallHeight): Bounds {
  return { x: player.x - PHYSICS.width / 2, y: player.y - height, width: PHYSICS.width, height };
}
export const overlaps = (a: Bounds, b: Bounds): boolean => a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;

/** Sparse tile broadphase over the entire sweep, not just the destination. No dense area allocation. */
export function colliders(area: RuntimeArea, region: Bounds): Collider[] {
  const result: Collider[] = [], { source } = area;
  for (let y = Math.max(0, Math.floor(region.y / 16)); y <= Math.min(source.height - 1, Math.floor((region.y + region.height) / 16)); y++) {
    for (let x = Math.max(0, Math.floor(region.x / 16)); x <= Math.min(source.width - 1, Math.floor((region.x + region.width) / 16)); x++) {
      const tile = area.tiles.get(y * source.width + x);
      if (!tile || tile.kind === "coin") continue;
      result.push({ id: `${source.id}:tile:${y}:${x}`, x: x * 16, y: y * 16, width: 16, height: 16,
        source: { kind: "tile", x, y, tile: { ...tile } }, ...(tile.kind === "hidden" ? { belowOnly: true } : {}) });
    }
  }
  // Static bodies only here. Moving platforms/actors will contribute their own movement phase in task 9/8.
  for (const object of source.objects) {
    switch (object.kind) {
      case "pipe": case "platform": case "spring": case "billCannon": case "firebar":
        result.push({ id: object.id, ...objectBounds(object), source: { kind: "object", objectId: object.id, part: "body" } }); break;
      case "castleGoal": {
        const bridge = object.props.bridge;
        result.push({ id: `${object.id}:bridge`, x: bridge.x * 16, y: bridge.y * 16, width: bridge.width * 16, height: 16,
          source: { kind: "object", objectId: object.id, part: "bridge" } }); break;
      }
      default: break;
    }
  }
  // No bottom floor: falling into a pit stays a fall; death/lives belong to task 14.
  result.push(
    { id: `${source.id}:boundary:left`, x: -16, y: Math.min(region.y, 0), width: 16, height: Math.max(region.height, source.height * 16) + Math.abs(region.y), source: { kind: "boundary", side: "left" } },
    { id: `${source.id}:boundary:right`, x: source.width * 16, y: Math.min(region.y, 0), width: 16, height: Math.max(region.height, source.height * 16) + Math.abs(region.y), source: { kind: "boundary", side: "right" } },
    { id: `${source.id}:boundary:top`, x: 0, y: -16, width: source.width * 16, height: 16, source: { kind: "boundary", side: "top" } },
  );
  return result;
}
export function hasSolidOverlap(area: RuntimeArea, bounds: Bounds): boolean {
  return colliders(area, bounds).some(collider => !collider.belowOnly && overlaps(bounds, collider));
}
export function sweepAxis(area: RuntimeArea, bounds: Bounds, delta: number, axis: "x" | "y"): { distance: number; contacts: Contact[] } {
  if (delta === 0) return { distance: 0, contacts: [] };
  const region = { ...bounds, [axis]: bounds[axis] + Math.min(delta, 0),
    [axis === "x" ? "width" : "height"]: bounds[axis === "x" ? "width" : "height"] + Math.abs(delta) };
  const other = axis === "x" ? "y" : "x", size = axis === "x" ? "width" : "height", otherSize = axis === "x" ? "height" : "width";
  let distance = delta;
  let contacts: Contact[] = [];
  for (const collider of colliders(area, region)) {
    if (collider.belowOnly && (axis !== "y" || delta >= 0)) continue;
    if (bounds[other] >= collider[other] + collider[otherSize] || bounds[other] + bounds[otherSize] <= collider[other]) continue;
    const gap = delta > 0 ? collider[axis] - (bounds[axis] + bounds[size]) : collider[axis] + collider[size] - bounds[axis];
    if (delta > 0 ? gap < 0 || gap > distance : gap > 0 || gap < distance) continue;
    const contact: Contact = { id: collider.id, source: collider.source, axis, normal: delta > 0 ? -1 : 1, time: gap / delta };
    if (gap !== distance) contacts = [];
    distance = gap; contacts.push(contact);
  }
  contacts.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  return { distance, contacts };
}
