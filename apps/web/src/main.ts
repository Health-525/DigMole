import { Sim, createSandbox, scoopTarget, dumpToTarget } from "@digmole/sim";
import type { TaskResult } from "@digmole/sim";
import { createWorldView } from "./view.ts";

const canvas = document.getElementById("view") as HTMLCanvasElement;
const sim = new Sim(createSandbox());
const view = createWorldView(canvas, sim);

const el = (id: string) => document.getElementById(id) as HTMLElement;
const sTime = el("s-time");
const sLoad = el("s-load");
const sTruck = el("s-truck");
const sDug = el("s-dug");
const sAction = el("s-action");
const bLoad = el("b-load");
const bTruck = el("b-truck");
const logEl = el("log");
const btnAuto = el("btn-auto") as HTMLButtonElement;
const btnOnce = el("btn-once") as HTMLButtonElement;
const btnStop = el("btn-stop") as HTMLButtonElement;
const btnReset = el("btn-reset") as HTMLButtonElement;
const speed = el("speed") as HTMLInputElement;
const speedV = el("speed-v");

let timeScale = Number(speed.value);
let paused = false;
speed.addEventListener("input", () => {
  timeScale = Number(speed.value);
  speedV.textContent = `${timeScale}×`;
});

let auto = false;

function log(text: string, ok?: boolean): void {
  const row = document.createElement("div");
  row.className = "row" + (ok === undefined ? "" : ok ? " ok" : " bad");
  row.textContent = text;
  logEl.prepend(row);
  while (logEl.children.length > 6) logEl.lastChild?.remove();
}

function report(res: TaskResult): void {
  log(res.ok ? `✓ ${res.message}` : `✗ ${res.message}`, res.ok);
}

async function runCycle(): Promise<boolean> {
  const a = await sim.runAsync("scoop", scoopTarget(sim.ctx, { targetId: "pile-east" }));
  report(a);
  if (!a.ok) return false;
  const b = await sim.runAsync("dump_to", dumpToTarget(sim.ctx, { targetId: "truck-01" }));
  report(b);
  return b.ok;
}

async function autoLoop(): Promise<void> {
  if (auto) return;
  auto = true;
  btnAuto.textContent = "暂停自动作业";
  try {
    while (auto) {
      const ok = await runCycle();
      if (!ok) break;
    }
  } finally {
    auto = false;
    btnAuto.textContent = "开始自动作业";
  }
}

let running = false;

btnAuto.addEventListener("click", () => {
  if (auto) {
    auto = false;
    btnAuto.textContent = "开始自动作业";
    return;
  }
  void autoLoop();
});

btnOnce.addEventListener("click", () => {
  if (auto || running) return;
  running = true;
  void runCycle().finally(() => {
    running = false;
  });
});

btnStop.addEventListener("click", () => {
  auto = false;
  running = false;
  const res = sim.abort("操作员急停");
  if (!res.ok && res.code !== "IDLE") report(res);
  else log("⏹ 已急停");
});

btnReset.addEventListener("click", () => location.reload());

window.addEventListener("keydown", (e) => {
  if (e.code === "Space") {
    e.preventDefault();
    btnStop.click();
  }
});

const ACTION_LABEL: Record<string, string> = {
  idle: "待机",
  scoop: "挖掘中",
  dump_to: "卸料中",
  drive_to: "行驶中",
  level: "平整中",
};

function paintHud(): void {
  const m = sim.world.machine;
  const truck = sim.world.truck("truck-01");
  const snap = sim.snapshot();

  sTime.textContent = `${sim.world.time.toFixed(1)} s`;
  sLoad.textContent = `${m.state.load.toFixed(2)} / ${m.cfg.capacity.toFixed(2)} m³`;
  bLoad.style.width = `${(m.state.load / m.cfg.capacity) * 100}%`;
  if (truck) {
    sTruck.textContent = `${truck.filled.toFixed(1)} / ${truck.capacity.toFixed(1)} m³`;
    bTruck.style.width = `${(truck.filled / truck.capacity) * 100}%`;
  }
  sDug.textContent = `${snap.terrain.dugTotal.toFixed(2)} m³`;
  const name = sim.busy ? snap.action.name : "idle";
  sAction.textContent = ACTION_LABEL[name] ?? name;
}

let last = performance.now();
let acc = 0;

function frame(now: number): void {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;

  if (!paused) {
    acc += dt * timeScale;
    let steps = 0;
    while (acc >= sim.dt && steps < 12) {
      try {
        sim.tick();
      } catch (err) {
        log(`✗ 运行时异常：${String(err)}`, false);
        break;
      }
      acc -= sim.dt;
      steps++;
    }
    if (steps >= 12) acc = 0;
  }

  view.update(sim);
  paintHud();
  requestAnimationFrame(frame);
}

log("沙盒就绪 · 东侧砂石堆待开采");
requestAnimationFrame(frame);

// `?auto=1` starts the demo immediately — handy for screenshots and demos.
if (new URLSearchParams(location.search).has("auto")) {
  setTimeout(() => void autoLoop(), 300);
}
