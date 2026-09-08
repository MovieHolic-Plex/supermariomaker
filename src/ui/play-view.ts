import { frameAt } from "../assets/manifest";
import type { AssetKey } from "../assets/manifest";
import { currentArea } from "../game/state";
import type { Runtime } from "../game/state";
import { canvasContext, drawSprite } from "../render/assets";
import { drawPole, GAME_VIEWPORT, renderScene } from "../render/renderer";
import { previewSprites } from "./course-preview";

/** Presentation derives only from authoritative state. It never feeds positions back to simulation. */
export function playView(runtime: Runtime) {
  const area = currentArea(runtime), player = runtime.player;
  const camera = {
    x: Math.round(Math.max(0, Math.min(area.source.width * 16 - GAME_VIEWPORT.width, player.x - 128))),
    y: Math.round(Math.max(0, Math.min(area.source.height * 16 - GAME_VIEWPORT.height, player.y - 160))),
  };
  let key: AssetKey;
  if (player.crouched && player.form !== "small") key = `mario.${player.form}.crouch`;
  else if (!player.grounded) key = `mario.${player.form}.jump`;
  else if (player.skidding) key = `mario.${player.form}.skid`;
  else if (player.vx !== 0) key = frameAt(`mario.${player.form}.run`, runtime.tick, 6);
  else key = `mario.${player.form}.idle`;
  return { camera, theme: area.source.theme, player: { key, x: player.x, y: player.y, flipX: player.facing === -1 } };
}
export function renderPlay(canvas: HTMLCanvasElement, runtime: Runtime): void {
  const area = currentArea(runtime), view = playView(runtime);
  renderScene(canvas, { ...view, sprites: previewSprites({ ...area.source, tiles: [...area.tiles.values()] }, view.camera) });
  const context = canvasContext(canvas), options = { theme: view.theme };
  for (const object of area.source.objects) if (object.kind === "flagGoal") {
    const x = object.x - view.camera.x, y = object.y - view.camera.y;
    drawPole(context, { x, y, heightCells: object.props.height }, options);
    drawSprite(context, { key: "decor.flag", x, y: y - object.props.height * 16 + 24 }, options);
  }
  for (const actor of runtime.items.actors) {
    if (actor.areaId !== runtime.areaId) continue;
    const x = actor.x - view.camera.x, y = actor.y - view.camera.y;
    if (actor.kind === "vine") {
      // Clip the final partial segment so visual growth matches the authoritative climb extent.
      context.save(); context.beginPath(); context.rect(x - 8, y - actor.height, 16, actor.height); context.clip();
      for (let offset = 0; offset < actor.height; offset += 16) drawSprite(context, { key: "decor.vineSegment", x, y: y - offset }, options);
      if (actor.height > 0) drawSprite(context, { key: "decor.vineTop", x, y: y - actor.height + 16 }, options);
      context.restore();
    } else {
      const key: AssetKey = actor.kind === "star" ? frameAt("item.star", runtime.tick) : actor.kind === "fireball" ? "item.fireball" : `item.${actor.kind}`;
      context.save();
      if (actor.emerging > 0) { context.beginPath(); context.rect(x - 8, y - 32, 16, 32 - actor.emerging); context.clip(); }
      drawSprite(context, { key, x, y }, options); context.restore();
    }
  }
  if (runtime.combat.invulnerabilityTicks === 0 || runtime.tick % 6 < 3) {
    context.save();
    if (runtime.combat.starTicks > 0) context.filter = `hue-rotate(${Math.floor(runtime.tick / 4) % 6 * 60}deg)`;
    drawSprite(context, { ...view.player, x: view.player.x - view.camera.x, y: view.player.y - view.camera.y }, options);
    context.restore();
  }
  canvas.style.width = "512px"; canvas.style.height = "480px";
}
