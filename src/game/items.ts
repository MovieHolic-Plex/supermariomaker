import type { Bounds } from "../level/types";
import { hasSolidOverlap, overlaps, playerBounds, sweepAxis } from "./collision";
import { snapPosition } from "./physics";
import { awardScore, grantLife, growPlayer } from "./player";
import { currentArea } from "./state";
import type { GameEvent, Runtime } from "./state";

export type ItemKind = "mushroom" | "flower" | "star" | "oneUp" | "vine" | "fireball";
/** Bottom-center coordinates. Vine y is the base; height is its current grown extent. */
export interface ItemActor {
  id: string; areaId: string; sourceId: string; kind: ItemKind; bornTick: number;
  x: number; y: number; vx: number; vy: number; age: number; emerging: number;
  height: number; targetHeight: number;
}
export interface ItemState { actors: ItemActor[]; pending: ItemActor[]; nextId: number }
export type ItemEvent =
  | Readonly<{ type: "itemSpawn"; tick: number; id: string; kind: ItemKind; sourceId: string }>
  | Readonly<{ type: "itemCollect"; tick: number; id: string; kind: "mushroom" | "flower" | "star" | "oneUp" }>
  | Readonly<{ type: "itemDespawn"; tick: number; id: string; reason: "terrain" | "expired" | "outside" | "combat" }>
  | Readonly<{ type: "fire"; tick: number; id: string }>
  | Readonly<{ type: "fireballBounce" | "vineGrown"; tick: number; id: string }>;
export function itemBounds(item: ItemActor): Bounds {
  const size = item.kind === "fireball" ? 8 : item.kind === "vine" ? 8 : 14;
  return { x: item.x - size / 2, y: item.y - (item.kind === "vine" ? item.height : size), width: size, height: item.kind === "vine" ? item.height : size };
}
export function queueItem(runtime: Runtime, kind: ItemKind, x: number, y: number, sourceId: string): ItemActor {
  const id = `item:${String(runtime.items.nextId++).padStart(10, "0")}`;
  const actor: ItemActor = { id, areaId: runtime.areaId, sourceId, kind, bornTick: runtime.tick,
    x, y, vx: kind === "fireball" ? runtime.player.facing * 3 : kind === "flower" || kind === "vine" ? 0 : 0.6,
    vy: kind === "fireball" ? -1 : 0, age: 0, emerging: kind === "fireball" || kind === "vine" ? 0 : 16,
    height: 0, targetHeight: 0 };
  if (kind === "vine") {
    actor.y -= 16;
    const area = currentArea(runtime);
    for (let height = 1; height <= 96; height++) {
      if (hasSolidOverlap(area, { x: x - 4, y: actor.y - height, width: 8, height: 1 })) break;
      actor.targetHeight = height;
    }
  }
  runtime.items.pending.push(actor); return actor;
}
export function firePlayer(runtime: Runtime, events: GameEvent[]): void {
  if (runtime.player.form !== "fire" || runtime.combat.defeated) return;
  if ([...runtime.items.actors, ...runtime.items.pending].filter(item => item.kind === "fireball").length >= 2) return;
  const player = runtime.player, bounds = playerBounds(player);
  const actor = queueItem(runtime, "fireball", player.x + player.facing * 10, bounds.y + 12, "player");
  events.push({ type: "fire", tick: runtime.tick, id: actor.id });
}
/** Typed combat seam: enemies can consume a projectile without bypassing player scoring/damage. */
export function removeItem(runtime: Runtime, id: string, reason: "terrain" | "expired" | "outside" | "combat", events: GameEvent[]): void {
  const index = runtime.items.actors.findIndex(item => item.id === id);
  if (index < 0) return;
  runtime.items.actors.splice(index, 1); events.push({ type: "itemDespawn", tick: runtime.tick, id, reason });
}
export function updateItems(runtime: Runtime, events: GameEvent[]): void {
  const area = currentArea(runtime);
  for (const actor of [...runtime.items.actors].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)) {
    if (actor.areaId !== runtime.areaId || actor.bornTick >= runtime.tick) continue;
    actor.age++;
    if (actor.kind === "vine") {
      if (actor.height < actor.targetHeight) {
        actor.height++; if (actor.height === actor.targetHeight) events.push({ type: "vineGrown", tick: runtime.tick, id: actor.id });
      }
      continue;
    }
    if (actor.emerging > 0) { actor.y = snapPosition(actor.y - 1); actor.emerging--; continue; }
    if (actor.kind === "flower") continue;
    if (actor.kind === "fireball" && actor.age >= 180) { removeItem(runtime, actor.id, "expired", events); continue; }
    // Emerging pickups intentionally pass through their source block; active actors never do.
    if (hasSolidOverlap(area, itemBounds(actor)) && actor.kind === "fireball") { removeItem(runtime, actor.id, "terrain", events); continue; }
    actor.vy = Math.min(6, actor.vy + (actor.kind === "fireball" || actor.kind === "star" ? 0.2 : 0.42));
    const x = sweepAxis(area, itemBounds(actor), actor.vx, "x"); actor.x = snapPosition(actor.x + x.distance);
    if (x.contacts.length) {
      if (actor.kind === "fireball") { removeItem(runtime, actor.id, "terrain", events); continue; }
      actor.vx = -actor.vx;
    }
    const y = sweepAxis(area, itemBounds(actor), actor.vy, "y"); actor.y = snapPosition(actor.y + y.distance);
    if (y.contacts.length) {
      const floor = y.contacts.some(contact => contact.normal === -1);
      actor.vy = floor && actor.kind === "fireball" ? -2.5 : floor && actor.kind === "star" ? -3.4 : 0;
      if (floor && actor.kind === "fireball") events.push({ type: "fireballBounce", tick: runtime.tick, id: actor.id });
      if (!floor && actor.kind === "fireball") { removeItem(runtime, actor.id, "terrain", events); continue; }
    }
    const cameraX = Math.max(0, Math.min(area.source.width * 16 - 256, runtime.player.x - 128));
    const cameraY = Math.max(0, Math.min(area.source.height * 16 - 240, runtime.player.y - 160));
    if (actor.y > area.source.height * 16 + 16 || actor.x < 0 || actor.x > area.source.width * 16 || (actor.kind === "fireball"
      && (actor.x < cameraX - 256 || actor.x > cameraX + 512 || actor.y < cameraY - 256 || actor.y > cameraY + 496))) removeItem(runtime, actor.id, "outside", events);
  }
}
export function collectItems(runtime: Runtime, events: GameEvent[]): void {
  if (runtime.combat.defeated) return;
  for (const actor of [...runtime.items.actors].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)) {
    if (actor.areaId !== runtime.areaId || actor.bornTick >= runtime.tick || actor.emerging > 0 || actor.kind === "vine" || actor.kind === "fireball" || !overlaps(playerBounds(runtime.player), itemBounds(actor))) continue;
    switch (actor.kind) {
      case "mushroom": if (runtime.player.form === "small") growPlayer(runtime, "super", actor.id, events); awardScore(runtime, "powerup", events); break;
      case "flower": growPlayer(runtime, "fire", actor.id, events); awardScore(runtime, "powerup", events); break;
      case "star": runtime.combat.starTicks = 600; awardScore(runtime, "powerup", events); events.push({ type: "starStart", tick: runtime.tick }); break;
      case "oneUp": grantLife(runtime, "item", events); break;
    }
    runtime.items.actors = runtime.items.actors.filter(item => item.id !== actor.id);
    events.push({ type: "itemCollect", tick: runtime.tick, id: actor.id, kind: actor.kind });
  }
}
export function commitItems(runtime: Runtime, events: GameEvent[]): void {
  for (const actor of runtime.items.pending) {
    runtime.items.actors.push(actor); events.push({ type: "itemSpawn", tick: runtime.tick, id: actor.id, kind: actor.kind, sourceId: actor.sourceId });
  }
  runtime.items.pending = [];
}
