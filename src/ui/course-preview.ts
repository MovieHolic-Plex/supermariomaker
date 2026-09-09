import { getFrame } from "../assets/manifest";
import { warpLabels } from "../editor/areas";
import { OBJECT_CATALOG, TILE_CATALOG } from "../level/catalog";
import type { AreaV1, CourseV1 } from "../level/types";
import { canvasContext, drawSprite } from "../render/assets";
import type { SpriteView } from "../render/assets";
import { drawPole, GAME_VIEWPORT, renderScene } from "../render/renderer";
import type { CameraView } from "../render/renderer";

/** Static authored positions only. No animation, simulation, placement or document mutation. */
export function previewSprites(area: AreaV1, camera: CameraView): readonly SpriteView[] {
  const sprites: SpriteView[] = [];
  const add = (sprite: SpriteView) => {
    const frame = getFrame(sprite.key);
    const left = sprite.x - frame.anchor.x - camera.x, top = sprite.y - frame.anchor.y - camera.y;
    if (left < GAME_VIEWPORT.width && top < GAME_VIEWPORT.height && left + frame.width > 0 && top + frame.height > 0) sprites.push(sprite);
  };
  for (const tile of area.tiles) add({ key: TILE_CATALOG[tile.kind].assetKey, x: tile.x * 16 + 8, y: tile.y * 16 + 16 });
  for (const object of area.objects) {
    const { x, y } = object;
    switch (object.kind) {
      case "pipe":
        for (let row = 0; row < object.props.height; row++) add({ key: row === object.props.height - 1 ? "decor.pipeCap" : "decor.pipeBody", x, y: y - row * 16 });
        break;
      case "platform":
        for (let cell = 0; cell < object.props.length; cell++) add({ key: OBJECT_CATALOG.platform.assetKey, x: x - object.props.length * 8 + cell * 16 + 8, y });
        break;
      case "castleGoal": {
        const bridge = object.props.bridge;
        for (let cell = 0; cell < bridge.width; cell++) add({ key: "decor.bridge", x: (bridge.x + cell) * 16 + 8, y: bridge.y * 16 + 16 });
        add({ key: OBJECT_CATALOG.castleGoal.assetKey, x, y });
        break;
      }
      // The pole is composed by the renderer; the flag is drawn over it below.
      case "flagGoal": break;
      case "koopa": add({ key: object.props.color === "red" ? "enemy.koopa.red.walk1" : OBJECT_CATALOG.koopa.assetKey, x, y }); break;
      case "paratroopa": add({ key: object.props.color === "red" ? "enemy.koopa.red.wings1" : OBJECT_CATALOG.paratroopa.assetKey, x, y }); break;
      case "cheep": add({ key: object.props.color === "green" ? "enemy.cheep.green.swim1" : OBJECT_CATALOG.cheep.assetKey, x, y }); break;
      case "firebar":
        for (let segment = 0; segment < object.props.length; segment++) add({ key: OBJECT_CATALOG.firebar.assetKey, x: x + segment * 8, y });
        break;
      case "spring": case "goomba": case "piranha": case "buzzy": case "billCannon": case "hammerBro":
      case "lakitu": case "blooper": case "podoboo": case "bowser": case "warpZone":
        add({ key: OBJECT_CATALOG[object.kind].assetKey, x, y }); break;
      default: { const exhaustive: never = object; throw new Error(`Unsupported preview object: ${String(exhaustive)}`); }
    }
  }
  return sprites;
}

export function warpLabelMarks(course: CourseV1, area: AreaV1): readonly Readonly<{ text: string; x: number; y: number }>[] {
  const marks: { text: string; x: number; y: number }[] = [];
  for (const object of area.objects) {
    if (object.kind !== "warpZone") continue;
    const labels = warpLabels(course, object);
    for (let slot = 0; slot < 3; slot++) {
      const text = labels[slot] ?? "-";
      const pipeId = object.props.pipeIds[slot];
      const pipe = pipeId ? area.objects.find(item => item.id === pipeId) : undefined;
      if (pipe?.kind === "pipe") marks.push({ text, x: pipe.x, y: pipe.y - pipe.props.height * 16 - 2 });
      else marks.push({ text, x: object.x + (slot - 1) * 32, y: object.y - 8 });
    }
  }
  return marks;
}

export function drawWarpLabels(context: CanvasRenderingContext2D, course: CourseV1, area: AreaV1, camera: CameraView): void {
  context.save();
  context.font = "8px monospace";
  context.textAlign = "center";
  context.textBaseline = "bottom";
  context.lineWidth = 2;
  context.strokeStyle = "#24180c";
  context.fillStyle = "#f4e6a3";
  for (const mark of warpLabelMarks(course, area)) {
    const x = mark.x - camera.x, y = mark.y - camera.y;
    context.strokeText(mark.text, x, y);
    context.fillText(mark.text, x, y);
  }
  context.restore();
}

export function renderCoursePreview(canvas: HTMLCanvasElement, course: CourseV1, view: Readonly<{ area: AreaV1; camera: CameraView }>): void {
  const { area, camera } = view;
  renderScene(canvas, { theme: area.theme, camera, sprites: previewSprites(area, camera), editorPreview: true });
  const context = canvasContext(canvas);
  const options = { theme: area.theme, editorPreview: true } as const;
  for (const object of area.objects) if (object.kind === "flagGoal") {
    const x = object.x - camera.x, y = object.y - camera.y;
    drawPole(context, { x, y, heightCells: object.props.height }, options);
    drawSprite(context, { key: OBJECT_CATALOG.flagGoal.assetKey, x, y: y - object.props.height * 16 + 24 }, options);
  }
  if (course.start.areaId === area.id) drawSprite(context, {
    key: "mario.small.idle", x: course.start.x - camera.x, y: course.start.y - camera.y,
  }, options);
  drawWarpLabels(context, course, area, camera);
  // Backing allocation remains 256x240; only CSS display is enlarged.
  canvas.style.width = "512px";
  canvas.style.height = "480px";
}
