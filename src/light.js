// Light for the voxel world, worked out like Minecraft: sky light pours straight down every column until the first solid
// block, then spreads sideways and down through empty (or see-through) cells losing one level per step; glowing blocks
// (lava, glowstone) are light sources too. Each block face is then lit by the cell it looks into, so the inside of a closed
// room is dark whatever the blocks are made of, a ceiling shades what is under it, and an open window lets a little in.
// Pure functions (no DOM, no three.js) so they can be tested in Node.

export const SKY_LEVEL = 15;

// levels[i] is the light level (0-15) of cell i for cells light can be in (empty or see-through), 0 for solid cells.
// passes(id) says whether light goes through a block; emit(id) gives the light level a block gives off (0 for most).
// `sources` are extra lights standing in free cells (lit lamps): [x, y, z, level] each, or [x, y, z, level, down] for a lamp
// that shines down (it also lights a cone below it, as far as `down` cells).
// With { sky: false } only the glowing blocks and `sources` count (the "block light" on its own, used to make lit faces glow).
// `shut` is an optional Set of cell indexes light cannot go through although no block is there (the cells of closed doors).
export function computeLight(world, passes, emit, sources = [], { sky = true, shut = null } = {}) {
  const { sx, sz, height: sy, cells } = world;
  const levels = new Uint8Array(cells.length);
  const idx = (x, y, z) => x + sx * (z + sz * y); // matches World.index
  const pass = (i) => passes(cells[i]) && !(shut && shut.has(i)); // can light be in (and go through) cell i?
  const queue = [];
  for (let z = 0; sky && z < sz; z++) {
    for (let x = 0; x < sx; x++) {
      for (let y = sy - 1; y >= 0 && pass(idx(x, y, z)); y--) {
        levels[idx(x, y, z)] = SKY_LEVEL;
        queue.push(x, y, z);
      }
    }
  }
  const DIRS = [1, 0, 0, -1, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 1, 0, 0, -1];
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
      if (levels[i] < next && pass(i)) {
        levels[i] = next;
        queue.push(nx, ny, nz);
      }
    }
  }
  // Point lights (glowing blocks and lamps) spread by real distance, so their light is a round ball and not the diamond that
  // stepping one cell at a time makes: a step costs 1 along an axis, 1.41 across a face diagonal and 1.73 across a corner.
  // A diagonal step is only taken when one of the cells beside it is open, so light does not leak through a wall's corner.
  const near = new Float32Array(cells.length);
  const spread = [];
  const seed = (x, y, z, level) => {
    if (x < 0 || y < 0 || z < 0 || x >= sx || y >= sy || z >= sz) return;
    const i = idx(x, y, z);
    if (pass(i) && near[i] < level) {
      near[i] = level;
      spread.push(x, y, z);
    }
  };
  // the cells next to a glowing block get its level minus one
  for (let z = 0; z < sz; z++) {
    for (let y = 0; y < sy; y++) {
      for (let x = 0; x < sx; x++) {
        const e = emit(cells[idx(x, y, z)]);
        if (!e) continue;
        for (let d = 0; d < DIRS.length; d += 3) seed(x + DIRS[d], y + DIRS[d + 1], z + DIRS[d + 2], e - 1);
      }
    }
  }
  for (const [x, y, z, level] of sources) seed(x, y, z, level);
  const open = (x, y, z) => x >= 0 && y >= 0 && z >= 0 && x < sx && y < sy && z < sz && pass(idx(x, y, z));
  // Can light step from (x, y, z) by (dx, dy, dz) (each -1, 0 or 1)? Light only travels through faces, so a diagonal step needs a
  // path of open cells, one axis at a time, in some order: it cannot slip through the edge or corner where blocks touch.
  const canStep = (x, y, z, dx, dy, dz) => {
    if (!open(x + dx, y + dy, z + dz)) return false;
    if ((dx !== 0) + (dy !== 0) + (dz !== 0) === 1) return true;
    return (
      (dx !== 0 && open(x + dx, y, z) && canStep(x + dx, y, z, 0, dy, dz)) ||
      (dy !== 0 && open(x, y + dy, z) && canStep(x, y + dy, z, dx, 0, dz)) ||
      (dz !== 0 && open(x, y, z + dz) && canStep(x, y, z + dz, dx, dy, 0))
    );
  };
  for (let q = 0; q < spread.length; q += 3) {
    const x = spread[q];
    const y = spread[q + 1];
    const z = spread[q + 2];
    const here = near[idx(x, y, z)];
    if (here <= 1) continue;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          const axes = (dx !== 0) + (dy !== 0) + (dz !== 0);
          if (!axes) continue;
          const next = here - Math.sqrt(axes);
          if (next <= 0) continue;
          const nx = x + dx;
          const ny = y + dy;
          const nz = z + dz;
          if (!canStep(x, y, z, dx, dy, dz)) continue;
          const i = idx(nx, ny, nz);
          if (near[i] < next) {
            near[i] = next;
            spread.push(nx, ny, nz);
          }
        }
      }
    }
  }
  // A lamp that points at the floor (a fifth value on its source: how far down it shines) lights a cone below it more strongly, so
  // its aura reaches a floor that is within that many cells. Only cells its light already reaches are brightened (no light through walls).
  for (const [x, y, z, level, down = 0] of sources) {
    for (let dy = 1; dy <= down; dy++) {
      const reach = Math.min(1 + Math.floor(dy * 0.8), 6); // the cone widens as it goes down
      for (let dz = -reach; dz <= reach; dz++) {
        for (let dx = -reach; dx <= reach; dx++) {
          const [cx, cy, cz] = [x + dx, y - dy, z + dz];
          if (cx < 0 || cy < 0 || cz < 0 || cx >= sx || cy >= sy || cz >= sz) continue;
          const i = idx(cx, cy, cz);
          if (near[i] <= 0) continue;
          const across = Math.hypot(dx, dz);
          if (across > reach + 0.5) continue; // a round cone, not a square one
          const dist = Math.hypot(dx, dy, dz);
          const boosted = level - 0.35 * dist - 4 * (across / (reach + 0.5)) ** 2; // dimmer toward the edge, so it melts into the ordinary light
          if (boosted <= near[i]) continue;
          // only with a clear straight line from the bulb: a roof or a wall in between keeps the cell as dark as it was
          let clear = true;
          const steps = Math.ceil(dist * 2);
          for (let s = 1; s < steps && clear; s++) {
            const f = s / steps;
            const px = Math.floor(x + 0.5 + dx * f);
            const py = Math.floor(y + 0.5 - dy * f);
            const pz = Math.floor(z + 0.5 + dz * f);
            if (px >= 0 && py >= 0 && pz >= 0 && px < sx && py < sy && pz < sz && !pass(idx(px, py, pz))) clear = false;
          }
          if (clear) near[i] = boosted;
        }
      }
    }
  }
  for (let i = 0; i < near.length; i++) {
    const level = Math.round(near[i]);
    if (level > levels[i]) levels[i] = level;
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
