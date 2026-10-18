import { test } from "node:test";
import assert from "node:assert/strict";
import { Sim } from "../src/sim.ts";
import { createSandbox } from "../src/world.ts";
import { scoopTarget, dumpToTarget, driveTo, levelZone } from "../src/actions.ts";

function freshSim(): Sim {
  return new Sim(createSandbox());
}

test("scooping fills the bucket and removes ground volume", () => {
  const sim = freshSim();
  const before = sim.world.terrain.totalDug;
  const res = sim.run("scoop", scoopTarget(sim.ctx, { targetId: "pile-east" }), 120);
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.ok(sim.world.machine.state.load > 0.8, `load ${sim.world.machine.state.load}`);
  assert.ok(sim.world.terrain.totalDug > before, "terrain should have been dug");
});

test("a full bucket refuses a second scoop", () => {
  const sim = freshSim();
  sim.run("scoop", scoopTarget(sim.ctx, { targetId: "pile-east" }), 120);
  const res = sim.run("scoop", scoopTarget(sim.ctx, { targetId: "pile-east" }), 120);
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.code, "BUCKET_FULL");
});

test("an empty bucket refuses to dump", () => {
  const sim = freshSim();
  assert.equal(sim.world.machine.state.load, 0);
  const res = sim.run("dump", dumpToTarget(sim.ctx, { targetId: "truck-01" }), 120);
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.code, "BUCKET_EMPTY");
});

test("dig and dump conserve volume to within a few percent", () => {
  const sim = freshSim();
  for (let i = 0; i < 2; i++) {
    const scooped = sim.run("scoop", scoopTarget(sim.ctx, { targetId: "pile-east" }), 240);
    assert.equal(scooped.ok, true, JSON.stringify(scooped));
    const dumped = sim.run("dump", dumpToTarget(sim.ctx, { targetId: "truck-01" }), 240);
    assert.equal(dumped.ok, true, JSON.stringify(dumped));
  }
  const { terrain, machine } = sim.world;
  const truck = sim.world.truck("truck-01");
  assert.ok(truck);
  const accounted = terrain.totalRaised + (truck?.filled ?? 0) + machine.state.load;
  const diff = Math.abs(terrain.totalDug - accounted);
  assert.ok(diff < 0.05, `dug ${terrain.totalDug} vs accounted ${accounted} (diff ${diff})`);
  assert.ok((truck?.filled ?? 0) > 1.5, `truck filled ${truck?.filled}`);
});

test("a full truck refuses more material", () => {
  const sim = freshSim();
  const truck = sim.world.truck("truck-01");
  assert.ok(truck);
  if (!truck) return;
  truck.filled = truck.capacity;
  sim.world.machine.state.load = 1;
  const res = sim.run("dump", dumpToTarget(sim.ctx, { targetId: "truck-01" }), 120);
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.code, "TRUCK_FULL");
});

test("abort interrupts a running action", () => {
  const sim = freshSim();
  sim.start("drive", driveTo(sim.ctx, 30, 30));
  for (let i = 0; i < 60; i++) sim.tick();
  assert.equal(sim.busy, true, "action should still be running");
  const res = sim.abort("测试急停");
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.code, "ABORTED");
  assert.equal(sim.busy, false);
  const pos = { x: sim.world.machine.state.x, z: sim.world.machine.state.z };
  for (let i = 0; i < 60; i++) sim.tick();
  assert.equal(sim.world.machine.state.x, pos.x, "machine should stay put after abort");
});

test("the simulation is deterministic for the same action sequence", () => {
  const runOnce = () => {
    const sim = freshSim();
    sim.run("scoop", scoopTarget(sim.ctx, { targetId: "pile-east" }), 120);
    sim.run("dump", dumpToTarget(sim.ctx, { targetId: "truck-01" }), 120);
    return sim.world.terrain.heights.slice();
  };
  const a = runOnce();
  const b = runOnce();
  for (let i = 0; i < a.length; i++) {
    assert.equal(a[i], b[i], `height ${i} diverged`);
  }
});

test("leveling a pad returns a structured result without hanging", () => {
  const sim = freshSim();
  const before = sim.world.terrain.roughness(-16, 12, 4, 4);
  const res = sim.run("level", levelZone(sim.ctx, { zoneId: "pad-north", maxPasses: 2, tolerance: 0.4 }), 600);
  assert.equal(typeof res.ok, "boolean");
  assert.ok(res.message.length > 0, "level must explain itself");
  const after = sim.world.terrain.roughness(-16, 12, 4, 4);
  assert.ok(after <= before + 1e-6, `leveling made it worse: ${before} -> ${after}`);
});

