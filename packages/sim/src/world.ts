import { Heightfield, DEFAULT_TERRAIN } from "./terrain.ts";
import { Excavator, DEFAULT_MACHINE } from "./machine.ts";
import type { MachineConfig } from "./machine.ts";

export type TargetKind = "pile" | "truck" | "zone";

interface BaseTarget {
  id: string;
  kind: TargetKind;
  label: string;
  x: number;
  z: number;
}

/** A diggable heap of material. */
export interface PileTarget extends BaseTarget {
  kind: "pile";
  radius: number;
}

/** A hauler bed that accepts material up to `capacity`. */
export interface TruckTarget extends BaseTarget {
  kind: "truck";
  capacity: number;
  filled: number;
  /** Height of the bed lip above ground (m). */
  bedHeight: number;
}

/** A rectangular area that should be brought to `targetHeight`. */
export interface ZoneTarget extends BaseTarget {
  kind: "zone";
  halfW: number;
  halfD: number;
  targetHeight: number;
}

export type Target = PileTarget | TruckTarget | ZoneTarget;

/**
 * The semantic layer: everything the outside world (UI, agent, script) is
 * allowed to talk about. Commands reference these ids, never raw coordinates.
 */
export class World {
  readonly terrain: Heightfield;
  readonly machine: Excavator;
  readonly targets = new Map<string, Target>();
  /** Seconds of simulated time. */
  time = 0;

  constructor(options?: {
    terrain?: Heightfield;
    machine?: Excavator;
    machineConfig?: MachineConfig;
  }) {
    this.terrain = options?.terrain ?? new Heightfield(DEFAULT_TERRAIN);
    this.machine = options?.machine ?? new Excavator(options?.machineConfig ?? DEFAULT_MACHINE, { x: 2, z: -3 });
    this.machine.baseY = this.terrain.sample(this.machine.state.x, this.machine.state.z);
  }

  addTarget(t: Target): Target {
    this.targets.set(t.id, t);
    return t;
  }

  target(id: string): Target | undefined {
    return this.targets.get(id);
  }

  ofKind<K extends TargetKind>(kind: K): Extract<Target, { kind: K }>[] {
    return [...this.targets.values()].filter((t): t is Extract<Target, { kind: K }> => t.kind === kind);
  }

  pile(id: string): PileTarget | undefined {
    const t = this.targets.get(id);
    return t && t.kind === "pile" ? t : undefined;
  }

  truck(id: string): TruckTarget | undefined {
    const t = this.targets.get(id);
    return t && t.kind === "truck" ? t : undefined;
  }

  zone(id: string): ZoneTarget | undefined {
    const t = this.targets.get(id);
    return t && t.kind === "zone" ? t : undefined;
  }
}

/** Builds the default sandbox: a couple of heaps, a pit, a truck and a grading pad. */
export function createSandbox(): World {
  const world = new World();
  const t = world.terrain;

  // A big gravel heap east of the machine.
  t.raise(16, 2, 96, 6.5);
  // A smaller dirt heap to the north.
  t.raise(-4, 14, 30, 4);
  // An excavation pit to the west.
  t.dig(-16, 12, 7, 2.2);
  // Some natural undulation so the ground never looks like a plane.
  for (let iz = 0; iz < t.nz; iz += 1) {
    for (let ix = 0; ix < t.nx; ix += 1) {
      const x = t.vx(ix);
      const z = t.vz(iz);
      const w =
        Math.sin(x * 0.13) * Math.cos(z * 0.11) * 0.22 + Math.sin(x * 0.31 + z * 0.23) * 0.08;
      t.heights[iz * t.nx + ix] = (t.heights[iz * t.nx + ix] ?? 0) + w;
    }
  }
  // Reset the accounting so the sandbox starts from a clean slate.
  t.totalDug = 0;
  t.totalRaised = 0;

  world.addTarget({
    id: "pile-east",
    kind: "pile",
    label: "东侧砂石堆",
    x: 16,
    z: 2,
    radius: 5.5,
  });
  world.addTarget({
    id: "pile-north",
    kind: "pile",
    label: "北侧土堆",
    x: -4,
    z: 14,
    radius: 3.5,
  });
  world.addTarget({
    id: "truck-01",
    kind: "truck",
    label: "自卸卡车 01",
    x: -9,
    z: -13,
    capacity: 8,
    filled: 0,
    bedHeight: 1.5,
  });
  world.addTarget({
    id: "pad-north",
    kind: "zone",
    label: "北侧平整区",
    x: -16,
    z: 12,
    halfW: 4,
    halfD: 4,
    targetHeight: -2.0,
  });

  return world;
}
