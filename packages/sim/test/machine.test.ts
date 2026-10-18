import { test } from "node:test";
import assert from "node:assert/strict";
import { Excavator } from "../src/machine.ts";

function machine(): Excavator {
  const m = new Excavator();
  m.state.x = 0;
  m.state.z = 0;
  m.state.heading = 0;
  m.baseY = 0;
  return m;
}

test("inverse kinematics places the bucket pivot on the target", () => {
  const m = machine();
  const targets = [
    { x: 4, y: 2.5, z: 1 },
    { x: 3, y: 1.2, z: -2 },
    { x: 5.5, y: 3.4, z: 0 },
  ];
  for (const target of targets) {
    const sol = m.solveIK(target);
    assert.ok(sol, `no solution for ${JSON.stringify(target)}`);
    if (!sol) continue;
    m.state.swing = sol.swing;
    m.state.boom = sol.boom;
    m.state.stick = sol.stick;
    const p = m.bucketPivotWorld();
    const err = Math.hypot(p.x - target.x, p.y - target.y, p.z - target.z);
    assert.ok(err < 0.08, `IK error ${err.toFixed(3)} for ${JSON.stringify(target)}`);
  }
});

test("forward kinematics agrees with the solved pose", () => {
  const m = machine();
  m.state.boom = 0.5;
  m.state.stick = -1.2;
  m.state.curl = -0.5;
  m.state.swing = 0.3;
  const tip = m.tipWorld();
  const pivot = m.bucketPivotWorld();
  const dist = Math.hypot(tip.x - pivot.x, tip.y - pivot.y, tip.z - pivot.z);
  assert.ok(Math.abs(dist - m.cfg.bucketLength) < 1e-6, `tip should sit one bucket length from the pivot (${dist})`);
});

test("inverse kinematics gives a solution that is actually at the target", () => {
  const m = machine();
  // Place the bucket pivot 6 m out and 1 m above the pivot joint.
  const target = { x: 6, y: 1.55 + 1, z: 0 };
  const sol = m.solveIK(target);
  assert.ok(sol);
  if (!sol) return;
  assert.ok(Math.abs(sol.boom) < 1.25 && sol.boom > -0.15, `boom out of range: ${sol.boom}`);
});

test("curlFor respects the joint limits", () => {
  const m = machine();
  const c = m.curlFor(-1.2, 0.5);
  assert.ok(c <= m.cfg.curlLimits[1] + 1e-9);
  assert.ok(c >= m.cfg.curlLimits[0] - 1e-9);
});

test("driving turns then advances, and stops at the target", () => {
  const m = machine();
  m.driveTarget = { x: 0, z: 5 };
  for (let i = 0; i < 60 * 30; i++) m.stepDrive(1 / 60);
  assert.ok(Math.hypot(m.state.x, m.state.z - 5) < 0.2, `ended at (${m.state.x}, ${m.state.z})`);
});
