import { Sim, createSandbox, toolByName } from "@digmole/sim";
import type { ToolCallResult, Snapshot } from "@digmole/sim";

const sim = new Sim(createSandbox());

const RAMP = [" ", "·", "░", "▒", "▓", "█"];

function renderMap(): string {
  const t = sim.world.terrain;
  const m = sim.world.machine;
  const cols = 32;
  const rows = 16;
  const lines: string[] = [];
  for (let r = 0; r < rows; r++) {
    let line = "";
    for (let c = 0; c < cols; c++) {
      const x = -40 + ((c + 0.5) / cols) * 80;
      const z = -40 + ((r + 0.5) / rows) * 80;
      const mi = Math.round(((m.state.x + 40) / 80) * cols - 0.5);
      const mj = Math.round(((m.state.z + 40) / 80) * rows - 0.5);
      if (c === mi && r === mj) {
        line += "M";
        continue;
      }
      const h = t.sample(x, z);
      const idx = Math.max(0, Math.min(RAMP.length - 1, Math.floor((h + 2) / 1.1)));
      line += RAMP[idx];
    }
    lines.push(line);
  }
  return lines.join("\n");
}

function fmtTargets(s: Snapshot): string {
  return s.targets.map((t) => `    ${t.id.padEnd(11)} ${t.kind.padEnd(5)} ${t.label}  ${t.status}`).join("\n");
}

let step = 0;
async function call(name: string, args: Record<string, unknown> = {}): Promise<ToolCallResult> {
  step++;
  const tool = toolByName(name);
  if (!tool) throw new Error(`未知工具 ${name}`);
  const parsed = tool.parse(args);
  if (!parsed.ok) {
    console.log(`\n[${step}] → ${name} ${JSON.stringify(args)}\n    ✗ ${parsed.error}`);
    return { ok: false, code: "BAD_ARGS", message: parsed.error };
  }
  const t0 = performance.now();
  const result = await tool.exec(sim, parsed.value);
  const ms = Math.round(performance.now() - t0);
  const mark = result.ok ? "✓" : "✗";
  const code = result.ok ? "" : ` [${result.code}]`;
  console.log(
    `\n[${step}] → ${name} ${JSON.stringify(args)}\n    ${mark}${code} ${result.message}  (${ms} ms, sim t=${sim.world.time.toFixed(1)}s)`,
  );
  if (!result.ok && result.code === "BAD_ARGS") return result;
  return result;
}

async function main() {
  console.log("═══ DigMole · M0 无头仿真 ═══\n");
  const first = await call("observe");
  if (first.ok) {
    const s = first.data as unknown as Snapshot;
    console.log(`    位置 (${s.machine.x}, ${s.machine.z})   铲斗 ${s.bucket.load}/${s.bucket.capacity} m³`);
    console.log(fmtTargets(s));
  }

  await call("scoop", { targetId: "pile-east" });
  await call("scoop", { targetId: "pile-east" }); // 应该因为满斗而失败
  await call("dump_to", { targetId: "truck-01" });

  for (let i = 0; i < 9; i++) {
    const s = await call("scoop", { targetId: "pile-east" });
    if (!s.ok) break;
    const d = await call("dump_to", { targetId: "truck-01" });
    if (!d.ok) break;
  }

  const last = await call("observe");
  if (last.ok) {
    const s = last.data as unknown as Snapshot;
    console.log("\n─── 结果 ───");
    console.log(`    模拟时间 ${s.time}s   挖方总量 ${s.terrain.dugTotal} m³   地面回填 ${s.terrain.raisedTotal} m³`);
    console.log(fmtTargets(s));

    const truck = sim.world.truck("truck-01");
    const accounted = sim.world.terrain.totalRaised + (truck?.filled ?? 0) + sim.world.machine.state.load;
    const diff = sim.world.terrain.totalDug - accounted;
    console.log(
      `\n    体积守恒检查: 挖 ${sim.world.terrain.totalDug.toFixed(2)} = 地面 ${sim.world.terrain.totalRaised.toFixed(2)} + 卡车 ${(truck?.filled ?? 0).toFixed(2)} + 斗 ${sim.world.machine.state.load.toFixed(2)}  误差 ${diff.toFixed(3)} m³`,
    );
  }

  console.log("\n─── 地形俯瞰（M = 挖掘机）───");
  console.log(renderMap());
}

await main();
