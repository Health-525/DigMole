export { Heightfield, DEFAULT_TERRAIN } from "./terrain.ts";
export type { TerrainConfig, DigResult, RaiseResult } from "./terrain.ts";
export { Excavator, DEFAULT_MACHINE } from "./machine.ts";
export type { MachineConfig, MachineState, Vec3, ArmSolution, JointTargets } from "./machine.ts";
export { World, createSandbox } from "./world.ts";
export type { Target, PileTarget, TruckTarget, ZoneTarget, TargetKind } from "./world.ts";
export { Sim, describeTarget } from "./sim.ts";
export type { Snapshot, TargetView } from "./sim.ts";
export { TOOLS, toolByName, describeTools } from "./tools.ts";
export type { ToolSpec, ToolCallResult } from "./tools.ts";
export { ActionError, ok, fail, advance, until, TaskRunner } from "./task.ts";
export type { TaskOk, TaskFail, TaskResult, TaskGen, Sub } from "./task.ts";
export * from "./actions.ts";
export { clamp, lerp, round, wrapAngle, angleDelta, moveTowards, moveAngleTowards, dist2 } from "./math.ts";

import { Sim } from "./sim.ts";
import { createSandbox } from "./world.ts";

/** Convenience factory for a fresh sandbox. */
export function createSim(): Sim {
  return new Sim(createSandbox());
}
