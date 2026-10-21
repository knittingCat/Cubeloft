import assert from 'node:assert/strict';
import { World, encodeWorld, decodeWorld, cleanPerson, PERSON_DEFAULTS } from '../src/world.js';

let n = 0;
const test = async (name, fn) => {
  await fn();
  n++;
  console.log('ok -', name);
};

await test('set/get and bounds', () => {
  const w = new World(8);
  assert.equal(w.setMany([[1, 2, 3, 5], [99, 0, 0, 1], [0, -1, 0, 1]]), 1);
  assert.equal(w.get(1, 2, 3), 5);
  assert.equal(w.get(99, 0, 0), 0);
  assert.deepEqual(w.coords(w.index(1, 2, 3)), [1, 2, 3]);
});

await test('undo / redo one step per edit', () => {
  const w = new World(8);
  w.fillBox([0, 0, 0], [1, 1, 1], 3);
  assert.equal(w.count(), 8);
  w.setMany([[5, 5, 5, 2]]);
  assert.equal(w.count(), 9);
  assert.ok(w.undo());
  assert.equal(w.count(), 8);
  assert.ok(w.undo());
  assert.equal(w.count(), 0);
  assert.equal(w.undo(), false);
  assert.ok(w.redo());
  assert.equal(w.count(), 8);
  w.setMany([[7, 7, 7, 1]]); // a new edit clears redo
  assert.equal(w.redo(), false);
});

await test('no-op edits are not recorded', () => {
  const w = new World(8);
  w.setMany([[0, 0, 0, 1]]);
  assert.equal(w.setMany([[0, 0, 0, 1]]), 0);
  assert.equal(w.undoStack.length, 1);
});

await test('raycast hits the first block and reports the cell to build on', () => {
  const w = new World(8);
  w.setMany([[4, 0, 4, 1]]);
  // from above-left looking straight along +x at y=0.5, z=4.5
  const hit = w.raycast([-3, 0.5, 4.5], [1, 0, 0]);
  assert.deepEqual(hit.cell, [4, 0, 4]);
  assert.deepEqual(hit.prev, [3, 0, 4]);
  // from above, straight down onto the block
  const top = w.raycast([4.5, 20, 4.5], [0, -1, 0]);
  assert.deepEqual(top.cell, [4, 0, 4]);
  assert.deepEqual(top.prev, [4, 1, 4]);
});

await test('raycast reaches the floor and builds at y = 0', () => {
  const w = new World(8);
  const hit = w.raycast([2.5, 10, 2.5], [0, -1, 0]);
  assert.equal(hit.floor, true);
  assert.equal(hit.cell, null);
  assert.deepEqual(hit.prev, [2, 0, 2]);
});

await test('raycast diagonal and misses', () => {
  const w = new World(16);
  w.setMany([[8, 3, 8, 1]]);
  const dir = [0.5, -0.5, 0.5].map((v) => v / Math.hypot(0.5, 0.5, 0.5));
  const hit = w.raycast([8.5 - 5, 3.5 + 5, 8.5 - 5], dir);
  assert.deepEqual(hit.cell, [8, 3, 8]);
  assert.equal(w.raycast([-5, 5, -5], [-1, 0, 0]), null); // pointing away
  assert.equal(w.raycast([100, 5, 100], [0, 1, 0]), null);
});

await test('raycast inside the world starts from the camera cell', () => {
  const w = new World(8);
  w.setMany([[6, 2, 4, 1]]);
  const hit = w.raycast([1.5, 2.5, 4.5], [1, 0, 0]);
  assert.deepEqual(hit.cell, [6, 2, 4]);
  assert.deepEqual(hit.prev, [5, 2, 4]);
});

await test('labels with undo', () => {
  const w = new World(8);
  const l = w.addLabel(1, 2, 3, 'Hello');
  assert.equal(w.labels.length, 1);
  w.undo();
  assert.equal(w.labels.length, 0);
  w.redo();
  assert.equal(w.labels[0].id, l.id);
  w.removeLabel(l.id);
  assert.equal(w.labels.length, 0);
  w.undo();
  assert.equal(w.labels[0].text, 'Hello');
});

await test('encode/decode round trip (compressed)', async () => {
  const w = new World(24);
  w.fillBox([0, 0, 0], [23, 0, 23], 1);
  w.fillBox([3, 1, 3], [6, 4, 6], 12);
  w.setMany([[10, 5, 10, 28], [11, 5, 10, 27]]);
  w.addLabel(5, 6, 5, 'Chapter 3 — “The Door”');
  w.meta.sky = 'night';
  w.meta.title = 'My scene';
  const text = await encodeWorld(w);
  assert.match(text, /^z[A-Za-z0-9_-]+$/);
  const back = await decodeWorld(text);
  assert.equal(back.size, 24);
  assert.deepEqual(back.cells, w.cells);
  assert.equal(back.labels[0].text, 'Chapter 3 — “The Door”');
  assert.equal(back.meta.sky, 'night');
  assert.ok(text.length < 400, `link too long: ${text.length}`);
});

await test('decode rejects garbage', async () => {
  await assert.rejects(() => decodeWorld('zAAAA'));
  await assert.rejects(() => decodeWorld('qq'));
});

await test('random scene survives a round trip', async () => {
  const w = new World(32);
  let seed = 7;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  for (let i = 0; i < 4000; i++) w.setMany([[Math.floor(rnd() * 32), Math.floor(rnd() * 32), Math.floor(rnd() * 32), 1 + Math.floor(rnd() * 28)]], { record: false });
  const back = await decodeWorld(await encodeWorld(w));
  assert.deepEqual(back.cells, w.cells);
});

await test('clearRegion can keep the grass floor', () => {
  const w = new World(8);
  w.fillBox([0, 0, 0], [7, 0, 7], 1); // grass floor
  w.fillBox([2, 1, 2], [3, 3, 3], 4); // a building
  w.setMany([[4, 0, 4, 4]]); // a cobblestone block sitting in the floor layer
  const keepGrass = (x, y, z, id) => y === 0 && id === 1;
  const r = w.clearRegion([0, 0, 0], [7, 31, 7], { keep: keepGrass });
  assert.equal(r.blocks, 2 * 3 * 2 + 1); // the building and the stray block; not the grass
  assert.equal(w.get(0, 0, 0), 1);
  assert.equal(w.get(4, 0, 4), 0);
  assert.equal(w.count(), 63);
  assert.ok(w.undo());
  assert.equal(w.get(4, 0, 4), 4);
  assert.equal(w.count(), 64 + 12);
});

await test('people: add, customize, remove, with undo and redo', () => {
  const w = new World(16);
  const p = w.addPerson({ x: 3, y: 0, z: 4, shirt: '#ff0000', hat: 'crown', name: 'King' });
  assert.equal(w.people.length, 1);
  assert.equal(p.shirt, '#ff0000');
  assert.equal(p.pants, PERSON_DEFAULTS.pants); // defaults fill the rest
  assert.equal(w.addPerson({ x: 99, y: 0, z: 0 }), null); // outside the diorama
  const before = { ...w.getPerson(p.id) };
  w.updatePerson(p.id, { shirt: '#00ff00', hairStyle: 'long', rot: 5 });
  assert.equal(w.getPerson(p.id).rot, 1); // turns wrap around
  assert.equal(w.recordPersonEdit(p.id, before), true);
  assert.equal(w.recordPersonEdit(p.id, w.getPerson(p.id)), false); // nothing new to record
  assert.ok(w.undo()); // undo the outfit change
  assert.equal(w.getPerson(p.id).shirt, '#ff0000');
  assert.ok(w.redo());
  assert.equal(w.getPerson(p.id).shirt, '#00ff00');
  assert.ok(w.removePerson(p.id));
  assert.equal(w.people.length, 0);
  assert.ok(w.undo()); // the person comes back with the same outfit
  assert.equal(w.getPerson(p.id).hairStyle, 'long');
  assert.equal(w.getPerson(p.id).name, 'King');
});

await test('people: can lie down; bad poses fall back to standing', () => {
  const w = new World(8);
  const a = w.addPerson({ x: 1, y: 0, z: 1, pose: 'lying' });
  assert.equal(a.pose, 'lying');
  assert.equal(w.addPerson({ x: 2, y: 0, z: 2 }).pose, 'standing');
  assert.equal(w.addPerson({ x: 3, y: 0, z: 3, pose: 'flying' }).pose, 'standing');
  const before = { ...w.getPerson(a.id) };
  w.updatePerson(a.id, { pose: 'standing' });
  w.recordPersonEdit(a.id, before);
  w.undo();
  assert.equal(w.getPerson(a.id).pose, 'lying');
});

await test('people: head turn/tilt are clamped; lying on front is a pose', () => {
  const w = new World(8);
  const a = w.addPerson({ x: 1, y: 0, z: 1, pose: 'lyingFront', headTurn: '2', headTilt: 9 });
  assert.equal(a.pose, 'lyingFront');
  assert.equal(a.headTurn, 2);
  assert.equal(a.headTilt, 2);
  assert.equal(w.addPerson({ x: 2, y: 0, z: 2, headTurn: 'x' }).headTurn, 0);
});

await test('water and lava flow: spread on the floor, fall off edges, stop at walls', () => {
  const w = new World(16);
  w.setMany(w.boxCells([0, 0, 0], [15, 0, 15]).map(([x, y, z]) => [x, y, z, 1]), { record: false });
  w.setMany([[8, 1, 8, 9]], { record: false }); // water source on the floor
  let f = w.computeFlow();
  assert.ok(f.every((c) => c.id === 9 && c.y === 1));
  assert.ok(f.some((c) => c.x === 8 + 7 && c.z === 8)); // reaches 7 cells away
  assert.ok(!f.some((c) => c.x === 8 + 8 && c.z === 8)); // but not 8
  assert.ok(!f.some((c) => c.x === 8 && c.z === 8)); // the source itself is not a flow cell
  w.setMany([[8, 1, 8, 0], [8, 1, 8, 10]], { record: false }); // lava instead
  f = w.computeFlow();
  assert.ok(f.every((c) => c.id === 10));
  assert.ok(f.some((c) => c.x === 11 && c.z === 8) && !f.some((c) => c.x === 12 && c.z === 8)); // lava reaches 3
  // a wall stops it
  w.setMany([[9, 1, 8, 4]], { record: false });
  assert.ok(!w.computeFlow().some((c) => c.x === 9 && c.z === 8));
  // a source up on a tower falls to the ground in a column and spreads there
  const t = new World(16);
  t.setMany(t.boxCells([0, 0, 0], [15, 0, 15]).map(([x, y, z]) => [x, y, z, 1]), { record: false });
  t.setMany([[5, 5, 5, 9]], { record: false });
  const g = t.computeFlow();
  for (let y = 1; y <= 4; y++) assert.ok(g.some((c) => c.x === 5 && c.y === y && c.z === 5 && c.fall), 'column at y' + y);
  assert.ok(g.some((c) => c.y === 1 && c.x === 12 && c.z === 5)); // full reach at the bottom
  // water meeting lava turns to cobblestone
  const m = new World(16);
  m.setMany(m.boxCells([0, 0, 0], [15, 0, 15]).map(([x, y, z]) => [x, y, z, 1]), { record: false });
  m.setMany([[4, 1, 8, 9], [7, 1, 8, 10]], { record: false });
  assert.ok(m.computeFlow().some((c) => c.id === 4));
});

await test('flow prefers the way to a nearby drop; flowing lava next to water turns to cobblestone', () => {
  const w = new World(16);
  w.setMany(w.boxCells([0, 0, 0], [15, 0, 15]).map(([x, y, z]) => [x, y, z, 1]), { record: false });
  w.setMany([[10, 0, 8, 0]], { record: false }); // a hole in the floor 2 cells east of the source
  w.setMany([[8, 1, 8, 9]], { record: false });
  const f = w.computeFlow();
  assert.ok(f.some((c) => c.x === 9 && c.y === 1 && c.z === 8));
  assert.ok(f.some((c) => c.x === 10 && c.y === 0 && c.z === 8)); // pours into the hole
  assert.ok(!f.some((c) => c.x === 7 && c.z === 8 && c.y === 1)); // does not go the other way
  const m = new World(16);
  m.setMany(m.boxCells([0, 0, 0], [15, 0, 15]).map(([x, y, z]) => [x, y, z, 1]), { record: false });
  m.setMany([[8, 1, 8, 10], [10, 1, 8, 9]], { record: false });
  const g = m.computeFlow();
  assert.ok(g.some((c) => c.id === 4 && c.x === 9)); // lava flow touching the water cools
  assert.ok(m.get(8, 1, 8) === 10); // the lava source itself stays lava (no obsidian)
  assert.ok(!g.some((c) => c.id === 18));
});

await test('a water source in the air falls until it rests; undo puts it back', () => {
  const w = new World(16);
  w.setMany(w.boxCells([0, 0, 0], [15, 0, 15]).map(([x, y, z]) => [x, y, z, 1]), { record: false });
  w.setMany([[3, 6, 3, 9]]);
  assert.equal(w.get(3, 6, 3), 0);
  assert.equal(w.get(3, 1, 3), 9);
  w.undo();
  assert.equal(w.get(3, 1, 3), 0);
  assert.equal(w.get(3, 6, 3), 0);
  // a source on a block falls when the block under it is removed
  w.setMany([[5, 1, 5, 3], [5, 2, 5, 10]]);
  assert.equal(w.get(5, 2, 5), 10);
  w.setMany([[5, 1, 5, 0]]);
  assert.equal(w.get(5, 1, 5), 10);
  assert.equal(w.get(5, 2, 5), 0);
  w.undo();
  assert.equal(w.get(5, 2, 5), 10);
  assert.equal(w.get(5, 1, 5), 3);
});

await test('Clear leaves the starting scene alone and removes only what was added', () => {
  const w = new World(16);
  w.setMany(w.boxCells([0, 0, 0], [15, 0, 15]).map(([x, y, z]) => [x, y, z, 1]), { record: false });
  w.setMany([[3, 1, 3, 11], [3, 2, 3, 13]], { record: false }); // a starter tree
  w.addLabel(4, 1, 4, 'Start');
  w.addPerson({ x: 5, y: 1, z: 5, name: 'Old' }, { record: false });
  w.markStart();
  w.setMany([[8, 1, 8, 3]]); // added later
  w.addLabel(9, 1, 9, 'New');
  const mine = w.addPerson({ x: 6, y: 1, z: 6, name: 'New' });
  const r = w.clearRegion([0, 0, 0], [15, 31, 15], {
    keep: (x, y, z, id) => (y === 0 && id === 1) || w.isStartCell(x, y, z, id),
    keepLabel: (l) => w.isStartLabel(l),
    keepPerson: (p) => w.isStartPerson(p),
  });
  assert.equal(r.blocks, 1);
  assert.equal(w.get(3, 1, 3), 11); // tree stays
  assert.equal(w.get(8, 1, 8), 0);
  assert.deepEqual(w.labels.map((l) => l.text), ['Start']);
  assert.deepEqual(w.people.map((p) => p.name), ['Old']);
  assert.equal(w.getPerson(mine.id), null);
});

await test('people: spin around is wrapped, head can turn a full way', () => {
  const c = cleanPerson({ x: 0, y: 0, z: 0, twist: 14, headTurn: 9 });
  assert.equal(c.twist, 2);
  assert.equal(c.headTurn, 6);
});

await test('people: invalid values are cleaned, and they survive saving', async () => {
  const c = cleanPerson({ x: 1, y: 0, z: 1, shirt: 'red', hat: 'sombrero', skin: '#ABCDEF', name: 'x'.repeat(100), rot: -1 });
  assert.equal(c.shirt, PERSON_DEFAULTS.shirt);
  assert.equal(c.hat, 'none');
  assert.equal(c.skin, '#abcdef');
  assert.equal(c.name.length, 30);
  assert.equal(c.rot, 3);
  const w = new World(16);
  w.addPerson({ x: 2, y: 1, z: 3, hair: '#112233', bottoms: 'skirt', name: 'Ada' });
  w.addPerson({ x: 5, y: 0, z: 5, hat: 'tophat', hatColor: '#000000' });
  const back = await decodeWorld(await encodeWorld(w));
  assert.equal(back.people.length, 2);
  assert.equal(back.people[0].bottoms, 'skirt');
  assert.equal(back.people[0].name, 'Ada');
  assert.equal(back.people[1].hat, 'tophat');
  assert.equal(back.nextPersonId, 3);
});

await test('clearRegion also removes people standing inside it (and undo restores them)', () => {
  const w = new World(16);
  w.addPerson({ x: 2, y: 0, z: 2 });
  w.addPerson({ x: 12, y: 0, z: 12 });
  const r = w.clearRegion([0, 0, 0], [5, 3, 5]);
  assert.equal(r.people, 1);
  assert.equal(w.people.length, 1);
  assert.ok(w.undo());
  assert.equal(w.people.length, 2);
});

const { symmetricCells, extract, rotate90, mirrorX, originFor, placement, normalizeBox } = await import('../src/clipboard.js');

await test('extract copies only blocks and labels inside the box', () => {
  const w = new World(16);
  w.setMany([[2, 0, 2, 5], [3, 1, 2, 6], [9, 0, 9, 7]]);
  w.addLabel(3, 2, 3, 'in');
  w.addLabel(12, 0, 12, 'out');
  const clip = extract(w, [3, 1, 3], [2, 0, 2]); // corners in any order
  assert.deepEqual([clip.w, clip.h, clip.d], [2, 2, 2]);
  assert.equal(clip.cells.length, 2);
  assert.ok(clip.cells.some(([x, y, z, id]) => x === 0 && y === 0 && z === 0 && id === 5));
  assert.ok(clip.cells.some(([x, y, z, id]) => x === 1 && y === 1 && z === 0 && id === 6));
  assert.equal(clip.labels.length, 0); // label at y=2 is above the box
  assert.deepEqual(normalizeBox([5, 1, 9], [2, 4, 3]), { min: [2, 1, 3], max: [5, 4, 9] });
});

await test('rotate90 four times returns the original; dimensions swap', () => {
  const w = new World(16);
  w.setMany([[0, 0, 0, 1], [2, 0, 0, 2], [0, 1, 1, 3]]);
  w.addLabel(2, 0, 1, 'sign');
  const clip = extract(w, [0, 0, 0], [2, 1, 1]);
  const r1 = rotate90(clip);
  assert.deepEqual([r1.w, r1.h, r1.d], [2, 2, 3]);
  let r = clip;
  for (let i = 0; i < 4; i++) r = rotate90(r);
  const key = (c) => JSON.stringify([c.w, c.h, c.d, [...c.cells].sort(), c.labels]);
  assert.equal(key(r), key(clip));
  // every rotated cell stays inside the new box
  for (const [x, y, z] of r1.cells) assert.ok(x >= 0 && x < r1.w && y >= 0 && y < r1.h && z >= 0 && z < r1.d);
});

await test('symmetric building repeats cells across the middle, without duplicates', () => {
  assert.deepEqual(symmetricCells([[2, 0, 3]], 'off', 8), [[2, 0, 3]]);
  assert.deepEqual(symmetricCells([[2, 0, 3]], 'x', 8), [[2, 0, 3], [5, 0, 3]]);
  assert.deepEqual(symmetricCells([[2, 0, 3]], 'z', 8), [[2, 0, 3], [2, 0, 4]]);
  const four = symmetricCells([[2, 1, 3]], 'xz', 8);
  assert.equal(four.length, 4);
  assert.deepEqual(four.map((c) => c.join()).sort(), ['2,1,3', '2,1,4', '5,1,3', '5,1,4']);
  // cells already symmetric: no duplicates
  assert.equal(symmetricCells([[2, 0, 0], [5, 0, 0]], 'x', 8).length, 2);
  // mirrored cells stay inside the world
  for (const [x, , z] of symmetricCells([[0, 0, 0], [7, 0, 7]], 'xz', 8)) assert.ok(x >= 0 && x < 8 && z >= 0 && z < 8);
});

await test('mirrorX flips left-right, twice is the original, size unchanged', () => {
  const w = new World(16);
  w.setMany([[0, 0, 0, 1], [3, 1, 2, 2]]);
  w.addLabel(0, 1, 1, 'left');
  const clip = extract(w, [0, 0, 0], [3, 1, 2]);
  const m = mirrorX(clip);
  assert.deepEqual([m.w, m.h, m.d], [clip.w, clip.h, clip.d]);
  assert.ok(m.cells.some(([x, y, z, id]) => x === 3 && y === 0 && z === 0 && id === 1));
  assert.ok(m.cells.some(([x, y, z, id]) => x === 0 && y === 1 && z === 2 && id === 2));
  assert.equal(m.labels[0].dx, 3);
  const back = mirrorX(m);
  const key = (c) => JSON.stringify([c.w, c.h, c.d, [...c.cells].sort(), c.labels]);
  assert.equal(key(back), key(clip));
});

await test('paste: placement, fit check, one undo step including labels', () => {
  const w = new World(16);
  w.fillBox([0, 0, 0], [2, 1, 2], 4);
  w.addLabel(1, 2, 1, 'house');
  const clip = extract(w, [0, 0, 0], [2, 2, 2]);
  const origin = originFor(clip, [8, 0, 8]);
  assert.deepEqual(origin, [7, 0, 7]);
  const p = placement(w, clip, origin);
  assert.equal(p.fits, true);
  const before = w.count();
  w.setManyWithLabels(p.cells, p.labels);
  assert.equal(w.count(), before + clip.cells.length);
  assert.equal(w.labels.length, 2);
  assert.equal(w.get(8, 1, 8), 4);
  assert.ok(w.undo()); // a single undo removes blocks AND the copied label
  assert.equal(w.count(), before);
  assert.equal(w.labels.length, 1);
  assert.ok(w.redo());
  assert.equal(w.labels.length, 2);
  assert.equal(placement(w, clip, [14, 0, 14]).fits, false); // sticks out of the world
  assert.equal(placement(w, clip, [7, 31, 7]).fits, false); // too tall
});

await test('clearRegion deletes blocks and signs inside only, in one undo step', () => {
  const w = new World(16);
  w.fillBox([0, 0, 0], [5, 2, 5], 3);
  w.addLabel(1, 3, 1, 'inside');
  w.addLabel(9, 0, 9, 'outside');
  const before = w.count();
  const r = w.clearRegion([4, 2, 4], [1, 0, 1]); // corners in any order
  assert.deepEqual(r, { blocks: 4 * 3 * 4, labels: 0, people: 0, doors: 0 }); // the sign at y=3 is above the box
  assert.equal(w.count(), before - 48);
  assert.equal(w.get(0, 0, 0), 3); // outside the box is untouched
  const r2 = w.clearRegion([0, 0, 0], [5, 3, 5]);
  assert.equal(r2.labels, 1);
  assert.deepEqual(w.labels.map((l) => l.text), ['outside']);
  assert.equal(w.count(), 0);
  assert.ok(w.undo()); // one undo brings back the blocks AND the sign
  assert.equal(w.labels.length, 2);
  assert.equal(w.count(), before - 48);
  assert.ok(w.redo());
  assert.equal(w.count(), 0);
  assert.deepEqual(w.clearRegion([0, 0, 0], [5, 3, 5]), { blocks: 0, labels: 0, people: 0, doors: 0 }); // nothing left: no history entry
  const steps = w.undoStack.length;
  w.clearRegion([0, 0, 0], [1, 1, 1]);
  assert.equal(w.undoStack.length, steps);
});

await test('rectangular stage: bounds, index, clear, raycast, save and open', async () => {
  const w = new World(20, 12);
  assert.equal(w.sx, 20);
  assert.equal(w.sz, 12);
  assert.equal(w.setMany([[19, 0, 11, 4], [19, 0, 12, 4], [20, 0, 0, 4]]), 1); // only the corner inside is placed
  assert.equal(w.get(19, 0, 11), 4);
  assert.deepEqual(w.coords(w.index(19, 3, 11)), [19, 3, 11]);
  const hit = w.raycast([10.5, 5, 6.5], [0, -1, 0]);
  assert.equal(hit.floor, true);
  assert.deepEqual(hit.prev, [10, 0, 6]);
  assert.equal(w.raycast([25, 5, 6], [0, -1, 0]), null); // beside the stage
  w.setMany([[1, 1, 1, 3]]);
  assert.equal(w.clearRegion([0, 0, 0], [w.sx - 1, w.height - 1, w.sz - 1]).blocks, 2);
  w.setMany([[19, 0, 11, 4], [0, 2, 5, 3]]);
  const back = await decodeWorld(await encodeWorld(w));
  assert.equal(back.sx, 20);
  assert.equal(back.sz, 12);
  assert.equal(back.get(19, 0, 11), 4);
  assert.equal(back.get(0, 2, 5), 3);
  const square = await decodeWorld(await encodeWorld(new World(16)));
  assert.equal(square.sx, 16);
  assert.equal(square.sz, 16);
});

await test('symmetry on a rectangular stage mirrors each axis by its own length', () => {
  assert.deepEqual(symmetricCells([[2, 0, 3]], 'x', 20, 12), [[2, 0, 3], [17, 0, 3]]);
  assert.deepEqual(symmetricCells([[2, 0, 3]], 'z', 20, 12), [[2, 0, 3], [2, 0, 8]]);
});

await test('doors: placement rules, open/colour changes, undo/redo, save round trip, clear', async () => {
  const w = new World(12);
  w.setMany([[3, 1, 3, 3]]); // a block where the door's upper half would go
  assert.equal(w.canPlaceDoor(3, 0, 3), false);
  assert.equal(w.canPlaceDoor(4, 0, 3), true);
  assert.equal(w.canPlaceDoor(4, 31, 3), false); // no room above
  const d = w.addDoor({ x: 4, y: 0, z: 3, rot: 5, wood: 29 });
  assert.equal(d.rot, 1);
  assert.equal(d.wood, 29);
  assert.equal(w.canPlaceDoor(4, 1, 3), false); // overlaps the door's upper half
  assert.equal(w.addDoor({ x: 4, y: 0, z: 3, wood: 999 }).wood, 12); // unknown colour -> plain planks
  w.changeDoor(d.id, { open: true });
  w.changeDoor(d.id, { wood: 33 });
  assert.equal(w.getDoor(d.id).open, true);
  w.undo();
  assert.equal(w.getDoor(d.id).wood, 29);
  w.undo();
  assert.equal(w.getDoor(d.id).open, false);
  w.redo();
  assert.equal(w.getDoor(d.id).open, true);
  const back = await decodeWorld(await encodeWorld(w));
  assert.equal(back.doors.length, 2);
  assert.equal(back.getDoor(d.id).open, true);
  const r = w.clearRegion([0, 0, 0], [11, 31, 11]);
  assert.equal(r.doors, 2);
  assert.equal(w.doors.length, 0);
  w.undo();
  assert.equal(w.doors.length, 2);
});

await test('animation: steps are cleaned, saved with the scene, and the ledge pose is accepted', async () => {
  const w = new World(12);
  const a = w.addPerson({ x: 2, y: 0, z: 2, pose: 'ledge' }, { record: false });
  const d = w.addDoor({ x: 5, y: 0, z: 5 }, { record: false });
  assert.equal(a.pose, 'ledge');
  w.setAnimation([
    { type: 'walk', person: a.id, x: 6, y: 0, z: 2 },
    { type: 'door', door: d.id, open: true, together: true },
    { type: 'wait', seconds: 500 }, // too long: capped
    { type: 'walk', person: 'x', x: 1, y: 0, z: 1 }, // invalid: dropped
    { type: 'dance' }, // unknown: dropped
    { type: 'door', door: d.id, open: 'yes', together: true }, // open must be true to count as open
  ]);
  assert.equal(w.animation.length, 4);
  assert.equal(w.animation[1].together, true);
  assert.equal(w.animation[2].seconds, 60);
  assert.equal(w.animation[3].open, false);
  const back = await decodeWorld(await encodeWorld(w));
  assert.deepEqual(back.animation, w.animation);
  w.setAnimation([
    { type: 'turn', person: a.id, x: 4, z: 2, y: 9 },
    { type: 'turn', person: a.id, x: 'left', z: 2 }, // invalid: dropped
  ]);
  assert.deepEqual(w.animation, [{ type: 'turn', person: a.id, x: 4, z: 2 }]);
  w.setAnimation([]);
  assert.equal(w.animation.length, 0);
  assert.equal('animation' in w.meta, false);
});

console.log(`${n} tests passed`);
