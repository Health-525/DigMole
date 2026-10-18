import { clamp, moveAngleTowards, moveTowards, angleDelta } from "./math.ts";

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface MachineConfig {
  /** Boom length, pivot to elbow (m). */
  boomLength: number;
  /** Stick (arm) length, elbow to bucket pivot (m). */
  stickLength: number;
  /** Bucket length, pivot to cutting edge (m). */
  bucketLength: number;
  /** Bucket width (m). */
  bucketWidth: number;
  /** Boom pivot height above the tracks (m). */
  pivotHeight: number;
  /** Bucket capacity (m³). */
  capacity: number;
  /** Track speed (m/s). */
  walkSpeed: number;
  /** Turn rate (rad/s). */
  turnRate: number;
  /** Swing rate (rad/s). */
  swingRate: number;
  boomRate: number;
  stickRate: number;
  bucketRate: number;
  boomLimits: readonly [number, number];
  stickLimits: readonly [number, number];
  /** Relative curl between stick direction and bucket direction (rad). */
  curlLimits: readonly [number, number];
}

export const DEFAULT_MACHINE: MachineConfig = {
  boomLength: 5.7,
  stickLength: 2.9,
  bucketLength: 1.2,
  bucketWidth: 1.2,
  pivotHeight: 1.55,
  capacity: 1.0,
  walkSpeed: 3.2,
  turnRate: 0.9,
  swingRate: 1.1,
  boomRate: 0.8,
  stickRate: 1.0,
  bucketRate: 1.6,
  boomLimits: [-0.15, 1.25],
  stickLimits: [-2.55, 0.55],
  curlLimits: [-2.5, 0.35],
};

export interface MachineState {
  x: number;
  z: number;
  /** Turret/base heading in world XZ (rad, 0 = +X). */
  heading: number;
  /** Turret swing relative to the tracks (rad). */
  swing: number;
  /** Boom angle from horizontal (rad), in the arm plane. */
  boom: number;
  /** Stick angle from horizontal (rad). */
  stick: number;
  /** Bucket curl relative to the stick (rad). */
  curl: number;
  /** Material currently in the bucket (m³). */
  load: number;
}

export interface JointTargets {
  swing?: number;
  boom?: number;
  stick?: number;
  curl?: number;
}

/** Result of an inverse-kinematics solve, in joint space. */
export interface ArmSolution {
  swing: number;
  boom: number;
  stick: number;
}

/**
 * A kinematic excavator.
 *
 * There is deliberately no rigid-body physics here: joint angles are driven at
 * bounded rates toward targets, which is both stable and how these machines
 * actually feel. Everything is deterministic given the same inputs.
 */
export class Excavator {
  readonly cfg: MachineConfig;
  readonly state: MachineState;
  /** Height of the ground under the tracks (updated every step). */
  baseY = 0;

  /** Joint-space goals. `null` means "hold current". */
  private target: Required<JointTargets> | null = null;
  /** World position the tracks are driving toward, or null. */
  driveTarget: { x: number; z: number } | null = null;

  constructor(cfg: MachineConfig = DEFAULT_MACHINE, start?: Partial<MachineState>) {
    this.cfg = cfg;
    this.state = {
      x: start?.x ?? 0,
      z: start?.z ?? 0,
      heading: start?.heading ?? 0,
      swing: start?.swing ?? 0,
      boom: start?.boom ?? 0.6,
      stick: start?.stick ?? -1.4,
      curl: start?.curl ?? -1.2,
      load: start?.load ?? 0,
    };
  }

  /** Absolute bucket direction angle in the arm plane. */
  get bucketAbs(): number {
    return this.state.stick + this.state.curl;
  }

  /** Turret azimuth in world space. */
  get armAzimuth(): number {
    return this.state.heading + this.state.swing;
  }

  /** Boom pivot in world space. */
  pivotWorld(): Vec3 {
    return { x: this.state.x, y: this.baseY + this.cfg.pivotHeight, z: this.state.z };
  }

  /** Converts arm-plane coordinates (outward distance, height) to world space. */
  planeToWorld(r: number, y: number): Vec3 {
    const az = this.armAzimuth;
    return {
      x: this.state.x + r * Math.cos(az),
      y: this.baseY + y,
      z: this.state.z + r * Math.sin(az),
    };
  }

  /** Bucket pivot (elbow end of the stick) in world space. */
  bucketPivotWorld(): Vec3 {
    const p = this.pivotWorld();
    const az = this.armAzimuth;
    const e = this.bucketPivotPlane();
    return {
      x: p.x + e.r * Math.cos(az),
      y: this.baseY + e.y,
      z: p.z + e.r * Math.sin(az),
    };
  }

  /** Cutting edge (bucket tip) in world space. */
  tipWorld(): Vec3 {
    const b = this.bucketPivotWorld();
    const a = this.bucketAbs;
    const az = this.armAzimuth;
    return {
      x: b.x + this.cfg.bucketLength * Math.cos(a) * Math.cos(az),
      y: b.y + this.cfg.bucketLength * Math.sin(a),
      z: b.z + this.cfg.bucketLength * Math.cos(a) * Math.sin(az),
    };
  }

  /** Elbow position in arm-plane coordinates. */
  elbowPlane(): { r: number; y: number } {
    const { boomLength } = this.cfg;
    return {
      r: boomLength * Math.cos(this.state.boom),
      y: this.cfg.pivotHeight + boomLength * Math.sin(this.state.boom),
    };
  }

  /** Bucket pivot (end of the stick) in arm-plane coordinates. */
  bucketPivotPlane(): { r: number; y: number } {
    const e = this.elbowPlane();
    return {
      r: e.r + this.cfg.stickLength * Math.cos(this.state.stick),
      y: e.y + this.cfg.stickLength * Math.sin(this.state.stick),
    };
  }

  /**
   * Bucket curl that realizes an absolute bucket angle for a given stick angle.
   * Clamped to the joint range, so the caller may get a flatter bucket than asked
   * for — which is exactly what a real machine does at the end of its stroke.
   */
  curlFor(stickAngle: number, absAngle: number): number {
    const [lo, hi] = this.cfg.curlLimits;
    return clamp(absAngle - stickAngle, lo, hi);
  }

  /**
   * Two-link inverse kinematics for the bucket pivot.
   * Returns joint values placing the bucket pivot at `target`, or null when the
   * point is outside the working envelope and could not be reached even after clamping.
   */
  solveIK(target: Vec3): ArmSolution | null {
    const dx = target.x - this.state.x;
    const dz = target.z - this.state.z;
    const r = Math.hypot(dx, dz);
    const y = target.y - this.baseY;
    const L1 = this.cfg.boomLength;
    const L2 = this.cfg.stickLength;
    const dr = r;
    const dy = y - this.cfg.pivotHeight;

    const reach = Math.hypot(dr, dy);
    const minReach = Math.abs(L1 - L2) + 0.08;
    const maxReach = L1 + L2 - 0.02;
    if (reach < 1e-6) return null;
    if (reach > maxReach + 0.5 || reach < minReach - 0.5) return null;

    const d = clamp(reach, minReach, maxReach);
    const alpha = Math.atan2(dy, dr);
    const cosBeta = clamp((L1 * L1 + d * d - L2 * L2) / (2 * L1 * d), -1, 1);
    const beta = Math.acos(cosBeta);
    const cosGamma = clamp((L1 * L1 + L2 * L2 - d * d) / (2 * L1 * L2), -1, 1);
    const gamma = Math.acos(cosGamma);

    const boomUp = alpha + beta;
    const boomDown = alpha - beta;

    // Pick the branch that keeps the elbow above the stick — the "knuckle up"
    // posture real excavators work in — and that is closest to the current pose.
    const stickUp = boomUp - (Math.PI - gamma);
    const stickDown = boomDown + (Math.PI - gamma);
    const costUp = Math.abs(angleDelta(this.state.boom, boomUp)) + Math.abs(angleDelta(this.state.stick, stickUp));
    const costDown =
      Math.abs(angleDelta(this.state.boom, boomDown)) + Math.abs(angleDelta(this.state.stick, stickDown));
    const useUp = costUp <= costDown;

    return {
      swing: Math.atan2(dz, dx) - this.state.heading,
      boom: useUp ? boomUp : boomDown,
      stick: useUp ? stickUp : stickDown,
    };
  }

  setArmTargets(t: JointTargets): void {
    this.target = {
      swing: t.swing ?? this.target?.swing ?? this.state.swing,
      boom: t.boom ?? this.target?.boom ?? this.state.boom,
      stick: t.stick ?? this.target?.stick ?? this.state.stick,
      curl: t.curl ?? this.target?.curl ?? this.state.curl,
    };
  }

  clearArmTargets(): void {
    this.target = null;
  }

  /** Moves the arm toward the current targets. Call once per fixed step. */
  stepArm(dt: number): void {
    const t = this.target;
    if (!t) return;
    const s = this.state;
    const cfg = this.cfg;
    s.swing = moveAngleTowards(s.swing, t.swing, cfg.swingRate * dt);
    s.boom = moveTowards(clamp(s.boom, cfg.boomLimits[0], cfg.boomLimits[1]), t.boom, cfg.boomRate * dt);
    s.stick = moveTowards(clamp(s.stick, cfg.stickLimits[0], cfg.stickLimits[1]), t.stick, cfg.stickRate * dt);
    s.curl = moveTowards(clamp(s.curl, cfg.curlLimits[0], cfg.curlLimits[1]), t.curl, cfg.bucketRate * dt);
  }

  /** True when every joint is within `tol` of its target. */
  armSettled(tol = 0.02): boolean {
    const t = this.target;
    if (!t) return true;
    const s = this.state;
    return (
      Math.abs(angleDelta(s.swing, t.swing)) <= tol &&
      Math.abs(s.boom - t.boom) <= tol &&
      Math.abs(s.stick - t.stick) <= tol &&
      Math.abs(s.curl - t.curl) <= tol
    );
  }

  /** Drives the tracks toward `driveTarget`. Call once per fixed step. */
  stepDrive(dt: number): void {
    const goal = this.driveTarget;
    if (!goal) return;
    const s = this.state;
    const dx = goal.x - s.x;
    const dz = goal.z - s.z;
    const dist = Math.hypot(dx, dz);
    if (dist < 0.05) {
      s.x = goal.x;
      s.z = goal.z;
      return;
    }
    const want = Math.atan2(dz, dx);
    const delta = angleDelta(s.heading, want);
    const step = this.cfg.turnRate * dt;
    if (Math.abs(delta) > 0.35) {
      // Turn in place first, like a tracked machine.
      s.heading += Math.sign(delta) * Math.min(step, Math.abs(delta));
      return;
    }
    s.heading += Math.sign(delta) * Math.min(step, Math.abs(delta));
    const travel = Math.min(this.cfg.walkSpeed * dt, dist);
    s.x += Math.cos(s.heading) * travel;
    s.z += Math.sin(s.heading) * travel;
  }
}
