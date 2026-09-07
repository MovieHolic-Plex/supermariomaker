# Movement runtime: task 6 integration contract

This is the `maker-smb1-v1` movement layer and a temporary movement lab, not a complete game.

## Authoritative API

- `createRuntime(course, spawnOverride?)` validates small-player spawn clearance, copies the validated authored course, creates sparse runtime terrain, and starts tick 0 with seed `0x534d4231`. The host owns the explicit goal-free test permission. The engine never writes to its caller's `CourseV1`.
- `step(runtime, inputFrame): GameEvent[]` advances exactly one active 60 Hz tick. No DOM, audio, storage, random clock, renderer or RAF is consulted. Input/player intent precedes swept X then Y terrain movement. The documented insertion points for actor intent, interactions, end-of-tick queued changes, and terminal conditions are in `step.ts`; they deliberately contain no fake feature implementations.
- `snapshot(runtime)` returns detached, serializable tick/seed/area/player/contacts observations. It is not an authoring document or a setter. `currentArea(runtime)` resolves the active runtime area, not necessarily the course's main area.
- `RuntimeArea.source` is immutable authored metadata/static layout from the private copy. `RuntimeArea.tiles` is the live terrain Map, keyed by `y * source.width + x`. Block owners replace/delete runtime cells there, never in `source.tiles` or `runtime.course`. Future actor/platform owners integrate their actual state through this shared runtime rather than defining a second course/player model.

## Coordinates, collision and tuning

Player x/y are bottom-center pixels; vx/vy are pixels per tick, not per second. Positions snap to 1/256 after each axis integration; velocities retain the profile's decimal precision. Small/tall/crouched colliders are 12x15 / 12x31 / 12x15. A blocked tall expansion retains crouch without moving the feet. Forms are present for these collider contracts; this task has no power-up acquisition or browser form setter.

Horizontal intent uses 0.12 acceleration, 0.20 reversal braking, 0.10 neutral friction, and 1.6/2.8 walk/run caps. Jump begins at -5.2, then gravity applies in that same tick: 0.20 for at most 18 held rising ticks, otherwise 0.42. Release clamps upward vy to -2 before gravity. Fall cap is 6. No coyote time, buffered jump or held-key autojump.

`playerBounds`, `sweepAxis`, `hasSolidOverlap`, and `colliders` are the shared terrain contact primitives. Sweep tests the entire displacement using a sparse tile broadphase. Contacts contain stable ID, source (`tile`, `object` body/bridge, or area `boundary`), axis, outward normal and normalized axis time. Every equal-time contact is retained and sorted by ID; event order is all X contacts, then all Y contacts. IDs for cells include area/y/x and do not change with tile kind. Coin is intangible; hidden terrain contacts only a sweep from below, without revealing it yet. Static catalog solid bodies/bridges participate; motion is task 9. Left/right/top area limits are solid. The bottom is not an invented floor: pit death/lives are task 14.

There are no actor updates, terrain mutations, spawns, damage or goal decisions in task 6. Their owners must preserve queued end-of-tick changes, new actors first updating next tick, stable-ID actor order, and lethal-before-goal precedence when those phases are implemented.

## Input and host lifecycle

`InputFrame` has `left/right/up/down/jump/run/pause` button records with independent `held/pressed/released` bits. `InputBuffer.key(code, down, repeat?)` aggregates physical aliases. `consume()` clears only edges and is called ONCE for each authoritative tick, never once per RAF. A tap between ticks retains both press and release; it starts then cuts a grounded jump in that tick. Repeats do not create edges. Opposite held directions neutralize in player intent.

`attachInput(canvas, pause)` captures arrows, A/D, Space/Z, Shift/X, Down/S and Escape only when that canvas is focused. Form controls retain their native keyboard behavior. Paused canvas navigation keys suppress browser page scrolling but do not latch input. Canvas focus loss clears keys. Native window blur or hidden document calls the pause callback, which clears input, cancels RAF and drops clock debt. Resume is an explicit button action: it starts with empty input and a new wall-time baseline; existing physical motion is preserved, not teleported or converted into a new jump.

`FixedClock.frame(now, tick)` uses a 60 Hz accumulator with a five-tick maximum backlog and five-tick maximum execution per frame. Excess elapsed wall time is counted as dropped milliseconds; it never skips authoritative tick numbers. `pause()` and `resume()` clear debt and baseline. Presentation uses the latest authoritative state; no interpolation feeds physics.

## Temporary real host

`/?qa=play` wraps `mountFixtureGallery` using its typed `onCourseLoaded` callback after actual file bytes pass the parser and latest-selection token. No DOM snapshot is deserialized as a game source. `/?qa=fixture` retains its default read-only behavior.

The lab provides explicit goal-free start, pause, resume, restart from the loaded original, and return to its unchanged file preview. It uses the existing pixel sprites and animation sequences with the active area's theme and a bounded 256x240 two-axis camera. `window.__qa` exists only on `qa=play`, exposing detached observations and bounded one-shot subscriptions; it has no setters. All subscriptions, listeners and RAF resources have disposal paths.

Blocks/items/forms, enemy interactions, moving platforms, underwater movement, pipes, timers/lives/endings and the normal editor-to-play flow remain with tasks 7 onward. Underwater currently selects its correct artwork/theme, not swimming physics.

## Browser evidence

`scripts/qa/movement.ts` loads a factory/serializer-produced file using the real file input and drives real keyboard actions and native RAF time. Requested jump holds are tick-event subscribed and actual consumed hold durations are recorded; exact tuning is also tested directly in unit tests. Real blur uses native Chrome tab activation, an isolated temporary profile, and Playwright's documented CDP `noDefaults` option: normal Playwright contexts force every page focused, which cannot prove this lifecycle. Native process/profile, app RAF/listener/subscription, and preview-port cleanup have separate receipts. Windows native scale is explicitly 1 for exact compositor pixel checks. PNG capture/compositor checks are not an aesthetic visual approval.
