import assert from "node:assert/strict";
import { EMPTY_INPUT } from "../../src/input";
import { playerBounds, sweepAxis } from "../../src/game/collision";
import { currentArea } from "../../src/game/state";
import { climbIntent, createClimbState } from "../../src/game/climb";
import { removePlatformBodies, selectPlatformRider, stepPlatforms } from "../../src/game/platforms";
import type { PlatformTickResult } from "../../src/game/platforms";
import { bodyById, platformIds as ids, platformInput, platformJump, platformRuntime, playerOn } from "./platforms";

/** CLI module proof, not a second playable runtime or a claim that the shared step carries riders. */
export function tracePlatformCore() {
  const { runtime, state: initial } = platformRuntime(), sourceBefore = structuredClone(runtime.course);
  const player = playerOn(runtime.player, bodyById(initial, ids.horizontal));
  const previousContacts = sweepAxis(currentArea(runtime), playerBounds(player), 1 / 256, "y").contacts;
  const selected = selectPlatformRider(initial, player, previousContacts, EMPTY_INPUT);
  assert.equal(selected, ids.horizontal);
  assert.equal(selectPlatformRider(initial, player, previousContacts, platformJump), null);

  const rows: { input: { tick: number; riderId: string | null }; output: PlatformTickResult }[] = [];
  let state = initial;
  // Each item is an explicit core API input, with no RAF, wall time, FixedClock, or runtime.tick writer.
  const inputs = Array.from({ length: 80 }, (_, index) => ({ tick: index + 1,
    riderId: index < 9 ? ids.spring : index === 9 ? null : index === 10 ? ids.falling
      : index < 36 ? ids.balanceA : index < 79 ? ids.balanceB : null }));
  for (const input of inputs) {
    const output = stepPlatforms(state, input.tick, input.riderId); state = output.state;
    rows.push({ input, output });
  }
  const events = rows.flatMap(row => row.output.events);
  assert.equal(events.filter(event => event.type === "spring-launch").length, 1);
  assert(events.some(event => event.type === "spring-launch" && event.tick === 9 && event.vy === -7));
  assert(events.some(event => event.type === "platform-reverse" && event.id === ids.horizontal && event.tick === 8));
  const falling = bodyById(state, ids.falling);
  assert(falling.kind === "platform" && falling.vy === 4);
  const a = bodyById(state, ids.balanceA), b = bodyById(state, ids.balanceB);
  assert.equal(a.bounds.y - a.origin.y, -16); assert.equal(b.bounds.y - b.origin.y, 16);
  const removal = removePlatformBodies(state, new Set([ids.balanceB]), 81);
  assert(!removal.state.bodies.some(body => body.id === ids.balanceB));
  const survivor = bodyById(removal.state, ids.balanceA);
  assert(survivor.kind === "platform" && survivor.props.motion === "balance" && survivor.props.pairId === undefined);

  const vine = { id: "task7-provided-vine", bounds: { x: 250, y: 64, width: 12, height: 96 } };
  const climbPlayer = { ...runtime.player, x: 256, y: 128, grounded: false };
  const attach = climbIntent(createClimbState(), climbPlayer, platformInput("up"), [vine], 82);
  assert(attach.kind === "climb" && attach.dy === -1);
  const detach = climbIntent(attach.state, climbPlayer, platformJump, [vine], 83);
  assert.equal(detach.kind, "jump");
  const regrab = climbIntent(detach.state, climbPlayer, platformInput("up"), [vine], 84);
  assert.equal(regrab.kind, "free");
  assert.deepEqual(runtime.course, sourceBefore); assert.equal(runtime.tick, 0);
  return {
    surface: "typed core module invocation",
    riderInputs: "Explicit fixture inputs after a real terrain top-contact selection proof; NOT live carry integration",
    notProven: ["dynamic collider replacement in shared collision", "carry", "crush", "vine spawn", "rendered movement", "browser QA", "editor undo"],
    previousContacts, selected, rows, removal, climb: { attach, detach, regrab },
    assertions: { passed: true, authoredCourseUnchanged: true, authoritativeRuntimeTickUnchanged: true },
  };
}
if (import.meta.main) console.log(JSON.stringify(tracePlatformCore(), null, 2));
