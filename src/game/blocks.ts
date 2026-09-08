import type { TileCell } from "../level/types";
import { overlaps, playerBounds } from "./collision";
import { queueItem } from "./items";
import { awardScore, collectCoin } from "./player";
import { currentArea } from "./state";
import type { GameEvent, Runtime } from "./state";

export interface BlockChange { id: string; areaId: string; key: number; tile: TileCell | null }
export interface BlockState { multiCoins: Record<string, number>; pending: BlockChange[] }
export type BlockEvent = Readonly<{ type: "blockBump" | "blockBreak" | "blockReveal" | "blockUsed"; tick: number; id: string; x: number; y: number }>;

/** Contacts are swept and stable-ID sorted by collision.ts; mutations wait until all interactions finish. */
export function interactBlocks(runtime: Runtime, events: GameEvent[]): void {
  const area = currentArea(runtime), blocks = runtime.blocks;
  const queue = (id: string, key: number, tile: TileCell | null) => blocks.pending.push({ id, areaId: runtime.areaId, key, tile });
  for (const contact of runtime.contacts) {
    if (contact.axis !== "y" || contact.normal !== 1 || contact.source.kind !== "tile") continue;
    const { x, y, tile } = contact.source, { id } = contact;
    if (tile.kind !== "brick" && tile.kind !== "question" && tile.kind !== "hidden") continue;
    const emit = (type: BlockEvent["type"]) => events.push({ type, tick: runtime.tick, id, x, y });
    const key = y * area.source.width + x, content = tile.content ?? "none";
    emit("blockBump");
    if (tile.kind === "hidden") emit("blockReveal");
    if (content === "none" && tile.kind === "brick") {
      if (runtime.player.form !== "small") { queue(id, key, null); awardScore(runtime, "block", events); emit("blockBreak"); }
      continue;
    }
    let replacement: TileCell = { x, y, kind: "used" };
    switch (content) {
      case "none": break;
      case "coin": collectCoin(runtime, id, events); break;
      case "multiCoin": {
        const remaining = (blocks.multiCoins[id] ?? 10) - 1; blocks.multiCoins[id] = remaining;
        collectCoin(runtime, id, events);
        if (remaining > 0) replacement = { x, y, kind: tile.kind === "hidden" ? "brick" : tile.kind, content };
        break;
      }
      case "powerup": queueItem(runtime, runtime.player.form === "small" ? "mushroom" : "flower", x * 16 + 8, y * 16 + 16, id); break;
      case "star": case "oneUp": case "vine": queueItem(runtime, content, x * 16 + 8, y * 16 + 16, id); break;
    }
    queue(id, key, replacement);
    if (replacement.kind === "used") emit("blockUsed");
  }
  const bounds = playerBounds(runtime.player);
  for (let y = Math.max(0, Math.floor(bounds.y / 16)); y <= Math.min(area.source.height - 1, Math.floor((bounds.y + bounds.height) / 16)); y++) {
    for (let x = Math.max(0, Math.floor(bounds.x / 16)); x <= Math.min(area.source.width - 1, Math.floor((bounds.x + bounds.width) / 16)); x++) {
      const key = y * area.source.width + x, tile = area.tiles.get(key);
      if (tile?.kind !== "coin" || !overlaps(bounds, { x: x * 16, y: y * 16, width: 16, height: 16 })) continue;
      const id = `${area.source.id}:tile:${y}:${x}`;
      queue(id, key, null); collectCoin(runtime, id, events);
    }
  }
}
export function commitBlocks(runtime: Runtime): void {
  runtime.blocks.pending.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  for (const change of runtime.blocks.pending) {
    const area = runtime.areas.get(change.areaId);
    if (!area) throw new Error(`Queued block area missing: ${change.areaId}`);
    if (change.tile) area.tiles.set(change.key, change.tile); else area.tiles.delete(change.key);
  }
  runtime.blocks.pending = [];
}
