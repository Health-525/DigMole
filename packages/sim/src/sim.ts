import { createSandbox, World } from "./world.ts";
import type { Target } from "./world.ts";
import { TaskRunner, fail } from "./task.ts";
import type { TaskGen, TaskResult } from "./task.ts";
import type { Ctx } from "./actions.ts";
import { round } from "./math.ts";

export interface TargetView {
  id: string;
  kind: Target["kind"];
  label: string;
  x: number;
  z: number;
  status: string;
}

export interface Snapshot {
  time: number;
  action: { name: string; running: boolean; lastResult: TaskResult | null };
  machine: {
    x: number;
    y: number;
    z: number;
    heading: number;
    swing: number;
    boom: number;
    stick: number;
    curl: number;
    tip: { x: number; y: number; z: number };
  };
  bucket: { load: number; capacity: number; free: number };
  targets: TargetView[];
  terrain: {
    dugTotal: number;
    raisedTotal: number;
    meanHeight: number;
    /** Coarse 4x4 height grid, row-major from -X/-Z, for cheap world awareness. */
    grid: number[][];
  };
}

const FIXED_DT = 1 / 60;

/**
 * Owns the world and the single active action.
 *
 * The simulation advances in fixed steps with no wall-clock or random input, so
 * a given sequence of actions always produces the same terrain. That is what
 * makes headless testing, replay and agent debugging possible.
 */
export class Sim {
  readonly world: World;
  readonly dt: number;
  private runner: TaskRunner | null = null;
  private activeName = "idle";
  lastResult: TaskResult | null = null;
  readonly history: { action: string; result: TaskResult; at: number }[] = [];

  constructor(world: World = createSandbox(), dt: number = FIXED_DT) {
    this.world = world;
    this.dt = dt;
  }

  get ctx(): Ctx {
    return { world: this.world, terrain: this.world.terrain, machine: this.world.machine };
  }

  get busy(): boolean {
    return this.runner !== null;
  }

  /** Advances the world by one fixed step. Safe to call from a server loop. */
  tick(dt: number = this.dt): void {
    const { machine, terrain } = this.world;
    this.world.time += dt;

    machine.baseY = terrain.sample(machine.state.x, machine.state.z);
    machine.stepDrive(dt);
    machine.stepArm(dt);
    machine.baseY = terrain.sample(machine.state.x, machine.state.z);

    const runner = this.runner;
    if (!runner) return;
    runner.step(dt);
    if (!runner.done) return;

    const name = this.activeName;
    const failure = runner.failure;
    const result = runner.outcome;
    this.runner = null;
    this.activeName = "idle";
    if (failure) throw failure;
    if (result) this.record(name, result);
  }

  private record(action: string, result: TaskResult): void {
    this.lastResult = result;
    this.history.push({ action, result, at: this.world.time });
    if (this.history.length > 200) this.history.shift();
  }

  /**
   * Starts an action without waiting for it; the caller drives it with `tick()`.
   * This is the real-time path used by the server loop.
   */
  start(name: string, gen: TaskGen): void {
    if (this.runner) throw new Error("已有动作正在运行，先等它结束");
    this.runner = new TaskRunner(gen);
    this.activeName = name;
  }

  /**
   * Runs an action to completion at full speed (no real-time pacing).
   * This is the headless path used by tests, the CLI and, later, batch replays.
   */
  run(name: string, gen: TaskGen, maxSeconds = 900): TaskResult {
    this.start(name, gen);
    const runner = this.runner;
    if (!runner) throw new Error("unreachable");

    const maxTicks = Math.ceil(maxSeconds / this.dt);
    let ticks = 0;
    while (!runner.done && ticks < maxTicks) {
      this.tick();
      ticks++;
    }

    if (runner.failure) throw runner.failure;

    if (!runner.done) {
      this.runner = null;
      this.activeName = "idle";
      const result = fail("TIMEOUT", `动作「${name}」超时（${maxSeconds}s）`);
      this.record(name, result);
      return result;
    }

    return runner.outcome ?? fail("NO_RESULT", `动作「${name}」没有返回结果`);
  }

  /** Emergency stop. Interrupts the running action where it stands. */
  abort(reason = "急停"): TaskResult {
    const runner = this.runner;
    if (!runner) return fail("IDLE", "当前没有正在执行的动作");
    const name = this.activeName;
    runner.abort(reason);
    const result = runner.outcome ?? fail("ABORTED", reason);
    this.runner = null;
    this.activeName = "idle";
    this.record(name, result);
    return result;
  }

  snapshot(): Snapshot {
    const { machine, terrain } = this.world;
    const tip = machine.tipWorld();
    const grid: number[][] = [];
    const half = 10;
    for (let row = 0; row < 4; row++) {
      const line: number[] = [];
      for (let col = 0; col < 4; col++) {
        const cx = -30 + half + col * 20;
        const cz = -30 + half + row * 20;
        line.push(round(terrain.meanIn(cx, cz, half, half), 2));
      }
      grid.push(line);
    }
    return {
      time: round(this.world.time, 2),
      action: { name: this.activeName, running: this.busy, lastResult: this.lastResult },
      machine: {
        x: round(machine.state.x, 2),
        y: round(machine.baseY, 2),
        z: round(machine.state.z, 2),
        heading: round(machine.state.heading, 3),
        swing: round(machine.state.swing, 3),
        boom: round(machine.state.boom, 3),
        stick: round(machine.state.stick, 3),
        curl: round(machine.state.curl, 3),
        tip: { x: round(tip.x, 2), y: round(tip.y, 2), z: round(tip.z, 2) },
      },
      bucket: {
        load: round(machine.state.load, 3),
        capacity: machine.cfg.capacity,
        free: round(Math.max(0, machine.cfg.capacity - machine.state.load), 3),
      },
      targets: [...this.world.targets.values()].map((t) => ({
        id: t.id,
        kind: t.kind,
        label: t.label,
        x: t.x,
        z: t.z,
        status: describeTarget(t),
      })),
      terrain: {
        dugTotal: round(terrain.totalDug, 2),
        raisedTotal: round(terrain.totalRaised, 2),
        meanHeight: round(terrain.meanIn(0, 0, 40, 40), 3),
        grid,
      },
    };
  }
}

export function describeTarget(t: Target): string {
  if (t.kind === "truck") {
    const pct = Math.round((t.filled / t.capacity) * 100);
    return t.filled >= t.capacity - 1e-3 ? "满" : `已装 ${round(t.filled, 1)}/${t.capacity} m³（${pct}%）`;
  }
  if (t.kind === "pile") return `半径约 ${t.radius} m`;
  return `目标高度 ${t.targetHeight} m`;
}
