// Measuring between two cells (no DOM, so it can be tested in Node). Cells are [x, y, z]; +x is east, +z is south, +y is up.

const word = (n, plus, minus) => `${Math.abs(n)} ${n > 0 ? plus : minus}`;

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
