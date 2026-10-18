/** Small, dependency-free math helpers. Kept free of Node/DOM APIs so this package runs anywhere. */

export const TAU = Math.PI * 2;

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Maps t in [0,1] to a smooth 0..1 ramp. */
export function smoothstep(t: number): number {
  const x = clamp(t, 0, 1);
  return x * x * (3 - 2 * x);
}

/** Wraps an angle into (-PI, PI]. */
export function wrapAngle(a: number): number {
  let x = (a + Math.PI) % TAU;
  if (x <= 0) x += TAU;
  return x - Math.PI;
}

/** Shortest signed delta that takes `from` to `to`. */
export function angleDelta(from: number, to: number): number {
  return wrapAngle(to - from);
}

/** Moves a scalar toward a target by at most `maxStep`. */
export function moveTowards(current: number, target: number, maxStep: number): number {
  const d = target - current;
  if (Math.abs(d) <= maxStep) return target;
  return current + Math.sign(d) * maxStep;
}

/** Moves an angle toward a target along the shortest arc, by at most `maxStep`. */
export function moveAngleTowards(current: number, target: number, maxStep: number): number {
  const d = angleDelta(current, target);
  if (Math.abs(d) <= maxStep) return current + d;
  return current + Math.sign(d) * maxStep;
}

export function hypot2(a: number, b: number): number {
  return Math.sqrt(a * a + b * b);
}

export function dist2(ax: number, az: number, bx: number, bz: number): number {
  return hypot2(ax - bx, az - bz);
}

/** Rounds for display; keeps numbers readable in logs and tool output. */
export function round(v: number, digits = 3): number {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}
