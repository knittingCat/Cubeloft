// Copy / paste of block regions. Pure functions (no DOM), so they can be tested in Node.
// A clip is { w, h, d, cells: [[dx, dy, dz, id], ...] (non-empty blocks only), labels: [{ dx, dy, dz, text }] }.

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
    cells: clip.cells.map(([x, y, z, id]) => [d - 1 - z, y, x, id]),
    labels: clip.labels.map((l) => ({ dx: d - 1 - l.dz, dy: l.dy, dz: l.dx, text: l.text })),
  };
}

// Flip the clip left-to-right (a mirror image).
export function mirrorX(clip) {
  return {
    w: clip.w,
    h: clip.h,
    d: clip.d,
    cells: clip.cells.map(([x, y, z, id]) => [clip.w - 1 - x, y, z, id]),
    labels: clip.labels.map((l) => ({ dx: clip.w - 1 - l.dx, dy: l.dy, dz: l.dz, text: l.text })),
  };
}

// Where the clip's corner goes when the user points at a cell: centre it on the cell, bottom layer at that height.
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
