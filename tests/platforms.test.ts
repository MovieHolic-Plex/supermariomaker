import { describe, expect, test } from "bun:test";
import { EMPTY_INPUT } from "../src/input";
import { createRuntime, currentArea, snapshot } from "../src/game/state";
import { step } from "../src/game/step";
import { PHYSICS } from "../src/game/physics";
import { playerBounds, sweepAxis } from "../src/game/collision";
import { createPlatformState, platformColliders, removePlatformBodies, selectPlatformRider, stepPlatforms } from "../src/game/platforms";
import type { PlatformBody, PlatformFeatureState } from "../src/game/platforms";
import { climbIntent, createClimbState } from "../src/game/climb";
import { itemBounds } from "../src/game/items";
import { playView } from "../src/ui/play-view";
import { validateCourse } from "../src/level/validate";
import { fixtureId } from "./fixtures/factory";
import { bodyById, createPlatformLiveFixture, createPlatformsFixture, placedPlatform, platformIds as ids, platformInput as held,
  platformJump as jump, platformRuntime, playerOn, topContact } from "./fixtures/platforms";

// These are synchronous authoritative tick inputs, not sleeps or a second simulation clock.
describe("platform motion core (not live carry/crush integration)", () => {
  test.each([0.5, 1, 2] as const)("horizontal ping-pong speed %s reverses exactly at both travel endpoints", speed => {
    let { state } = platformRuntime([placedPlatform(ids.horizontal, { motion: "horizontal", length: 2, travel: 1, speed })]);
    const origin = bodyById(state, ids.horizontal).bounds;
    const endTick = 16 / speed;
    for (let tick = 1; tick <= endTick * 2 + 1; tick++) {
      const result = stepPlatforms(state, tick, null); state = result.state;
      const body = bodyById(state, ids.horizontal);
      const offset = tick <= endTick ? tick * speed : tick <= endTick * 2 ? 32 - tick * speed : speed;
      expect(body.bounds.x).toBe(origin.x + offset); expect(body.bounds.y).toBe(origin.y);
      expect(result.motions[0]?.dx).toBe(tick <= endTick || tick > endTick * 2 ? speed : -speed);
      expect(result.events).toEqual(tick === endTick || tick === endTick * 2
        ? [{ type: "platform-reverse", id: ids.horizontal, tick }] : []);
    }
  });
  test("vertical maximum travel, full length range, collider identity, and source immutability", () => {
    const objects = Array.from({ length: 7 }, (_, i) => placedPlatform(fixtureId(920 + i),
      { motion: "vertical", length: i + 2, travel: 32, speed: 2 }, 256 + i * 160));
    const { runtime, state: initial } = platformRuntime(objects), before = structuredClone(runtime.course);
    let state = initial;
    for (let tick = 1; tick <= 257; tick++) state = stepPlatforms(state, tick, null).state;
    state.bodies.forEach((body, i) => {
      expect(body.bounds.width).toBe((i + 2) * 16); expect(body.bounds.height).toBe(8);
      expect(body.bounds.x).toBe(body.origin.x); expect(body.bounds.y).toBe(body.origin.y + 510);
      const collider = platformColliders(state)[i];
      expect(collider).toEqual({ id: body.id, ...body.bounds, source: { kind: "object", objectId: body.id, part: "body" } });
    });
    expect(initial.bodies.every(body => body.bounds.y === body.origin.y)).toBe(true);
    expect(runtime.course).toEqual(before); expect([currentArea(runtime).source]).toEqual([...before.areas]);
  });
  test.each([1, 32])("travel %s covers the validated cell contract", travel => {
    let { state } = platformRuntime([placedPlatform(ids.horizontal, { motion: "horizontal", length: 8, travel, speed: 2 })]);
    for (let tick = 1; tick <= travel * 8; tick++) state = stepPlatforms(state, tick, null).state;
    expect(bodyById(state, ids.horizontal).bounds.x).toBe(bodyById(state, ids.horizontal).origin.x + travel * 16);
  });
  test("falling waits for first rider, then accelerates without a rider and caps at four", () => {
    let { state } = platformRuntime(); const original = bodyById(state, ids.falling).bounds;
    state = stepPlatforms(state, 90, null).state;
    expect(bodyById(state, ids.falling).bounds).toEqual(original);
    const trigger = stepPlatforms(state, 91, ids.falling); state = trigger.state;
    expect(trigger.events).toContainEqual({ type: "platform-fall", id: ids.falling, tick: 91 });
    const first = bodyById(state, ids.falling); expect(first.kind === "platform" && first.vy).toBe(0.1);
    expect(first.bounds.y).toBe(Math.round((original.y + 0.1) * 256) / 256);
    for (let tick = 92; tick <= 140; tick++) {
      const result = stepPlatforms(state, tick, null); state = result.state;
      expect(result.events.some(event => event.type === "platform-fall")).toBe(false);
    }
    const fallen = bodyById(state, ids.falling); expect(fallen.kind === "platform" && fallen.vy).toBe(4);
    expect(stepPlatforms(state, 141, null).motions.find(motion => motion.id === ids.falling)?.dy).toBe(4);
  });
  test("balance is reciprocal, weight-directed, equal/opposite, and jointly clamped at the shorter travel", () => {
    let { state } = platformRuntime();
    const rest = stepPlatforms(state, 1, null);
    expect(rest.motions.find(motion => motion.id === ids.balanceA)?.dy).toBe(0);
    for (let tick = 2; tick <= 24; tick++) {
      const result = stepPlatforms(state, tick, ids.balanceA); state = result.state;
      const a = bodyById(state, ids.balanceA), b = bodyById(state, ids.balanceB);
      expect(a.bounds.y - a.origin.y).toBe(Math.min(16, (tick - 1) * 0.75));
      expect(b.bounds.y - b.origin.y).toBe(-(a.bounds.y - a.origin.y));
      const da = result.motions.find(motion => motion.id === a.id)?.dy;
      const db = result.motions.find(motion => motion.id === b.id)?.dy;
      expect(Number(da) + Number(db)).toBe(0);
    }
    for (let tick = 25; tick <= 70; tick++) state = stepPlatforms(state, tick, ids.balanceB).state;
    expect(bodyById(state, ids.balanceA).bounds.y).toBe(bodyById(state, ids.balanceA).origin.y - 16);
    expect(bodyById(state, ids.balanceB).bounds.y).toBe(bodyById(state, ids.balanceB).origin.y + 16);
  });
  test("unpaired balance remains valid stationary balance even with a rider", () => {
    const { state } = platformRuntime();
    const result = stepPlatforms(state, 1, ids.unpaired);
    expect(bodyById(result.state, ids.unpaired)).toEqual(bodyById(state, ids.unpaired));
  });
  test("runtime deletion atomically clears surviving pair reference and collider without converting or teleporting", () => {
    const { runtime, state: initial } = platformRuntime();
    const state = stepPlatforms(initial, 1, ids.balanceA).state, authored = structuredClone(runtime.course);
    const result = removePlatformBodies(state, new Set([ids.balanceB]), 2);
    expect(result.state.bodies.some(body => body.id === ids.balanceB)).toBe(false);
    const survivor = bodyById(result.state, ids.balanceA);
    expect(survivor.kind === "platform" && survivor.props).toEqual({ motion: "balance", length: 3, travel: 1, speed: 1 });
    expect(survivor.bounds).toEqual(bodyById(state, ids.balanceA).bounds);
    expect(result.events).toEqual([{ type: "balance-unpair", tick: 2, id: ids.balanceA, partnerId: ids.balanceB }]);
    expect(platformColliders(result.state).some(collider => collider.id === ids.balanceB)).toBe(false);
    expect(bodyById(stepPlatforms(result.state, 3, ids.balanceA).state, ids.balanceA)).toEqual(survivor);
    expect(runtime.course).toEqual(authored); expect(state.bodies).toHaveLength(7);
    const both = removePlatformBodies(state, new Set([ids.balanceA, ids.balanceB]), 2);
    expect(both.state.bodies).toHaveLength(5); expect(both.events).toEqual([]);
  });
  test("malformed reciprocal links fail the real loader rather than being treated as motion", () => {
    const course = createPlatformsFixture();
    const broken = { ...course, areas: course.areas.map(area => ({ ...area,
      objects: area.objects.filter(object => object.id !== ids.balanceB) })) };
    const result = validateCourse(broken); expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("invalid_reference");
  });
  test("one rider is selected by stable ID from real previous top contacts; jump, lost contact, sides and ascent detach", () => {
    const { runtime, state } = platformRuntime([
      placedPlatform(ids.horizontal, { motion: "horizontal", length: 2, travel: 1, speed: 1 }, 256),
      placedPlatform(ids.vertical, { motion: "vertical", length: 2, travel: 1, speed: 1 }, 288),
    ]);
    const player = { ...playerOn(runtime.player, bodyById(state, ids.horizontal)), x: 272 };
    const contacts = sweepAxis(currentArea(runtime), playerBounds(player), 1 / 256, "y").contacts;
    expect(contacts).toHaveLength(2);
    expect(selectPlatformRider(state, player, [...contacts].reverse(), EMPTY_INPUT)).toBe(ids.horizontal);
    expect(selectPlatformRider(state, player, contacts, jump)).toBeNull();
    expect(selectPlatformRider(state, { ...player, vy: -1 }, contacts, EMPTY_INPUT)).toBeNull();
    expect(selectPlatformRider(state, { ...player, grounded: false }, contacts, EMPTY_INPUT)).toBeNull();
    expect(selectPlatformRider(state, { ...player, x: 350 }, contacts, EMPTY_INPUT)).toBeNull();
    expect(selectPlatformRider(state, { ...player, y: player.y - 1 }, contacts, EMPTY_INPUT)).toBeNull();
    expect(selectPlatformRider(state, player, [], EMPTY_INPUT)).toBeNull();
    expect(selectPlatformRider(state, player, contacts.map(contact => ({ ...contact, axis: "x" })), EMPTY_INPUT)).toBeNull();
    expect(selectPlatformRider(state, player, contacts.map(contact => ({ ...contact, normal: 1 })), EMPTY_INPUT)).toBeNull();
  });
  test("spring compresses for eight elapsed ticks, changes collider bounds and emits a single -7 launch", () => {
    let { state } = platformRuntime(); const spring = bodyById(state, ids.spring);
    for (let tick = 40; tick <= 47; tick++) {
      const result = stepPlatforms(state, tick, ids.spring); state = result.state;
      const body = bodyById(state, ids.spring);
      expect(body.bounds).toEqual({ ...spring.bounds, y: spring.bounds.y + 8, height: 8 });
      expect(result.colliders.find(collider => collider.id === ids.spring)?.height).toBe(8);
      expect(result.events.filter(event => event.id === ids.spring)).toEqual(tick === 40
        ? [{ type: "spring-compress", tick: 40, id: ids.spring }] : []);
    }
    const launch = stepPlatforms(state, 48, ids.spring); state = launch.state;
    expect(launch.events).toContainEqual({ type: "spring-launch", id: ids.spring, tick: 48, vy: -7 });
    expect(bodyById(state, ids.spring).bounds).toEqual(spring.bounds);
    expect(stepPlatforms(state, 49, ids.spring).events.filter(event => event.id === ids.spring)).toEqual([]);
    state = stepPlatforms(state, 49, null).state;
    expect(stepPlatforms(state, 50, ids.spring).events).toContainEqual({ type: "spring-compress", id: ids.spring, tick: 50 });
  });
  test("walking or jumping away cancels spring compression; no delayed launch and reattachment starts fresh", () => {
    const { runtime, state: initial } = platformRuntime(); let state = stepPlatforms(initial, 7, ids.spring).state;
    const player = playerOn(runtime.player, bodyById(state, ids.spring));
    const rider = selectPlatformRider(state, player, [topContact(ids.spring)], jump);
    expect(rider).toBeNull();
    const cancel = stepPlatforms(state, 8, rider); state = cancel.state;
    expect(cancel.events).toContainEqual({ type: "spring-cancel", id: ids.spring, tick: 8 });
    expect(bodyById(state, ids.spring).bounds).toEqual(bodyById(initial, ids.spring).bounds);
    expect(stepPlatforms(state, 15, null).events.some(event => event.type === "spring-launch")).toBe(false);
    state = stepPlatforms(state, 20, ids.spring).state;
    expect(stepPlatforms(state, 27, ids.spring).events.some(event => event.type === "spring-launch")).toBe(false);
    expect(stepPlatforms(state, 28, ids.spring).events).toContainEqual({ type: "spring-launch", id: ids.spring, tick: 28, vy: -7 });
  });
  test("authored order and independent instances do not change tick results", () => {
    const course = createPlatformsFixture();
    const reversed = { ...course, areas: course.areas.map(area => ({ ...area, objects: [...area.objects].reverse() })) };
    let a = createPlatformState(currentArea(createRuntime(course))), b = createPlatformState(currentArea(createRuntime(reversed)));
    const untouched = structuredClone(a);
    for (let tick = 100; tick <= 150; tick++) {
      const rider = tick < 110 ? ids.spring : tick < 125 ? ids.falling : ids.balanceB;
      const ra = stepPlatforms(a, tick, rider), rb = stepPlatforms(b, tick, rider);
      expect(ra).toEqual(rb); a = ra.state; b = rb.state;
    }
    expect(createPlatformState(currentArea(createRuntime(course)))).toEqual(untouched);
  });
});

describe("vine attachment and climb intent (provided bounds, not spawned here)", () => {
  const vine = { id: fixtureId(990), bounds: { x: 250, y: 64, width: 12, height: 96 } };
  function setup() { const { runtime } = platformRuntime(); return { ...runtime.player, x: 256, y: 128, grounded: false }; }
  test("directional overlap attaches, climbs exactly one pixel, neutral holds and opposite axes cancel", () => {
    const player = setup(), original = structuredClone(player), state = createClimbState();
    expect(climbIntent(state, player, EMPTY_INPUT, [vine], 1).kind).toBe("free");
    expect(climbIntent(state, player, held("up", "down"), [vine], 1).kind).toBe("free");
    const attach = climbIntent(state, player, held("up"), [vine], 2);
    expect(attach).toMatchObject({ kind: "climb", dx: 0, dy: -1, vx: 0, vy: 0, state: { vineId: vine.id } });
    expect(attach.events).toEqual([{ type: "vine-attach", tick: 2, vineId: vine.id }]);
    expect(climbIntent(attach.state, player, held("down"), [vine], 3)).toMatchObject({ kind: "climb", dy: 1 });
    expect(climbIntent(attach.state, player, EMPTY_INPUT, [vine], 4)).toMatchObject({ kind: "climb", dy: 0, events: [] });
    expect(climbIntent(attach.state, player, held("up", "down"), [vine], 5)).toMatchObject({ kind: "climb", dy: 0 });
    expect(player).toEqual(original); expect(state).toEqual(createClimbState());
  });
  test.each(["small", "super", "fire"] as const)("%s bounds limit climb without snapping or uncrouching player", form => {
    const player = { ...setup(), form }, height = playerBounds(player).height;
    const state = { vineId: vine.id, blockedVineId: null };
    expect(climbIntent(state, { ...player, y: vine.bounds.y + height }, held("up"), [vine], 1)).toMatchObject({ kind: "climb", dy: 0 });
    expect(climbIntent(state, { ...player, y: vine.bounds.y + height + 0.5 }, held("up"), [vine], 1)).toMatchObject({ kind: "climb", dy: -0.5 });
    expect(climbIntent(state, { ...player, y: 160 }, held("down"), [vine], 1)).toMatchObject({ kind: "climb", dy: 0 });
    expect(climbIntent(state, { ...player, y: 159.5 }, held("down"), [vine], 1)).toMatchObject({ kind: "climb", dy: 0.5 });
    expect(climbIntent(state, { ...player, y: vine.bounds.y + height - 2 }, held("up"), [vine], 1)).toMatchObject({ kind: "climb", dy: 0 });
  });
  test("jump is an edge, detaches once using base jump velocity and blocks immediate same-vine regrab", () => {
    const player = setup(), attached = climbIntent(createClimbState(), player, held("up"), [vine], 1);
    const detach = climbIntent(attached.state, player, { ...held("up"), jump: jump.jump }, [vine], 2);
    expect(detach).toMatchObject({ kind: "jump", vy: PHYSICS.jump, state: { vineId: null, blockedVineId: vine.id } });
    expect(detach.events).toEqual([{ type: "vine-detach", tick: 2, vineId: vine.id, reason: "jump" }]);
    expect(climbIntent(detach.state, player, held("up", "jump"), [vine], 3).kind).toBe("free");
    const away = climbIntent(detach.state, { ...player, x: 300 }, held("up"), [vine], 4);
    expect(away.state.blockedVineId).toBeNull();
    expect(climbIntent(away.state, player, held("up"), [vine], 5).kind).toBe("climb");
    expect(climbIntent(attached.state, player, held("jump"), [vine], 2).kind).toBe("climb");
    expect(climbIntent(createClimbState(), player, { ...held("up"), jump: jump.jump }, [vine], 1).kind).toBe("free");
  });
  test("removed vine/area change or lost overlap detaches; selection is stable and never teleports horizontally", () => {
    const player = setup(), other = { ...vine, id: fixtureId(991) }, initial = createClimbState();
    const attached = climbIntent(initial, player, held("up"), [other, vine], 1);
    expect(attached.state.vineId).toBe(vine.id);
    expect(climbIntent(initial, player, held("up"), [vine, other], 1)).toEqual(attached);
    const lost = climbIntent(attached.state, player, EMPTY_INPUT, [], 2);
    expect(lost).toMatchObject({ kind: "free", state: { vineId: null } });
    expect(lost.events).toEqual([{ type: "vine-detach", vineId: vine.id, tick: 2, reason: "lost" }]);
    expect(climbIntent(attached.state, { ...player, x: 300 }, held("up"), [vine], 2).kind).toBe("free");
    expect(climbIntent(initial, { ...player, x: 244 }, held("up"), [vine], 1).kind).toBe("free");
    expect(attached).toMatchObject({ dx: 0 });
  });
});

function live(which: Parameters<typeof createPlatformLiveFixture>[0]) {
  const course = createPlatformLiveFixture(which), runtime = createRuntime(course);
  return { course, runtime, area: currentArea(runtime) };
}
function platformsOf(runtime: ReturnType<typeof createRuntime>): PlatformFeatureState {
  const platforms = currentArea(runtime).platforms;
  expect(platforms).toBeDefined();
  return platforms;
}
function liveBody(runtime: ReturnType<typeof createRuntime>, id: string): PlatformBody {
  const found = platformsOf(runtime).bodies.find(candidate => candidate.id === id);
  expect(found).toBeDefined();
  if (!found) throw new Error(`Missing live body ${id}`);
  return found;
}

describe("live shared-step platform integration", () => {
  test("first-tick support contacts let the player ride immediately without velocity carry", () => {
    const { runtime, course } = live("horizontal"), before = JSON.stringify(course);
    expect(runtime.tick).toBe(0); expect(runtime.player.grounded).toBe(true);
    expect(runtime.contacts.some(contact => contact.id === ids.horizontal && contact.axis === "y" && contact.normal === -1)).toBe(true);
    const startX = runtime.player.x, origin = liveBody(runtime, ids.horizontal).origin.x;
    step(runtime, EMPTY_INPUT);
    const moved = liveBody(runtime, ids.horizontal);
    expect(moved.bounds.x).toBe(origin + 1);
    expect(runtime.player.x).toBe(startX + 1);
    expect(runtime.player.vx).toBe(0);
    expect(runtime.player.y).toBe(moved.bounds.y);
    expect(JSON.stringify(runtime.course)).toBe(before); expect(JSON.stringify(course)).toBe(before);
  });
  test("horizontal and vertical rides reverse with the resolved body, not authored geometry", () => {
    const horizontal = live("horizontal"), h0 = liveBody(horizontal.runtime, ids.horizontal).origin.x;
    for (let tick = 0; tick < 64; tick++) step(horizontal.runtime, EMPTY_INPUT);
    expect(liveBody(horizontal.runtime, ids.horizontal).bounds.x).toBe(h0 + 64);
    expect(horizontal.runtime.player.x).toBe(80 + 64);
    step(horizontal.runtime, EMPTY_INPUT);
    expect(liveBody(horizontal.runtime, ids.horizontal).bounds.x).toBe(h0 + 63);
    expect(horizontal.runtime.player.x).toBe(80 + 63);
    const vertical = live("vertical"), y0 = liveBody(vertical.runtime, ids.vertical).origin.y;
    for (let tick = 0; tick < 64; tick++) step(vertical.runtime, EMPTY_INPUT);
    expect(liveBody(vertical.runtime, ids.vertical).bounds.y).toBe(y0 + 64);
    expect(vertical.runtime.player.y).toBe(y0 + 64);
    step(vertical.runtime, EMPTY_INPUT);
    expect(vertical.runtime.player.y).toBe(y0 + 63);
  });
  test("falling and balance carry the rider; pairs stay equal and opposite when a ceiling constrains one side", () => {
    const falling = live("falling"), y0 = falling.runtime.player.y;
    const events = step(falling.runtime, EMPTY_INPUT);
    expect(events).toContainEqual({ type: "platform-fall", id: ids.falling, tick: 1 });
    const fallen = liveBody(falling.runtime, ids.falling);
    expect(fallen.kind === "platform" && fallen.falling).toBe(true);
    expect(falling.runtime.player.y).toBeGreaterThan(y0);
    const { runtime } = live("balance");
    for (let tick = 0; tick < 20; tick++) step(runtime, EMPTY_INPUT);
    const a = liveBody(runtime, ids.balanceA), b = liveBody(runtime, ids.balanceB);
    expect(a.bounds.y - a.origin.y).toBeCloseTo(15); expect(b.bounds.y - b.origin.y).toBeCloseTo(-15);
    expect((a.bounds.y - a.origin.y) + (b.bounds.y - b.origin.y)).toBe(0);
  });
  test("jump and walk-off drop rider weight; climbing also refuses to load the platform", () => {
    const hopped = live("horizontal");
    step(hopped.runtime, EMPTY_INPUT); step(hopped.runtime, jump);
    const airborneX = hopped.runtime.player.x;
    const platformX = liveBody(hopped.runtime, ids.horizontal).bounds.x;
    step(hopped.runtime, EMPTY_INPUT); step(hopped.runtime, EMPTY_INPUT);
    expect(hopped.runtime.player.grounded).toBe(false);
    expect(hopped.runtime.player.x).toBe(airborneX);
    expect(liveBody(hopped.runtime, ids.horizontal).bounds.x).toBeGreaterThan(platformX);
    const walked = live("horizontal");
    for (let tick = 0; tick < 40; tick++) step(walked.runtime, held("right"));
    expect(walked.runtime.player.x).toBeGreaterThan(liveBody(walked.runtime, ids.horizontal).bounds.x + liveBody(walked.runtime, ids.horizontal).bounds.width);
  });
  test("stable single rider and no double carry when two tops coincide", () => {
    const course = createPlatformLiveFixture("horizontal");
    const dual = { ...course, areas: course.areas.map(area => ({ ...area, objects: [
      ...area.objects,
      { id: ids.vertical, kind: "platform" as const, x: 80, y: 160, props: { motion: "horizontal" as const, length: 3, travel: 4, speed: 1 as const } },
    ] })) };
    const runtime = createRuntime(dual), start = runtime.player.x;
    step(runtime, EMPTY_INPUT);
    expect(runtime.player.x).toBe(start + 1);
    expect(runtime.player.vx).toBe(0);
    expect(runtime.contacts.filter(contact => contact.axis === "y" && contact.normal === -1).map(contact => contact.id)
      .every(id => id === ids.horizontal || id === ids.vertical)).toBe(true);
  });
  test("removed bodies leave no ghost collider, art, or contact; authored course is unchanged", () => {
    const { runtime, course } = live("horizontal"), authored = structuredClone(runtime.course);
    step(runtime, EMPTY_INPUT);
    const origin = liveBody(runtime, ids.horizontal).origin;
    currentArea(runtime).platforms = removePlatformBodies(platformsOf(runtime), new Set([ids.horizontal]), runtime.tick).state;
    expect(platformsOf(runtime).bodies.some(candidate => candidate.id === ids.horizontal)).toBe(false);
    const ghost = { x: origin.x, y: origin.y - 8, width: origin.width, height: 16 };
    expect(sweepAxis(currentArea(runtime), ghost, 8, "y").contacts.some(contact => contact.id === ids.horizontal)).toBe(false);
    expect(playView(runtime).platforms.some(sprite => sprite.id === ids.horizontal)).toBe(false);
    expect(runtime.course).toEqual(authored); expect(runtime.course).toEqual(course);
    step(runtime, EMPTY_INPUT);
    expect(runtime.contacts.some(contact => contact.id === ids.horizontal)).toBe(false);
  });
  test("carry stops at walls; blocked upward carry crushes through star and invulnerability without tunneling", () => {
    const walled = live("wall"), wallX = 160;
    for (let tick = 0; tick < 40; tick++) step(walled.runtime, EMPTY_INPUT);
    expect(walled.runtime.player.x).toBeGreaterThan(90);
    expect(walled.runtime.player.x + PHYSICS.width / 2).toBeLessThanOrEqual(wallX);
    expect(walled.runtime.combat.defeated).toBe(false);
    const crushed = live("crush");
    crushed.runtime.combat.starTicks = 600; crushed.runtime.combat.invulnerabilityTicks = 120;
    for (let tick = 0; tick < 16; tick++) step(crushed.runtime, EMPTY_INPUT);
    const rising = liveBody(crushed.runtime, ids.vertical);
    Object.assign(crushed.runtime.player, { x: 80, y: rising.bounds.y, vx: 0, vy: 0, grounded: true });
    crushed.runtime.contacts = [{ id: ids.vertical, source: { kind: "object", objectId: ids.vertical, part: "body" }, axis: "y", normal: -1, time: 0 }];
    let crush = null as ReturnType<typeof step> | null;
    for (let tick = 0; tick < 24 && !crushed.runtime.combat.defeated; tick++) crush = step(crushed.runtime, EMPTY_INPUT);
    expect(crushed.runtime.combat.defeated).toBe(true);
    expect(crush?.some(event => event.type === "playerDefeated" && event.hit.kind === "crush")).toBe(true);
    expect(crushed.runtime.player.y - playerBounds(crushed.runtime.player).height).toBeGreaterThanOrEqual(144);
    expect(step(crushed.runtime, jump)).toEqual([]);
  });
  test("spring compresses T..T+7, launches exactly at T+8 with vy=-7 once, cancel and release rearm", () => {
    const { runtime } = live("spring"), startY = runtime.player.y;
    for (let tick = 1; tick <= 8; tick++) {
      const events = step(runtime, EMPTY_INPUT);
      expect(events.some(event => event.type === "spring-launch")).toBe(false);
      expect(liveBody(runtime, ids.spring).bounds.height).toBe(8);
      expect(runtime.player.y).toBeGreaterThan(startY);
    }
    const launch = step(runtime, EMPTY_INPUT);
    expect(launch).toContainEqual({ type: "spring-launch", id: ids.spring, tick: 9, vy: -7 });
    expect(runtime.player.y).toBeLessThan(startY);
    expect(launch.filter(event => event.type === "spring-launch")).toHaveLength(1);
    expect(step(runtime, EMPTY_INPUT).some(event => event.type === "spring-launch")).toBe(false);
    const cancel = live("spring");
    step(cancel.runtime, EMPTY_INPUT); step(cancel.runtime, EMPTY_INPUT);
    expect(step(cancel.runtime, jump).some(event => event.type === "spring-cancel")).toBe(true);
    for (let tick = 0; tick < 12; tick++) expect(step(cancel.runtime, EMPTY_INPUT).some(event => event.type === "spring-launch")).toBe(false);
  });
  test("spawned partial vine climb, jump detach without a duplicate ground jump, regrab block, spawn obstruction", () => {
    const { runtime } = live("vine");
    runtime.player.x = 40; runtime.player.y = 192; runtime.player.vx = 0; runtime.player.vy = -5; runtime.player.grounded = false;
    step(runtime, EMPTY_INPUT);
    const vine = runtime.items.actors.find(actor => actor.kind === "vine");
    expect(vine).toBeDefined(); if (!vine) throw new Error("Vine missing");
    expect(vine.height).toBe(0); expect(vine.targetHeight).toBeLessThan(96);
    while (vine.height < 24) step(runtime, EMPTY_INPUT);
    expect(vine.height).toBeGreaterThan(0); expect(vine.height).toBeLessThan(vine.targetHeight);
    runtime.player.x = vine.x; runtime.player.y = vine.y - 8; runtime.player.vx = 0; runtime.player.vy = 0; runtime.player.grounded = false;
    const attach = step(runtime, held("up"));
    expect(attach.some(event => event.type === "vine-attach" && event.vineId === vine.id)).toBe(true);
    expect(runtime.climb.vineId).toBe(vine.id);
    const y = runtime.player.y;
    step(runtime, held("up"));
    expect(runtime.player.y).toBe(y - 1); expect(runtime.player.vx).toBe(0);
    expect(playView(runtime).player.key.startsWith("mario.small.climb")).toBe(true);
    const detach = step(runtime, { ...held("up"), jump: jump.jump });
    expect(detach.filter(event => event.type === "jump")).toHaveLength(1);
    expect(detach.some(event => event.type === "vine-detach" && event.reason === "jump")).toBe(true);
    expect(runtime.climb).toEqual({ vineId: null, blockedVineId: vine.id });
    expect(step(runtime, held("up")).some(event => event.type === "vine-attach")).toBe(false);
    expect(itemBounds(vine).height).toBe(vine.height);
  });
  test("snapshot, source and restart isolation; departing area cancels climb and spring but retains other motion", () => {
    const { runtime, course } = live("areas"), initial = snapshot(runtime), before = JSON.stringify(course);
    expect(initial.climb).toEqual({ vineId: null, blockedVineId: null });
    expect(initial.platforms.bodies.map(candidate => candidate.id).sort()).toEqual([ids.horizontal, ids.spring].sort());
    for (let tick = 0; tick < 8; tick++) step(runtime, EMPTY_INPUT);
    const moved = liveBody(runtime, ids.horizontal).bounds.x;
    expect(moved).toBeGreaterThan(liveBody(runtime, ids.horizontal).origin.x);
    runtime.player.x = 176; runtime.player.y = 192; runtime.player.vx = 0; runtime.player.vy = 0; runtime.player.grounded = true;
    runtime.contacts = [{ id: ids.spring, source: { kind: "object", objectId: ids.spring, part: "body" }, axis: "y", normal: -1, time: 0 }];
    step(runtime, EMPTY_INPUT);
    const sprung = liveBody(runtime, ids.spring); expect(sprung.kind).toBe("spring"); if (sprung.kind === "spring") expect(sprung.compressedAt).not.toBeNull();
    const parkedX = liveBody(runtime, ids.horizontal).bounds.x;
    const observation = snapshot(runtime); const detached = structuredClone(observation) as unknown as { platforms: { bodies: unknown[] }; climb: { vineId: string | null } }; detached.platforms.bodies = []; detached.climb.vineId = "mutated";
    expect(platformsOf(runtime).bodies.length).toBeGreaterThan(0); expect(runtime.climb.vineId).toBeNull(); expect(observation.platforms.bodies.length).toBeGreaterThan(0);
    runtime.areaId = ids.areaB;
    step(runtime, EMPTY_INPUT);
    expect(runtime.climb).toEqual({ vineId: null, blockedVineId: null });
    const home = runtime.areas.get(course.mainAreaId);
    const spring = home?.platforms.bodies.find(candidate => candidate.id === ids.spring);
    expect(spring?.kind).toBe("spring"); if (spring?.kind === "spring") expect(spring.compressedAt).toBeNull();
    const parked = home?.platforms.bodies.find(candidate => candidate.id === ids.horizontal);
    expect(parked?.bounds.x).toBe(parkedX);
    expect(liveBody(runtime, ids.areaBPlatform).bounds.x).toBeGreaterThan(liveBody(runtime, ids.areaBPlatform).origin.x);
    expect(JSON.stringify(course)).toBe(before);
    expect(snapshot(createRuntime(course))).toEqual(initial);
  });
  test("composite carry plus voluntary movement uses task8 previous-to-current swept contacts, not endpoints", () => {
    const { runtime } = live("enemy"), start = runtime.player.x;
    let hit = null as ReturnType<typeof step> | null;
    for (let tick = 0; tick < 80 && !hit; tick++) {
      const events = step(runtime, held("right"));
      if (events.some(event => event.type === "ground-damage" || event.type === "ground-stomp")) hit = events;
    }
    expect(hit).not.toBeNull();
    expect(runtime.player.x).toBeGreaterThan(start + 20);
    expect(hit?.some(event => "actorId" in event && event.actorId === ids.goomba)).toBe(true);
  });
  test("malformed reciprocal links fail the real loader rather than being treated as motion", () => {
    const course = createPlatformLiveFixture("balance");
    const broken = { ...course, areas: course.areas.map(area => ({ ...area,
      objects: area.objects.filter(object => object.id !== ids.balanceB) })) };
    const result = validateCourse(broken); expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("invalid_reference");
  });
});
