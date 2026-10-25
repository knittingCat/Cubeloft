// Light for the voxel world, worked out like Minecraft: sky light pours straight down every column until the first solid
// block, then spreads sideways and down through empty (or see-through) cells losing one level per step; glowing blocks
// (lava, glowstone) are light sources too. Each block face is then lit by the cell it looks into, so the inside of a closed
// room is dark whatever the blocks are made of, a ceiling shades what is under it, and an open window lets a little in.
// Pure functions (no DOM, no three.js) so they can be tested in Node.

export const SKY_LEVEL = 15;

// levels[i] is the light level (0-15) of cell i for cells light can be in (empty or see-through), 0 for solid cells.
// passes(id) says whether light goes through a block; emit(id) gives the light level a block gives off (0 for most).
// `sources` are extra lights standing in free cells (lit lamps): [x, y, z, level] each.
// With { sky: false } only the glowing blocks and `sources` count (the "block light" on its own, used to make lit faces glow).
export function computeLight(world, passes, emit, sources = [], { sky = true } = {}) {
  const { sx, sz, height: sy, cells } = world;
  const levels = new Uint8Array(cells.length);
  const idx = (x, y, z) => x + sx * (z + sz * y); // matches World.index
  const queue = [];
  for (let z = 0; sky && z < sz; z++) {
    for (let x = 0; x < sx; x++) {
      for (let y = sy - 1; y >= 0 && passes(cells[idx(x, y, z)]); y--) {
        levels[idx(x, y, z)] = SKY_LEVEL;
        queue.push(x, y, z);
      }
    }
  }
  const DIRS = [1, 0, 0, -1, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 1, 0, 0, -1];
  // light sources: the cells next to a glowing block get its level minus one
  for (let z = 0; z < sz; z++) {
    for (let y = 0; y < sy; y++) {
      for (let x = 0; x < sx; x++) {
        const e = emit(cells[idx(x, y, z)]);
        if (!e) continue;
        for (let d = 0; d < DIRS.length; d += 3) {
          const nx = x + DIRS[d];
          const ny = y + DIRS[d + 1];
          const nz = z + DIRS[d + 2];
          if (nx < 0 || ny < 0 || nz < 0 || nx >= sx || ny >= sy || nz >= sz) continue;
          const i = idx(nx, ny, nz);
          if (passes(cells[i]) && levels[i] < e - 1) {
            levels[i] = e - 1;
            queue.push(nx, ny, nz);
          }
        }
      }
    }
  }
  for (const [x, y, z, level] of sources) {
    if (x < 0 || y < 0 || z < 0 || x >= sx || y >= sy || z >= sz) continue;
    const i = idx(x, y, z);
    if (passes(cells[i]) && levels[i] < level) {
      levels[i] = level;
      queue.push(x, y, z);
    }
  }
  // spread: a lit cell lights its see-through neighbours one level lower (keep going until nothing gets brighter)
  for (let q = 0; q < queue.length; q += 3) {
    const x = queue[q];
    const y = queue[q + 1];
    const z = queue[q + 2];
    const next = levels[idx(x, y, z)] - 1;
    if (next <= 0) continue;
    for (let d = 0; d < DIRS.length; d += 3) {
      const nx = x + DIRS[d];
      const ny = y + DIRS[d + 1];
      const nz = z + DIRS[d + 2];
      if (nx < 0 || ny < 0 || nz < 0 || nx >= sx || ny >= sy || nz >= sz) continue;
      const i = idx(nx, ny, nz);
      if (levels[i] < next && passes(cells[i])) {
        levels[i] = next;
        queue.push(nx, ny, nz);
      }
    }
  }
  return levels;
}

// Brightness (0.14 to 1) for a light level: full at the top, about 18% less per step, never pitch black.
export const brightness = (level) => 0.14 + 0.86 * 0.82 ** (SKY_LEVEL - level);

// The six face levels of the block at (x, y, z), in BoxGeometry order +x, -x, +y, -y, +z, -z: the level of the cell each face
// looks into (past the edge of the world is open air). A see-through block just uses its own cell's level.
// `edge` is the level past the edge of the world: open air for sky light, nothing at all for block light.
export function faceLevels(world, levels, passes, x, y, z, edge = { side: SKY_LEVEL, top: SKY_LEVEL, bottom: 8 }) {
  const out = [0, 0, 0, 0, 0, 0];
  const here = x + world.sx * (z + world.sz * y);
  if (passes(world.cells[here])) return out.fill(levels[here]);
  const look = (nx, ny, nz, outside) => {
    if (ny >= world.height) return edge.top;
    if (nx < 0 || ny < 0 || nz < 0 || nx >= world.sx || nz >= world.sz) return outside;
    return levels[nx + world.sx * (nz + world.sz * ny)];
  };
  out[0] = look(x + 1, y, z, edge.side);
  out[1] = look(x - 1, y, z, edge.side);
  out[2] = look(x, y + 1, z, edge.side);
  out[3] = look(x, y - 1, z, edge.bottom);
  out[4] = look(x, y, z + 1, edge.side);
  out[5] = look(x, y, z - 1, edge.side);
  return out;
}

// How strongly a face lit only by lamps and glowing blocks glows on its own (0 for none, about 0.7 right beside a lamp).
export const glowAmount = (level) => (level <= 0 ? 0 : 0.9 * 0.7 ** (SKY_LEVEL - level));
export const NO_EDGE_LIGHT = { side: 0, top: 0, bottom: 0 };
