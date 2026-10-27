// Measuring between two cells (no DOM, so it can be tested in Node). Cells are [x, y, z]; +x is east, +z is south, +y is up.

const word = (n, plus, minus) => `${Math.abs(n)} ${n > 0 ? plus : minus}`;

// The box of cells from a to b (both corners included): its lowest and highest cell.
const boxOf = (a, b) => ({ min: [0, 1, 2].map((i) => Math.min(a[i], b[i])), max: [0, 1, 2].map((i) => Math.max(a[i], b[i])) });

// How many spaces the box from a to b holds and how many of them have a block in.
export function countBlocks(world, a, b) {
  const { min, max } = boxOf(a, b);
  let blocks = 0;
  for (let y = min[1]; y <= max[1]; y++) for (let z = min[2]; z <= max[2]; z++) for (let x = min[0]; x <= max[0]; x++) if (world.get(x, y, z)) blocks++;
  const cells = (max[0] - min[0] + 1) * (max[1] - min[1] + 1) * (max[2] - min[2] + 1);
  return { cells, blocks };
}

// The middle of the box from a to b: the cell box to highlight (one cell on an axis with an odd number of cells, the two in the
// middle when the number is even) and a sentence about it.
export function centerOf(a, b) {
  const { min, max } = boxOf(a, b);
  const lo = [0, 1, 2].map((i) => Math.floor((min[i] + max[i]) / 2));
  const hi = [0, 1, 2].map((i) => Math.ceil((min[i] + max[i]) / 2));
  const size = [0, 1, 2].map((i) => hi[i] - lo[i] + 1);
  const single = size.every((n) => n === 1);
  return {
    lo,
    hi,
    size,
    text: single ? 'The middle is the highlighted block.' : `The middle is between the blocks of the highlighted ${size.join('×')} area (an even number of blocks across, so there is no single middle one).`,
  };
}

// Everything the Measure bar shows for two chosen cells: the size of the box, how many blocks are in it, and the distance.
export function describe(world, a, b) {
  const m = measure(a, b);
  const { cells, blocks } = countBlocks(world, a, b);
  return `${m.box.join('×')} box: ${cells} space${cells === 1 ? '' : 's'}, ${blocks} block${blocks === 1 ? '' : 's'} in it — ${m.text}`;
}

// How far apart two cells are: the step along each axis, the straight line between their centres, and the box that holds both.
export function measure(a, b) {
  const [dx, dy, dz] = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const line = Math.hypot(dx, dy, dz);
  const box = [Math.abs(dx) + 1, Math.abs(dy) + 1, Math.abs(dz) + 1];
  const steps = [];
  if (dx) steps.push(word(dx, 'east', 'west'));
  if (dy) steps.push(word(dy, 'up', 'down'));
  if (dz) steps.push(word(dz, 'south', 'north'));
  const same = steps.length === 0;
  const round = (n) => (Math.round(n * 10) / 10).toString();
  return {
    dx,
    dy,
    dz,
    line,
    box,
    // short text for the label drawn in the scene
    label: same ? 'same block' : `${round(line)} blocks`,
    // the full sentence for the status bar
    text: same ? 'Same block: nothing between them.' : `${steps.join(' · ')} — straight line ${round(line)} — a box around both is ${box.join('×')}`,
  };
}
