import type { AtlasBounds } from './atlas-types.js';

type Column = readonly [number, number];
type Block = { i: number; j: number; farSize: number; columns: Column[] };
type Region = { x: number; z: number; blocks: Map<number, Block> };

/** The native column list can cover a planetary face, while the viewport usually covers a village. */
export class AtlasColumnIndex {
  readonly size: number;
  private readonly regions = new Map<string, Region>();

  constructor(columns: readonly Column[] = [], stride = 1) {
    this.size = Math.max(8, stride);
    for (const column of columns) {
      const x = Math.floor(column[0] / this.size);
      const z = Math.floor(column[1] / this.size);
      const rx = Math.floor(x / 8);
      const rz = Math.floor(z / 8);
      const key = `${rx},${rz}`;
      let region = this.regions.get(key);
      if (!region) {
        region = { x: rx, z: rz, blocks: new Map() };
        this.regions.set(key, region);
      }
      const local = (z - rz * 8) * 8 + x - rx * 8;
      let block = region.blocks.get(local);
      if (!block) {
        block = { i: x * this.size, j: z * this.size, farSize: this.size, columns: [] };
        region.blocks.set(local, block);
      }
      block.columns.push(column);
    }
    if (stride === 1) {
      for (const region of this.regions.values()) {
        if (region.blocks.size < 3) continue;
        const count16 = new Uint16Array(16),
          count32 = new Uint16Array(4);
        for (const [cell, block] of region.blocks) {
          const x = cell % 8,
            z = Math.floor(cell / 8);
          const mid = (z >> 1) * 4 + (x >> 1),
            wide = (z >> 2) * 2 + (x >> 2);
          count16[mid] = (count16[mid] ?? 0) + block.columns.length;
          count32[wide] = (count32[wide] ?? 0) + block.columns.length;
        }
        for (const [cell, block] of region.blocks) {
          const x = cell % 8,
            z = Math.floor(cell / 8);
          if ((count32[(z >> 2) * 2 + (x >> 2)] ?? 0) >= 768) block.farSize = 32;
          else if ((count16[(z >> 1) * 4 + (x >> 1)] ?? 0) >= 192) block.farSize = 16;
        }
      }
    }
  }

  visit(bounds: AtlasBounds, visit: (block: Block) => void) {
    const regionSize = this.size * 8;
    const x0 = Math.floor(bounds.i0 / regionSize);
    const z0 = Math.floor(bounds.j0 / regionSize);
    const x1 = Math.floor(bounds.i1 / regionSize);
    const z1 = Math.floor(bounds.j1 / regionSize);
    const visitRegion = (region: Region) => {
      for (const block of region.blocks.values())
        if (
          block.i <= bounds.i1 &&
          block.j <= bounds.j1 &&
          block.i + this.size > bounds.i0 &&
          block.j + this.size > bounds.j0
        )
          visit(block);
    };
    if ((x1 - x0 + 1) * (z1 - z0 + 1) > this.regions.size) {
      for (const region of this.regions.values())
        if (region.x >= x0 && region.x <= x1 && region.z >= z0 && region.z <= z1)
          visitRegion(region);
    } else {
      for (let z = z0; z <= z1; z++) {
        for (let x = x0; x <= x1; x++) {
          const region = this.regions.get(`${x},${z}`);
          if (region) visitRegion(region);
        }
      }
    }
  }
}
