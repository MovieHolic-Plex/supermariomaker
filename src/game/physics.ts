/** Original-like profile, not extracted NES physics. Units: pixels and active 60Hz ticks. */
export const PHYSICS = {
  name: "maker-smb1-v1", hz: 60, snap: 256,
  acceleration: 0.12, reversal: 0.20, friction: 0.10, walkCap: 1.6, runCap: 2.8,
  jump: -5.2, heldGravity: 0.20, heldTicks: 18, gravity: 0.42, fallCap: 6, releaseClamp: -2,
  width: 12, smallHeight: 15, tallHeight: 31,
} as const;
export const snapPosition = (value: number): number => Math.round(value * PHYSICS.snap) / PHYSICS.snap;
