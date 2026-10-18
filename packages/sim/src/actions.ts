import type { World } from "./world.ts";
import type { Heightfield } from "./terrain.ts";
import type { Excavator, Vec3 } from "./machine.ts";
import { advance, until, ok, fail, type Sub, type TaskGen, type TaskResult } from "./task.ts";
import { clamp, round, wrapAngle, angleDelta } from "./math.ts";

export interface Ctx {
  world: World;
  terrain: Heightfield;
  machine: Excavator;
}

/** Brush radius used when the bucket bites the ground (m). */
export const DIG_RADIUS = 0.65;
/** Peak soil intake (m³/s) — a 20 t machine fills its bucket in ~1.5 s. */
export const DIG_RATE = 0.8;
/** Pour rate (m³/s). */
export const DUMP_RATE = 1.4;
/** How far the bucket drags toward the machine during one scoop (m). */
export const STROKE_LEN = 2.4;
/** Bucket-edge approach angle during the dig stroke (rad from horizontal). */
const DIG_ANGLE_START = -1.3;
const DIG_ANGLE_END = -0.62;

function unit(fromX: number, fromZ: number, toX: number, toZ: number): { ux: number; uz: number; len: number } {
  const dx = toX - fromX;
  const dz = toZ - fromZ;
  const len = Math.hypot(dx, dz) || 1;
  return { ux: dx / len, uz: dz / len, len };
}

/** Staging position: `dist` meters from `point`, on the side the machine is already on. */
function stagingPoint(from: { x: number; z: number }, point: { x: number; z: number }, dist: number) {
  const { ux, uz } = unit(from.x, from.z, point.x, point.z);
  return { x: point.x - ux * dist, z: point.z - uz * dist };
}

function* driveToPoint(ctx: Ctx, x: number, z: number): Sub {
  const m = ctx.machine;
  m.driveTarget = { x, z };
  try {
    yield* until(() => Math.hypot(m.state.x - x, m.state.z - z) < 0.22, 90, "行驶到指定位置");
  } finally {
    m.driveTarget = null;
  }
}

/** Positions the tracks and swings the turret so the work point is in front. */
function* approach(ctx: Ctx, point: { x: number; z: number }, dist: number): Sub {
  const m = ctx.machine;
  const stage = stagingPoint(m.state, point, dist);
  yield* driveToPoint(ctx, stage.x, stage.z);

  const { ux, uz } = unit(m.state.x, m.state.z, point.x, point.z);
  const wantAz = Math.atan2(uz, ux);
  const swing = wrapAngle(wantAz - m.state.heading);
  m.setArmTargets({ swing });
  yield* until(() => Math.abs(angleDelta(m.state.swing, swing)) < 0.02, 25, "回转对位");
}

/** Moves the bucket pivot toward a world point with a given edge angle. */
function* reachBucket(ctx: Ctx, point: Vec3, bucketAbs: number): Sub {
  const m = ctx.machine;
  const sol = m.solveIK(point);
  if (!sol) return;
  m.setArmTargets({
    swing: sol.swing,
    boom: sol.boom,
    stick: sol.stick,
    curl: m.curlFor(sol.stick, bucketAbs),
  });
  yield* until(() => m.armSettled(0.03), 12, "摆臂就位");
}

/** Digs one bucketful at `point` (world), assuming the machine is already there. */
export function* scoopAt(
  ctx: Ctx,
  point: { x: number; z: number },
  options: { stroke?: number; lift?: number } = {},
): TaskGen {
  const m = ctx.machine;
  const t = ctx.terrain;
  if (m.state.load >= m.cfg.capacity - 1e-3) {
    return fail("BUCKET_FULL", `铲斗已装满（${round(m.state.load, 2)} m³），先卸料`);
  }

  const stroke = options.stroke ?? STROKE_LEN;
  const lift = options.lift ?? 1.7;
  const { ux, uz } = unit(m.state.x, m.state.z, point.x, point.z);
  const ground = t.sample(point.x, point.z);

  const startPivot = { x: point.x, y: ground + 0.95, z: point.z };
  if (!m.solveIK(startPivot)) {
    return fail("UNREACHABLE", "作业点超出挖掘机臂展范围");
  }

  m.setArmTargets({});
  yield* reachBucket(ctx, startPivot, DIG_ANGLE_START);
  if (!m.armSettled(0.06)) return fail("STUCK", "铲斗无法到达作业点（关节限位）");
  const loadBefore = m.state.load;
  const cap = m.cfg.capacity;
  const dur = 1.7;
  let elapsed = 0;
  let dugHere = 0;

  while (elapsed < dur) {
    const dt: number = yield;
    elapsed += dt;
    const k = clamp(elapsed / dur, 0, 1);
    const px = startPivot.x - ux * stroke * k;
    const pz = startPivot.z - uz * stroke * k;
    // Keep the cutting edge just under the surface as the ground drops away.
    const py = t.sample(px, pz) + 1.02;
    const edge = DIG_ANGLE_START + (DIG_ANGLE_END - DIG_ANGLE_START) * k;
    const sol = m.solveIK({ x: px, y: py, z: pz });
    if (sol) {
      m.setArmTargets({
        swing: sol.swing,
        boom: sol.boom,
        stick: sol.stick,
        curl: m.curlFor(sol.stick, edge),
      });
    }

    const tip = m.tipWorld();
    const groundHere = t.sample(tip.x, tip.z);
    const room = cap - m.state.load;
    if (room > 1e-4 && tip.y <= groundHere + 0.14) {
      const allowed = Math.min(DIG_RATE * dt, room);
      // Mean lowering of a smoothstep brush of radius R is depth/2, hence the factor 2.
      const depth = (2 * allowed) / (Math.PI * DIG_RADIUS * DIG_RADIUS);
      const res = t.dig(tip.x, tip.z, DIG_RADIUS, depth);
      m.state.load = Math.min(cap, m.state.load + res.removed);
      dugHere += res.removed;
    }
  }

  // Curl and lift the loaded bucket.
  const carry = { x: startPivot.x - ux * stroke * 0.5, y: ground + lift, z: startPivot.z - uz * stroke * 0.5 };
  const solC = m.solveIK(carry);
  if (solC) {
    m.setArmTargets({
      swing: solC.swing,
      boom: solC.boom,
      stick: solC.stick,
      curl: m.curlFor(solC.stick, -0.95),
    });
    yield* until(() => m.armSettled(0.05), 8, "抬斗");
  }

  const gained = m.state.load - loadBefore;
  if (gained < 0.08) {
    return fail("DUG_NOTHING", `没挖到料（${round(gained, 2)} m³），换个位置或加深`);
  }
  return ok(`挖了 ${round(gained, 2)} m³`, {
    loaded: round(m.state.load, 2),
    gained: round(gained, 2),
    groundDrop: round(dugHere / Math.max(0.01, Math.PI * DIG_RADIUS * DIG_RADIUS), 2),
  });
}

/** Pours the bucket out at a world point, either into a truck or onto the ground. */
export function* pourAt(
  ctx: Ctx,
  point: { x: number; z: number },
  options: { height?: number; truck?: { capacity: number; filled: number } } = {},
): TaskGen {
  const m = ctx.machine;
  const t = ctx.terrain;
  if (m.state.load <= 1e-3) return fail("BUCKET_EMPTY", "铲斗是空的，没东西可卸");

  const height = options.height ?? 2.6;
  const goal = { x: point.x, y: t.sample(point.x, point.z) + height, z: point.z };
  if (!m.solveIK(goal)) return fail("UNREACHABLE", "卸料点超出臂展范围");

  yield* reachBucket(ctx, goal, 0.12);
  if (!m.armSettled(0.08)) return fail("STUCK", "铲斗无法摆到卸料点（关节限位）");

  const before = m.state.load;
  let poured = 0;
  while (m.state.load > 1e-3) {
    const dt: number = yield;
    let amount = Math.min(DUMP_RATE * dt, m.state.load);
    if (options.truck) {
      const room = Math.max(0, options.truck.capacity - options.truck.filled);
      amount = Math.min(amount, room);
      if (amount <= 0) break;
      options.truck.filled += amount;
    } else {
      t.raise(point.x, point.z, amount, 1.15);
    }
    m.state.load -= amount;
    poured += amount;
  }

  if (poured < 0.05) return fail("NO_ROOM", "卸料点装不下了");
  return ok(`卸了 ${round(poured, 2)} m³`, { poured: round(poured, 2), remaining: round(m.state.load, 3) });
}

export interface ScoopArgs {
  targetId: string;
  depth?: number;
  stroke?: number;
}

/** Drive up to a heap, take one bucketful, carry it clear. */
export function* scoopTarget(ctx: Ctx, args: ScoopArgs): TaskGen {
  const m = ctx.machine;
  const pile = ctx.world.pile(args.targetId);
  if (!pile) return fail("NO_TARGET", `找不到土堆「${args.targetId}」`);
  if (m.state.load >= m.cfg.capacity - 1e-3) {
    return fail("BUCKET_FULL", `铲斗已装满（${round(m.state.load, 2)} m³），先卸料`);
  }

  const { ux, uz } = unit(m.state.x, m.state.z, pile.x, pile.z);
  const digPoint = { x: pile.x - ux * pile.radius * 0.5, z: pile.z - uz * pile.radius * 0.5 };
  yield* approach(ctx, digPoint, 6.0);

  return yield* scoopAt(ctx, digPoint, { stroke: args.stroke });
}

export interface DumpArgs {
  targetId: string;
}

/** Carry the load to a hauler or a spot and empty it. */
export function* dumpToTarget(ctx: Ctx, args: DumpArgs): TaskGen {
  const m = ctx.machine;
  const target = ctx.world.target(args.targetId);
  if (!target) return fail("NO_TARGET", `找不到目标「${args.targetId}」`);
  if (m.state.load <= 1e-3) return fail("BUCKET_EMPTY", "铲斗是空的，没东西可卸");

  if (target.kind === "truck") {
    if (target.filled >= target.capacity - 1e-3) {
      return fail("TRUCK_FULL", `「${target.label}」已经装满了`);
    }
    yield* approach(ctx, target, 7.2);
    return yield* pourAt(ctx, target, { height: target.bedHeight + 1.6, truck: target });
  }

  if (target.kind === "pile") {
    yield* approach(ctx, target, 6.0);
    return yield* pourAt(ctx, target, { height: 3.2 });
  }

  yield* approach(ctx, target, 6.0);
  return yield* pourAt(ctx, target, { height: 3.0 });
}

/** Free driving, used by the manual remote and by the agent. */
export function* driveTo(ctx: Ctx, x: number, z: number): TaskGen {
  const m = ctx.machine;
  const from = { x: m.state.x, z: m.state.z };
  yield* driveToPoint(ctx, x, z);
  const moved = Math.hypot(m.state.x - from.x, m.state.z - from.z);
  if (moved < 0.15) return fail("BLOCKED", "没能移动，位置被卡住了");
  return ok(`行驶到 (${round(m.state.x, 1)}, ${round(m.state.z, 1)})`, {
    x: round(m.state.x, 2),
    z: round(m.state.z, 2),
    moved: round(moved, 2),
  });
}

export interface LevelArgs {
  zoneId: string;
  tolerance?: number;
  maxPasses?: number;
}

/** Grades a rectangular pad by cutting its high spots and filling its low spots. */
export function* levelZone(ctx: Ctx, args: LevelArgs): TaskGen {
  const zone = ctx.world.zone(args.zoneId);
  if (!zone) return fail("NO_TARGET", `找不到区域「${args.zoneId}」`);
  const tol = args.tolerance ?? 0.25;
  const maxPasses = args.maxPasses ?? 6;
  const m = ctx.machine;
  const before = ctx.terrain.roughness(zone.x, zone.z, zone.halfW, zone.halfD);
  let passes = 0;
  let cut = 0;

  while (passes < maxPasses) {
    const rough = ctx.terrain.roughness(zone.x, zone.z, zone.halfW, zone.halfD);
    if (rough <= tol) break;
    const { min, max } = ctx.terrain.extremeIn(zone.x, zone.z, zone.halfW, zone.halfD);
    if (max.h - min.h <= tol) break;

    // Drop whatever is already in the bucket at the low spot first.
    if (m.state.load > 0.05) {
      yield* approach(ctx, min, 5.6);
      yield* pourAt(ctx, min, { height: 2.4 });
    }

    yield* approach(ctx, max, 5.6);
    const scooped = yield* scoopAt(ctx, max, { stroke: STROKE_LEN * 0.8 });
    if (!scooped.ok) {
      if (scooped.code === "UNREACHABLE" || scooped.code === "DUG_NOTHING") break;
      return scooped;
    }
    cut += Number(scooped.data?.gained ?? 0);

    const low = ctx.terrain.extremeIn(zone.x, zone.z, zone.halfW, zone.halfD).min;
    yield* approach(ctx, low, 5.6);
    yield* pourAt(ctx, low, { height: 2.4 });
    passes++;
  }

  const after = ctx.terrain.roughness(zone.x, zone.z, zone.halfW, zone.halfD);
  const okNow = after <= tol;
  return okNow
    ? ok(`平整完成：起伏 ${round(before, 2)} → ${round(after, 2)} m`, {
        passes,
        cut: round(cut, 2),
        roughness: round(after, 2),
      })
    : fail("NOT_FLAT_ENOUGH", `整了 ${passes} 遍仍不够平：起伏 ${round(after, 2)} m（目标 ≤ ${tol}）`);
}
