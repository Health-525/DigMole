import { test } from "node:test";
import assert from "node:assert/strict";
import { Heightfield } from "../src/terrain.ts";

function fresh(): Heightfield {
  return new Heightfield({ sizeX: 40, sizeZ: 40, cell: 0.5, minHeight: -5, maxHeight: 10 });
}

test("raise places close to the requested volume", () => {
  const t = fresh();
  const r = t.raise(0, 0, 20, 4);
  assert.ok(Math.abs(r.added - 20) < 0.6, `added ${r.added}`);
  assert.ok(t.sample(0, 0) > 0.5, "heap should be higher than the surrounding ground");
});

test("dig lowers the ground and reports removed volume", () => {
  const t = fresh();
  t.raise(0, 0, 30, 5);
  const h0 = t.sample(0, 0);
  const d = t.dig(0, 0, 1.5, 0.8);
  assert.ok(d.removed > 0.1, `removed ${d.removed}`);
  assert.ok(t.sample(0, 0) < h0, "ground should drop");
});

test("dig clamps at the minimum height", () => {
  const t = fresh();
  t.dig(0, 0, 3, 1000);
  assert.equal(t.sample(0, 0), -5);
});

test("volume is conserved across dig and raise of the same spot", () => {
  const t = fresh();
  t.raise(0, 0, 25, 4);
  const dug = t.dig(0, 0, 3, 2).removed;
  const added = t.raise(0, 0, dug, 4).added;
  assert.ok(Math.abs(added - dug) < 0.5, `dug ${dug} vs added ${added}`);
});

test("extremeIn finds the high and low points of a rectangle", () => {
  const t = fresh();
  t.raise(5, 5, 20, 3);
  const { min, max } = t.extremeIn(5, 5, 6, 6);
  assert.ok(max.h > min.h + 0.5);
  assert.ok(Math.hypot(max.x - 5, max.z - 5) < 1.5, `max at (${max.x}, ${max.z})`);
});

test("roughness is near zero on untouched flat ground and spikes on a heap", () => {
  const t = fresh();
  assert.ok(t.roughness(0, 0, 5, 5) < 1e-6);
  t.raise(0, 0, 40, 5);
  assert.ok(t.roughness(0, 0, 5, 5) > 0.3);
});
