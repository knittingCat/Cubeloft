// Copy / paste of block regions. Pure functions (no DOM), so they can be tested in Node.
// A clip is { w, h, d, cells: [[dx, dy, dz, id], ...] (non-empty blocks only), labels: [{ dx, dy, dz, text }] }.
import { turnStair, flipStair } from './blocks.js';

export function normalizeBox(a, b) {
  return {
    min: [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.min(a[2], b[2])],
    max: [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.max(a[2], b[2])],
  };
}

export function extract(world, a, b) {
  const { min, max } = normalizeBox(a, b);
  const clip = { w: max[0] - min[0] + 1, h: max[1] - min[1] + 1, d: max[2] - min[2] + 1, cells: [], labels: [] };
  for (let y = min[1]; y <= max[1]; y++) {
    for (let z = min[2]; z <= max[2]; z++) {
      for (let x = min[0]; x <= max[0]; x++) {
        const id = world.get(x, y, z);
        if (id) clip.cells.push([x - min[0], y - min[1], z - min[2], id]);
      }
    }
  }
  for (const l of world.labels) {
    if (l.x >= min[0] && l.x <= max[0] && l.y >= min[1] && l.y <= max[1] && l.z >= min[2] && l.z <= max[2]) {
      clip.labels.push({ dx: l.x - min[0], dy: l.y - min[1], dz: l.z - min[2], text: l.text });
    }
  }
  return clip;
}

// Turn the clip 90 degrees clockwise (seen from above).
export function rotate90(clip) {
  const { w, h, d } = clip;
  return {
    w: d,
    h,
    d: w,
    cells: clip.cells.map(([x, y, z, id]) => [d - 1 - z, y, x, turnStair(id, 1)]),
    labels: clip.labels.map((l) => ({ dx: d - 1 - l.dz, dy: l.dy, dz: l.dx, text: l.text })),
  };
}

// Flip the clip left-to-right (a mirror image).
export function mirrorX(clip) {
  return {
    w: clip.w,
    h: clip.h,
    d: clip.d,
    cells: clip.cells.map(([x, y, z, id]) => [clip.w - 1 - x, y, z, flipStair(id, 'x')]),
    labels: clip.labels.map((l) => ({ dx: clip.w - 1 - l.dx, dy: l.dy, dz: l.dz, text: l.text })),
  };
}

// The Mirror tool: reflect an area across a vertical line. The line runs along cell edges, between cells
// boundary-1 and boundary on one axis, so a cell at v lands at k - v where k = 2 * boundary - 1.
// Pointing outside the area puts the line on the edge of the pointed cell nearest the area; pointing
// inside it uses the nearest side of the area. Either way the line is never inside the area, so the copy never overlaps it.
export function mirrorLineFor(a, b, cell) {
  const { min, max } = normalizeBox(a, b);
  const beyond = (v, lo, hi) => (v > hi ? v - hi : v < lo ? lo - v : 0);
  const dx = beyond(cell[0], min[0], max[0]);
  const dz = beyond(cell[2], min[2], max[2]);
  let axis;
  let boundary;
  if (dx || dz) {
    axis = dx >= dz ? 'x' : 'z';
    const i = axis === 'x' ? 0 : 2;
    boundary = cell[i] > max[i] ? cell[i] : cell[i] + 1;
  } else {
    const sides = [
      ['x', min[0], cell[0] - min[0]],
      ['x', max[0] + 1, max[0] - cell[0]],
      ['z', min[2], cell[2] - min[2]],
      ['z', max[2] + 1, max[2] - cell[2]],
    ].sort((p, q) => p[2] - q[2]);
    [axis, boundary] = sides[0];
  }
  return { axis, boundary, k: 2 * boundary - 1 };
}

// The reflected corner pair of an area, for showing where the copy will land.
export function mirrorBox(a, b, line) {
  const flip = (c) => (line.axis === 'x' ? [line.k - c[0], c[1], c[2]] : [c[0], c[1], line.k - c[2]]);
  return [flip(a), flip(b)];
}

// The blocks and signs of `clip` (extracted from the area whose lowest corner is `origin`), reflected across `line`.
// `dropped` counts the ones that would land outside the world.
export function mirrorPlacement(world, clip, origin, line) {
  const flip = (x, z) => (line.axis === 'x' ? [line.k - x, z] : [x, line.k - z]);
  const inside = (x, y, z) => x >= 0 && y >= 0 && z >= 0 && x < world.sx && y < world.height && z < world.sz;
  let dropped = 0;
  const cells = [];
  for (const [dx, dy, dz, id] of clip.cells) {
    const y = origin[1] + dy;
    const [x, z] = flip(origin[0] + dx, origin[2] + dz);
    if (inside(x, y, z)) cells.push([x, y, z, flipStair(id, line.axis)]);
    else dropped++;
  }
  const labels = [];
  for (const l of clip.labels) {
    const y = origin[1] + l.dy;
    const [x, z] = flip(origin[0] + l.dx, origin[2] + l.dz);
    if (inside(x, y, z)) labels.push({ x, y, z, text: l.text });
    else dropped++;
  }
  return { cells, labels, dropped };
}

// Where the clip's corner goes when the user points at a cell: centre it on the cell, bottom layer at that height.
// The floor squares the clip's blocks stand over: one [dx, dz] per column that has at least one block.
const columnCache = new WeakMap();
export function footprintColumns(clip) {
  let cols = columnCache.get(clip);
  if (!cols) {
    const seen = new Set();
    cols = [];
    for (const [dx, , dz] of clip.cells) {
      const k = dx + ',' + dz;
      if (!seen.has(k)) {
        seen.add(k);
        cols.push([dx, dz]);
      }
    }
    columnCache.set(clip, cols);
  }
  return cols;
}

export function originFor(clip, cell) {
  return [cell[0] - Math.floor(clip.w / 2), cell[1], cell[2] - Math.floor(clip.d / 2)];
}

// How many blocks of the clip would land outside the world, and the placement list.
export function placement(world, clip, origin) {
  const fits =
    origin[0] >= 0 && origin[1] >= 0 && origin[2] >= 0 &&
    origin[0] + clip.w <= world.sx && origin[2] + clip.d <= world.sz && origin[1] + clip.h <= world.height;
  const cells = clip.cells.map(([dx, dy, dz, id]) => [origin[0] + dx, origin[1] + dy, origin[2] + dz, id]);
  const labels = clip.labels.map((l) => ({ x: origin[0] + l.dx, y: origin[1] + l.dy, z: origin[2] + l.dz, text: l.text }));
  return { fits, cells, labels };
}

// Like symmetricCells, but returns [x, y, z, id] with `id` as it looks in each mirror image (stairs turn to face the right way).
export function symmetricPlacements(cells, mode, sx, sz, id) {
  const seen = new Map();
  const add = (x, y, z, v) => {
    if (!seen.has(`${x},${y},${z}`)) seen.set(`${x},${y},${z}`, [x, y, z, v]); // a cell you pointed at keeps its own direction
  };
  for (const [x, y, z] of cells) add(x, y, z, id);
  for (const [x, y, z] of cells) {
    if (mode.includes('x')) add(sx - 1 - x, y, z, flipStair(id, 'x'));
    if (mode.includes('z')) add(x, y, sz - 1 - z, flipStair(id, 'z'));
    if (mode === 'xz') add(sx - 1 - x, y, sz - 1 - z, turnStair(id, 2));
  }
  return [...seen.values()];
}

// Symmetric building: repeat cells across the middle of the diorama.
// mode: 'off' | 'x' (left-right) | 'z' (front-back) | 'xz' (both). Returns de-duplicated [x, y, z] cells.
export function symmetricCells(cells, mode, sx, sz = sx) {
  if (mode === 'off') return cells;
  const seen = new Map();
  const add = (x, y, z) => seen.set(`${x},${y},${z}`, [x, y, z]);
  for (const [x, y, z] of cells) {
    add(x, y, z);
    if (mode.includes('x')) add(sx - 1 - x, y, z);
    if (mode.includes('z')) add(x, y, sz - 1 - z);
    if (mode === 'xz') add(sx - 1 - x, y, sz - 1 - z);
  }
  return [...seen.values()];
}
