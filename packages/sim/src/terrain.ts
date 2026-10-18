import { clamp, smoothstep } from "./math.ts";

export interface TerrainConfig {
  sizeX: number;
  sizeZ: number;
  cell: number;
  minHeight: number;
  maxHeight: number;
}

export interface DigResult {
  /** Cubic meters actually removed from the ground. */
  removed: number;
  /** Number of grid vertices touched. */
  vertices: number;
}

export interface RaiseResult {
  /** Cubic meters actually added to the ground (may be less than requested when hitting maxHeight). */
  added: number;
  vertices: number;
}

export const DEFAULT_TERRAIN: TerrainConfig = {
  sizeX: 80,
  sizeZ: 80,
  cell: 0.5,
  minHeight: -3,
  maxHeight: 6,
};

/**
 * A regular height grid. Everything is in meters; world X/Z are centered on the origin.
 *
 * Each vertex is treated as owning one cell of area `cell^2`, which makes volume
 * bookkeeping within a few percent — plenty for a sandbox, and it keeps dig/raise
 * operations O(r^2) instead of O(n).
 */
export class Heightfield {
  readonly nx: number;
  readonly nz: number;
  readonly cell: number;
  readonly x0: number;
  readonly z0: number;
  readonly minHeight: number;
  readonly maxHeight: number;
  readonly heights: Float32Array;
  /** Ground removed/added since the field was created. */
  totalDug = 0;
  totalRaised = 0;

  constructor(cfg: TerrainConfig = DEFAULT_TERRAIN) {
    this.cell = cfg.cell;
    this.nx = Math.round(cfg.sizeX / cfg.cell) + 1;
    this.nz = Math.round(cfg.sizeZ / cfg.cell) + 1;
    this.x0 = -cfg.sizeX / 2;
    this.z0 = -cfg.sizeZ / 2;
    this.minHeight = cfg.minHeight;
    this.maxHeight = cfg.maxHeight;
    this.heights = new Float32Array(this.nx * this.nz);
  }

  get cellArea(): number {
    return this.cell * this.cell;
  }

  vx(ix: number): number {
    return this.x0 + ix * this.cell;
  }

  vz(iz: number): number {
    return this.z0 + iz * this.cell;
  }

  /** Bilinear height sample at a world position, clamped to the grid. */
  sample(x: number, z: number): number {
    const fx = clamp((x - this.x0) / this.cell, 0, this.nx - 1.0001);
    const fz = clamp((z - this.z0) / this.cell, 0, this.nz - 1.0001);
    const ix = Math.floor(fx);
    const iz = Math.floor(fz);
    const tx = fx - ix;
    const tz = fz - iz;
    const h00 = this.heights[iz * this.nx + ix] ?? 0;
    const h10 = this.heights[iz * this.nx + ix + 1] ?? h00;
    const h01 = this.heights[(iz + 1) * this.nx + ix] ?? h00;
    const h11 = this.heights[(iz + 1) * this.nx + ix + 1] ?? h01;
    const a = h00 + (h10 - h00) * tx;
    const b = h01 + (h11 - h01) * tx;
    return a + (b - a) * tz;
  }

  /** Lowest/highest point in a square footprint around (x,z). */
  rangeIn(x: number, z: number, halfW: number, halfD: number): { min: number; max: number } {
    const ix0 = clamp(Math.floor((x - halfW - this.x0) / this.cell), 0, this.nx - 1);
    const ix1 = clamp(Math.ceil((x + halfW - this.x0) / this.cell), 0, this.nx - 1);
    const iz0 = clamp(Math.floor((z - halfD - this.z0) / this.cell), 0, this.nz - 1);
    const iz1 = clamp(Math.ceil((z + halfD - this.z0) / this.cell), 0, this.nz - 1);
    let min = Infinity;
    let max = -Infinity;
    for (let iz = iz0; iz <= iz1; iz++) {
      for (let ix = ix0; ix <= ix1; ix++) {
        const h = this.heights[iz * this.nx + ix] ?? 0;
        if (h < min) min = h;
        if (h > max) max = h;
      }
    }
    return { min: min === Infinity ? 0 : min, max: max === -Infinity ? 0 : max };
  }

  /**
   * Lowers the ground in a circular brush.
   * @param radius brush radius in meters
   * @param depth  maximum lowering at the brush center, in meters
   */
  dig(x: number, z: number, radius: number, depth: number): DigResult {
    const r2 = radius * radius;
    const ix0 = clamp(Math.floor((x - radius - this.x0) / this.cell), 0, this.nx - 1);
    const ix1 = clamp(Math.ceil((x + radius - this.x0) / this.cell), 0, this.nx - 1);
    const iz0 = clamp(Math.floor((z - radius - this.z0) / this.cell), 0, this.nz - 1);
    const iz1 = clamp(Math.ceil((z + radius - this.z0) / this.cell), 0, this.nz - 1);
    let removed = 0;
    let vertices = 0;
    for (let iz = iz0; iz <= iz1; iz++) {
      const dz = this.vz(iz) - z;
      for (let ix = ix0; ix <= ix1; ix++) {
        const dx = this.vx(ix) - x;
        const d2 = dx * dx + dz * dz;
        if (d2 > r2) continue;
        const f = 1 - d2 / r2;
        const drop = depth * smoothstep(f);
        if (drop <= 0) continue;
        const i = iz * this.nx + ix;
        const before = this.heights[i] ?? 0;
        const after = Math.max(this.minHeight, before - drop);
        if (after === before) continue;
        this.heights[i] = after;
        removed += (before - after) * this.cellArea;
        vertices++;
      }
    }
    this.totalDug += removed;
    return { removed, vertices };
  }

  /**
   * Distributes a volume of material as a rounded heap.
   * Returns the volume actually placed (limited by `maxHeight` and grid bounds).
   */
  raise(x: number, z: number, volume: number, radius: number): RaiseResult {
    const r2 = radius * radius;
    const ix0 = clamp(Math.floor((x - radius - this.x0) / this.cell), 0, this.nx - 1);
    const ix1 = clamp(Math.ceil((x + radius - this.x0) / this.cell), 0, this.nx - 1);
    const iz0 = clamp(Math.floor((z - radius - this.z0) / this.cell), 0, this.nz - 1);
    const iz1 = clamp(Math.ceil((z + radius - this.z0) / this.cell), 0, this.nz - 1);

    const idx: number[] = [];
    const weights: number[] = [];
    let weightedArea = 0;
    for (let iz = iz0; iz <= iz1; iz++) {
      const dz = this.vz(iz) - z;
      for (let ix = ix0; ix <= ix1; ix++) {
        const dx = this.vx(ix) - x;
        const d2 = dx * dx + dz * dz;
        if (d2 > r2) continue;
        const f = 1 - d2 / r2;
        const w = f * f;
        if (w <= 0) continue;
        idx.push(iz * this.nx + ix);
        weights.push(w);
        weightedArea += w * this.cellArea;
      }
    }
    if (weightedArea <= 0 || volume <= 0) return { added: 0, vertices: 0 };

    const scale = volume / weightedArea;
    let added = 0;
    for (let k = 0; k < idx.length; k++) {
      const i = idx[k] ?? 0;
      const before = this.heights[i] ?? 0;
      const after = Math.min(this.maxHeight, before + (weights[k] ?? 0) * scale);
      if (after === before) continue;
      this.heights[i] = after;
      added += (after - before) * this.cellArea;
    }
    this.totalRaised += added;
    return { added, vertices: idx.length };
  }

  /** Total material sitting above a reference plane, in cubic meters. */
  volumeAbove(y: number): number {
    let v = 0;
    for (let i = 0; i < this.heights.length; i++) {
      const h = (this.heights[i] ?? 0) - y;
      if (h > 0) v += h * this.cellArea;
    }
    return v;
  }

  /** Mean height inside a rectangular footprint. */
  meanIn(x: number, z: number, halfW: number, halfD: number): number {
    const ix0 = clamp(Math.floor((x - halfW - this.x0) / this.cell), 0, this.nx - 1);
    const ix1 = clamp(Math.ceil((x + halfW - this.x0) / this.cell), 0, this.nx - 1);
    const iz0 = clamp(Math.floor((z - halfD - this.z0) / this.cell), 0, this.nz - 1);
    const iz1 = clamp(Math.ceil((z + halfD - this.z0) / this.cell), 0, this.nz - 1);
    let sum = 0;
    let n = 0;
    for (let iz = iz0; iz <= iz1; iz++) {
      for (let ix = ix0; ix <= ix1; ix++) {
        sum += this.heights[iz * this.nx + ix] ?? 0;
        n++;
      }
    }
    return n > 0 ? sum / n : 0;
  }

  /** Rough flatness metric: max deviation from the mean inside a rectangle. */
  roughness(x: number, z: number, halfW: number, halfD: number): number {
    const mean = this.meanIn(x, z, halfW, halfD);
    const { min, max } = this.rangeIn(x, z, halfW, halfD);
    return Math.max(Math.abs(max - mean), Math.abs(mean - min));
  }

  /** Locates the lowest and highest vertex inside a rectangle, in world coordinates. */
  extremeIn(
    x: number,
    z: number,
    halfW: number,
    halfD: number,
  ): { min: { x: number; z: number; h: number }; max: { x: number; z: number; h: number } } {
    const ix0 = clamp(Math.floor((x - halfW - this.x0) / this.cell), 0, this.nx - 1);
    const ix1 = clamp(Math.ceil((x + halfW - this.x0) / this.cell), 0, this.nx - 1);
    const iz0 = clamp(Math.floor((z - halfD - this.z0) / this.cell), 0, this.nz - 1);
    const iz1 = clamp(Math.ceil((z + halfD - this.z0) / this.cell), 0, this.nz - 1);
    let min = { x, z, h: Infinity };
    let max = { x, z, h: -Infinity };
    for (let iz = iz0; iz <= iz1; iz++) {
      for (let ix = ix0; ix <= ix1; ix++) {
        const h = this.heights[iz * this.nx + ix] ?? 0;
        if (h < min.h) min = { x: this.vx(ix), z: this.vz(iz), h };
        if (h > max.h) max = { x: this.vx(ix), z: this.vz(iz), h };
      }
    }
    if (min.h === Infinity) min.h = 0;
    if (max.h === -Infinity) max.h = 0;
    return { min, max };
  }
}
