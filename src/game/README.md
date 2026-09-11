# Movement, blocks and ground combat runtime: tasks 6-8 integration contract

This is the `maker-smb1-v1` movement layer and a temporary movement lab, not a complete game.

## Authoritative API

- `createRuntime(course, spawnOverride?)` validates small-player spawn clearance, copies the validated authored course, creates sparse runtime terrain, and starts tick 0 with seed `0x534d4231`. The host owns the explicit goal-free test permission. The engine never writes to its caller's `CourseV1`.
- `step(runtime, inputFrame): GameEvent[]` advances exactly one active 60 Hz tick. No DOM, audio, storage, random clock, renderer or RAF is consulted. Input/player intent precedes swept X then Y terrain movement. The documented insertion points for actor intent, interactions, end-of-tick queued changes, and terminal conditions are in `step.ts`; they deliberately contain no fake feature implementations.
- `snapshot(runtime)` returns detached, serializable tick/seed/area/player/contacts, runtime areas/tiles, progress, combat, blocks and items observations. It is not an authoring document or a setter. `currentArea(runtime)` resolves the active runtime area, not necessarily the course's main area.
- `RuntimeArea.source` is immutable authored metadata/static layout from the private copy. `RuntimeArea.tiles` is the live terrain Map, keyed by `y * source.width + x`. Block owners replace/delete runtime cells there, never in `source.tiles` or `runtime.course`. Future actor/platform owners integrate their actual state through this shared runtime rather than defining a second course/player model.

## Coordinates, collision and tuning

Player x/y are bottom-center pixels; vx/vy are pixels per tick, not per second. Positions snap to 1/256 after each axis integration; velocities retain the profile's decimal precision. Small/tall/crouched colliders are 12x15 / 12x31 / 12x15. A blocked tall expansion retains crouch without moving the feet. Real question/brick/hidden powerups now grant forms; there is no browser form setter.

Horizontal intent uses 0.12 acceleration, 0.20 reversal braking, 0.10 neutral friction, and 1.6/2.8 walk/run caps. Jump begins at -5.2, then gravity applies in that same tick: 0.20 for at most 18 held rising ticks, otherwise 0.42. Release clamps upward vy to -2 before gravity. Fall cap is 6. No coyote time, buffered jump or held-key autojump.

`playerBounds`, `sweepAxis`, `hasSolidOverlap`, and `colliders` are the shared terrain contact primitives. Sweep tests the entire displacement using a sparse tile broadphase. Contacts contain stable ID, source (`tile`, `object` body/bridge, or area `boundary`), axis, outward normal and normalized axis time. Every equal-time contact is retained and sorted by ID; event order is all X contacts, then all Y contacts. IDs for cells include area/y/x and do not change with tile kind. Coin is intangible and collected on overlap; hidden terrain contacts only a sweep from below, revealing it through the block interaction phase. Static catalog solid bodies/bridges participate; motion is task 9. Left/right/top area limits are solid. The bottom is not an invented floor: pit death/lives are task 14.

## Blocks, items and progression (task 7)

`Runtime.progress` starts at lives 3, score/coins 0. `Runtime.combat` explicitly stores starTicks, invulnerabilityTicks and defeated. `Runtime.blocks` stores per-stable-cell multiCoin remainder and queued tile replacements/deletions. `Runtime.items` stores actors, pending spawns and a monotonic ID counter. No feature state is hidden in closures or attached to authored objects.

Blocks and items use the shared phase order documented below under Ground combat. A spawned item is age 0 at tick T end and first updates at T+1. All equal-time contacts and actor updates use stable IDs. Course/source terrain never changes. MultiCoin grants exactly ten total, including revealed hidden containers; final hit changes to used. Empty questions/hidden become used; small only bumps an empty brick, super/fire break it for block score. All seven contents work in all three container kinds; powerup adapts at the hit, not later collection.

Minor item motion defaults (not NES-exact claims): mushroom/1UP/star emerge upward at 1px/tick for 16 ticks with collection disabled; mushroom/1UP then walk right at 0.6px/tick, reverse on walls, gravity .42/fall cap6. Star walks at .6, gravity .2, floor bounce -3.4/fall cap6. Flower stays at its fully emerged position. Pickups are 14x14 bottom-center colliders. They persist outside the camera, removed below the area; area-inactive items suspend. Vine grows upward 1px/tick, at most96px, clipped by solid headroom at spawn; its y is base and height is current extent, width8. `itemBounds(vine)` exposes the actual climb region for task9; growth/art are real now, climbing is not implemented here.

Fire uses a run/fire rising edge only in fire form, max2 live or queued player fireballs (across areas). Fireballs are 8x8, spawn beside the facing hand, vx +/-3/vy -1, gravity .2, floor bounce -2.5, expire on update180. Side/ceiling/embedded-solid contact removes them, as do area/256px-camera-margin escape. Queueing a projectile cannot make it update or attack in the same tick. Ground fire collisions use the actual runtime projectiles, not phantom targets.

`player.ts` owns the sole `SCORE` table (coin200, block50, powerup1000, chain100/200/400/800/1000/2000/4000/8000 then life, goal5000). Coins wrap at100 and grant a life; 1UP grants a life with no extra score; mushroom/flower/star grant powerup score. `awardScore`, `awardChain` (zero-based kill index) and `grantLife` are typed later-enemy/goal seams; those owners control chain reset. Growth keeps feet anchored and crouches if tall clearance is blocked. Mushroom never downgrades an existing fire form; flower grants fire. Star pickup grants/resets600 active ticks; normal damage grants120 immunity ticks. Tick-start decrement means a pickup/hit on T retains its full duration at T end.

`damagePlayer(runtime, {sourceId,kind}, events)` returns ignored/shrunk/defeated. Contact/projectile damage obeys star/immunity, fire->super->small->defeated. Crush/pit/timeout bypass protection. Defeat marks once and emits `playerDefeated`; it does not prematurely consume a life or invent timed death/retry UI. `removeItem(runtime,id,"combat",events)` consumes a projectile in ground combat. Feature events, including `GroundEvent`, compose `GameEvent`. No inflight platform module is imported. Later owners must preserve queued changes, stable order and lethal-before-goal precedence.

## Ground combat (task 8)

`Runtime.ground` is the sole live GroundState, constructed from private area copies and recreated on restart. `snapshot` additionally exposes detached ground actors as an array and the stomp chain. `step` alone calls ground motion/contact phases; callers must not manually resolve the same actor a second time. `runtimeViewport` is the shared logical camera for activation and play presentation: activate within64px, suspend outside128px, preserve inactive-area state and shell age. No second simulation clock, score table or persisted schema exists.

Shared phase order: preserve previous player/projectile bounds BEFORE intent, decrement combat timers, player intent/fire queue, existing item/ground movement, player terrain sweep, ground combat, block contacts/pickups, queued terrain/items commit. Damage wins over simultaneous pickup/growth. Defeat freezes subsequent step calls until the host recreates the runtime; later contact cannot rebound or collect. Timed death, life consumption and retry remain task14.

Goomba/Buzzy patrol at .6; green Koopa falls at ledges while red probes next leading-foot support. Paratroopa uses authored hop/vertical motion; first stomp removes wings. Koopa/Buzzy stomp creates an idle shell. Kicks start4px motion on the following tick, protect the kicker for K..K+7, and can hurt at K+8. Shell victim chains persist through wall reversals and reset on stop/kick. Idle shells warn at480..599 active updates and wake at600, moving in the restored form next tick.

Ground events carry one-based chains. Only `step` translates `chain - 1` into central `awardChain`, once per stomp/defeat, never for fireball-contact or kick notifications. Star/invulnerability come from real combat timers. Actual surviving fireball sweeps are consumed even when Buzzy survives; newborn fireballs cannot attack. Core interaction order is fireballs, existing shell pairs, player, deferred wake/form replacements; a successful stomp invalidates the remaining falling trajectory.

Only play rendering removes authored ground sprites and replaces them with live walk/wing/shell/warning forms. Diagnostic/editor previews remain complete. Stomped Goombas retain their squashed sprite until restart; other defeats disappear. Warning wiggle is presentation-only. The lab shows a death sprite/message on defeat and offers its real restart button; this is not task14's timed life/retry flow.

## Input and host lifecycle

`InputFrame` has `left/right/up/down/jump/run/pause` button records with independent `held/pressed/released` bits. `InputBuffer.key(code, down, repeat?)` aggregates physical aliases. `consume()` clears only edges and is called ONCE for each authoritative tick, never once per RAF. A tap between ticks retains both press and release; it starts then cuts a grounded jump in that tick. Repeats do not create edges. Opposite held directions neutralize in player intent.

`attachInput(canvas, pause)` captures arrows, A/D, Space/Z, Shift/X, Down/S and Escape only when that canvas is focused. Form controls retain their native keyboard behavior. Paused canvas navigation keys suppress browser page scrolling but do not latch input. Canvas focus loss clears keys. Native window blur or hidden document calls the pause callback, which clears input, cancels RAF and drops clock debt. Resume is an explicit button action: it starts with empty input and a new wall-time baseline; existing physical motion is preserved, not teleported or converted into a new jump.

`FixedClock.frame(now, tick)` uses a 60 Hz accumulator with a five-tick maximum backlog and five-tick maximum execution per frame. Excess elapsed wall time is counted as dropped milliseconds; it never skips authoritative tick numbers. `pause()` and `resume()` clear debt and baseline. Presentation uses the latest authoritative state; no interpolation feeds physics.

## Temporary real host

`/?qa=play` wraps `mountFixtureGallery` using its typed `onCourseLoaded` callback after actual file bytes pass the parser and latest-selection token. No DOM snapshot is deserialized as a game source. `/?qa=fixture` retains its default read-only behavior.

The lab provides explicit goal-free start, pause, resume, restart from the loaded original, and return to its unchanged file preview. It uses the existing pixel sprites and animation sequences with the active area's theme and a bounded 256x240 two-axis camera. `window.__qa` exists only on `qa=play`, exposing detached observations and bounded one-shot subscriptions; it has no setters. All subscriptions, listeners and RAF resources have disposal paths.

The lab renders actual runtime block changes, pickups, vines, forms, star cycling, immunity flashing, fireballs and ground combat, and reports real score/coins/lives/form/star ticks. Special enemies, moving platforms/climbing, underwater movement, pipes, timers/life/retry/endings and the normal editor-to-play flow remain with later tasks. Audio event mapping is task22; no sound or damage/powerup test button is fabricated. Underwater currently selects its correct artwork/theme, not swimming physics.

## Browser evidence

`scripts/qa/movement.ts` loads a factory/serializer-produced file using the real file input and drives real keyboard actions and native RAF time. Requested jump holds are tick-event subscribed and actual consumed hold durations are recorded; exact tuning is also tested directly in unit tests. Real blur uses native Chrome tab activation, an isolated temporary profile, and Playwright's documented CDP `noDefaults` option: normal Playwright contexts force every page focused, which cannot prove this lifecycle. Native process/profile, app RAF/listener/subscription, and preview-port cleanup have separate receipts. Windows native scale is explicitly 1 for exact compositor pixel checks. PNG capture/compositor checks are not an aesthetic visual approval.
