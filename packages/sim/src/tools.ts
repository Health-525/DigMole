import { z } from "zod";
import type { Sim } from "./sim.ts";
import type { TaskResult } from "./task.ts";
import { driveTo, scoopTarget, dumpToTarget, levelZone } from "./actions.ts";

export type ToolCallResult = TaskResult;

export interface ToolSpec {
  name: string;
  /** Shown to the model. Keep it short and explicit about units. */
  description: string;
  /** JSON Schema for the model's function-calling layer. */
  jsonSchema: Record<string, unknown>;
  parse(raw: unknown): { ok: true; value: unknown } | { ok: false; error: string };
  exec(sim: Sim, value: unknown): Promise<ToolCallResult>;
}

function fromZod<S extends z.ZodTypeAny>(schema: S) {
  return (raw: unknown): { ok: true; value: unknown } | { ok: false; error: string } => {
    const parsed = schema.safeParse(raw ?? {});
    if (parsed.success) return { ok: true, value: parsed.data };
    const detail = parsed.error.issues
      .map((i) => `${i.path.length ? i.path.join(".") : "(root)"}: ${i.message}`)
      .join("；");
    return { ok: false, error: `参数不对：${detail}` };
  };
}

async function runAction(sim: Sim, name: string, gen: ReturnType<typeof driveTo>): Promise<ToolCallResult> {
  return sim.run(name, gen as never);
}

const observeSchema = z.object({});
const driveSchema = z.object({ x: z.number(), z: z.number() });
const scoopSchema = z.object({ targetId: z.string(), stroke: z.number().min(0.5).max(4).optional() });
const dumpSchema = z.object({ targetId: z.string() });
const levelSchema = z.object({
  zoneId: z.string(),
  tolerance: z.number().min(0.05).max(1).optional(),
});
const abortSchema = z.object({});

export const TOOLS: ToolSpec[] = [
  {
    name: "observe",
    description:
      "读取当前世界状态：挖掘机位姿、铲斗装载量、所有目标（土堆/卡车/平整区）及其进度、地形概览。任何操作前后都应该调用它。",
    jsonSchema: { type: "object", properties: {}, additionalProperties: false },
    parse: fromZod(observeSchema),
    async exec(sim) {
      const snap = sim.snapshot();
      return { ok: true, message: "世界状态已读取", data: snap as unknown as Record<string, unknown> };
    },
  },
  {
    name: "drive_to",
    description: "把履带行驶到世界坐标 (x, z)，单位米。会先原地转向再直行，途中不会自动避开土堆。",
    jsonSchema: {
      type: "object",
      properties: {
        x: { type: "number", description: "目标点 X，米" },
        z: { type: "number", description: "目标点 Z，米" },
      },
      required: ["x", "z"],
      additionalProperties: false,
    },
    parse: fromZod(driveSchema),
    async exec(sim, value) {
      const a = value as { x: number; z: number };
      return runAction(sim, "drive_to", driveTo(sim.ctx, a.x, a.z));
    },
  },
  {
    name: "scoop",
    description:
      "开到指定土堆旁边并挖一斗（约 1 m³）。铲斗已满时会失败，需要先 dump_to。返回实际装入的方量。",
    jsonSchema: {
      type: "object",
      properties: {
        targetId: { type: "string", description: "土堆的 id，例如 pile-east" },
        stroke: { type: "number", description: "挖掘行程长度（米），默认 2.4" },
      },
      required: ["targetId"],
      additionalProperties: false,
    },
    parse: fromZod(scoopSchema),
    async exec(sim, value) {
      const a = value as { targetId: string; stroke?: number };
      return runAction(sim, "scoop", scoopTarget(sim.ctx, a));
    },
  },
  {
    name: "dump_to",
    description: "把铲斗里的料卸到目标（卡车 / 土堆 / 平整区）。卡车装满后会失败。",
    jsonSchema: {
      type: "object",
      properties: {
        targetId: { type: "string", description: "卡车或堆场目标 id，例如 truck-01" },
      },
      required: ["targetId"],
      additionalProperties: false,
    },
    parse: fromZod(dumpSchema),
    async exec(sim, value) {
      const a = value as { targetId: string };
      return runAction(sim, "dump_to", dumpToTarget(sim.ctx, a));
    },
  },
  {
    name: "level",
    description:
      "把一块矩形场地整平：反复在高处取土填到低处，直到起伏小于 tolerance（默认 0.25 m）。耗时较长。",
    jsonSchema: {
      type: "object",
      properties: {
        zoneId: { type: "string", description: "平整区 id，例如 pad-north" },
        tolerance: { type: "number", description: "允许起伏，米，默认 0.25" },
      },
      required: ["zoneId"],
      additionalProperties: false,
    },
    parse: fromZod(levelSchema),
    async exec(sim, value) {
      const a = value as { zoneId: string; tolerance?: number };
      return runAction(sim, "level", levelZone(sim.ctx, a));
    },
  },
  {
    name: "abort",
    description: "急停：立刻中断当前动作，挖掘机保持当前姿态。",
    jsonSchema: { type: "object", properties: {}, additionalProperties: false },
    parse: fromZod(abortSchema),
    async exec(sim) {
      return sim.abort("操作员急停");
    },
  },
];

export function toolByName(name: string): ToolSpec | undefined {
  return TOOLS.find((t) => t.name === name);
}

/** Compact listing suitable for a system prompt. */
export function describeTools(): string {
  return TOOLS.map((t) => `- ${t.name}: ${t.description}`).join("\n");
}
