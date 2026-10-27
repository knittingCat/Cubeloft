import assert from 'node:assert/strict';
import { World, encodeWorld, decodeWorld, cleanPerson, PERSON_DEFAULTS } from '../src/world.js';
import { measure } from '../src/measure.js';

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

await test('light: sky light falls down open columns, a closed room is dark inside, a window lets some in, glow lights a room', async () => {
  const { computeLight, faceLevels, brightness } = await import('../src/light.js');
  const passes = (id) => id === 0 || id === 15; // 15 = glass
  const emit = (id) => (id === 16 ? 12 : 0); // 16 = glowstone
  const w = new World(12);
  // an open field: everything above the floor is full sky light
  w.setMany([[5, 0, 5, 1]]);
  let L = computeLight(w, passes, emit);
  assert.equal(L[w.index(5, 1, 5)], 15);
  assert.equal(faceLevels(w, L, passes, 5, 0, 5)[2], 15); // the top of the floor block looks at full light
  // a closed 3x3 room (walls at x,z = 3..5, hollow centre at 4,1,4) with a roof
  const room = [];
  for (let x = 3; x <= 5; x++) for (let z = 3; z <= 5; z++) for (let y = 0; y <= 2; y++) if (!(x === 4 && z === 4 && y === 1)) room.push([x, y, z, 2]);
  const closed = new World(12);
  closed.setMany(room);
  L = computeLight(closed, passes, emit);
  assert.equal(L[closed.index(4, 1, 4)], 0); // inside: no light at all
  assert.equal(faceLevels(closed, L, passes, 4, 0, 4)[2], 0); // the floor under it looks into the dark
  assert.equal(faceLevels(closed, L, passes, 4, 2, 4)[2], 15); // the outside of the roof looks at the sky
  assert.ok(brightness(0) < 0.2 && brightness(15) === 1);
  // swap one wall block for glass: light gets in and fades with distance
  const win = new World(12);
  win.setMany(room.filter(([x, y, z]) => !(x === 3 && y === 1 && z === 4)));
  win.setMany([[3, 1, 4, 15]]);
  L = computeLight(win, passes, emit);
  assert.equal(L[win.index(3, 1, 4)], 14); // the glass cell is lit from outside (14: one step from the open cell beside it)
  assert.equal(L[win.index(4, 1, 4)], 13);
  // a glowstone inside lights its room even with no window
  const lamp = new World(12);
  lamp.setMany(room);
  lamp.setMany([[4, 0, 4, 16]]);
  L = computeLight(lamp, passes, emit);
  assert.equal(L[lamp.index(4, 1, 4)], 11);
});

await test('lights: lamps and switches are cleaned, placed on a side, flipped by number, undone, saved and cleared', async () => {
  const { cleanLight, lampLit } = await import('../src/world.js');
  const { computeLight } = await import('../src/light.js');
  // cleaning
  assert.deepEqual(cleanLight({ kind: 'lamp', x: 1, y: 2, z: 3, mode: 'bogus', at: 9, group: 12 }), { kind: 'lamp', at: 3, group: 1, mode: 'on', times: [], x: 1, y: 2, z: 3 });
  assert.deepEqual(cleanLight({ kind: 'lamp', x: 0, y: 0, z: 0, mode: 'time', times: ['night', 'x', 'day'] }).times, ['day', 'night']);
  assert.deepEqual(cleanLight({ kind: 'lamp', x: 0, y: 0, z: 0, mode: 'time' }).times, ['night']); // a timed lamp always has a time
  assert.deepEqual(cleanLight({ kind: 'switch', x: 0, y: 0, z: 0, group: 4, on: true, mode: 'time' }), { kind: 'switch', at: 3, group: 4, on: true, x: 0, y: 0, z: 0 });
  // placing: a free cell with something to hold it on that side (the floor holds the bottom side only)
  const w = new World(12);
  w.setMany([[5, 0, 5, 1], [5, 1, 5, 1]]);
  assert.equal(w.canPlaceLight(2, 0, 2, 3), true); // stands on the floor
  assert.equal(w.canPlaceLight(2, 0, 2, 0), false); // nothing to its east
  assert.equal(w.canPlaceLight(4, 1, 5, 0), true); // stuck to the block on its east side
  assert.equal(w.canPlaceLight(5, 1, 5, 3), false); // the cell is a block
  const sw = w.addLight({ kind: 'switch', x: 4, y: 1, z: 5, at: 0, group: 2 });
  assert.equal(w.canPlaceLight(4, 1, 5, 0), false); // one object per cell and side
  const lamp = w.addLight({ kind: 'lamp', x: 2, y: 0, z: 2, at: 3, mode: 'switch', group: 2 });
  const late = w.addLight({ kind: 'lamp', x: 3, y: 0, z: 3, at: 3, mode: 'time', times: ['night'] });
  const always = w.addLight({ kind: 'lamp', x: 6, y: 0, z: 6, at: 3 });
  // which lamps are lit
  const lit = (sky) => w.lights.filter((l) => lampLit(l, sky, (g) => w.groupOn(g))).map((l) => l.id).sort();
  assert.deepEqual(lit('day'), [always.id]);
  assert.deepEqual(lit('night'), [late.id, always.id].sort());
  // flipping a number flips every switch with it (one undo step); a number with no switch does nothing
  const sw2 = w.addLight({ kind: 'switch', x: 7, y: 0, z: 7, at: 3, group: 2 });
  assert.equal(w.setGroup(2), true);
  assert.equal(w.groupOn(2) && w.getLight(sw.id).on && w.getLight(sw2.id).on, true);
  assert.deepEqual(lit('day'), [lamp.id, always.id].sort());
  assert.equal(w.setGroup(7), null);
  const steps = w.undoStack.length;
  assert.equal(w.setGroup(2), false);
  assert.equal(w.undoStack.length, steps + 1);
  w.undo();
  assert.equal(w.groupOn(2), true);
  w.redo();
  assert.equal(w.groupOn(2), false);
  // editing a lamp is one undo step
  w.changeLight(lamp.id, { mode: 'on' });
  assert.equal(w.getLight(lamp.id).mode, 'on');
  w.undo();
  assert.equal(w.getLight(lamp.id).mode, 'switch');
  // a lit lamp lights a closed room, with no window
  const room = [];
  for (let x = 3; x <= 5; x++) for (let z = 3; z <= 5; z++) for (let y = 0; y <= 2; y++) if (!(x === 4 && z === 4 && y === 1)) room.push([x, y, z, 2]);
  const closed = new World(12);
  closed.setMany(room);
  const passes = (id) => id === 0;
  assert.equal(computeLight(closed, passes, () => 0)[closed.index(4, 1, 4)], 0);
  assert.equal(computeLight(closed, passes, () => 0, [[4, 1, 4, 14]])[closed.index(4, 1, 4)], 14);
  assert.equal(computeLight(closed, passes, () => 0, [[3, 1, 3, 14]])[closed.index(3, 1, 3)], 0); // a lamp inside a block lights nothing
  // saved with the scene and loaded back; scenes without lights stay as they were
  const back = await decodeWorld(await encodeWorld(w));
  assert.deepEqual(back.lights, w.lights);
  assert.equal(back.nextLightId, w.nextLightId);
  assert.equal(new TextDecoder().decode(new World(12).toBytes()).includes('"lights"'), false);
  assert.equal(new TextDecoder().decode(w.toBytes()).includes('"lights"'), true);
  // removing, and clearing an area as one undo step (the starting scene's lights are kept)
  assert.equal(w.removeLight(late.id), true);
  w.undo();
  assert.ok(w.getLight(late.id));
  w.markStart();
  const extra = w.addLight({ kind: 'lamp', x: 8, y: 0, z: 8, at: 3 });
  const r = w.clearRegion([0, 0, 0], [11, 31, 11], { keepLight: (l) => w.isStartLight(l) });
  assert.equal(r.lights, 1);
  assert.equal(w.getLight(extra.id), null);
  assert.ok(w.getLight(lamp.id));
  w.undo();
  assert.ok(w.getLight(extra.id));
  // animation steps for switches are cleaned
  w.setAnimation([{ type: 'light', group: 2, on: true }, { type: 'light', group: 0, on: true }, { type: 'light', group: 'a' }]);
  assert.deepEqual(w.animation, [{ type: 'light', group: 2, on: true }]);
});

await test('mirror tool: the line is chosen from the pointed cell and the copy lands flush or further out, never overlapping', async () => {
  const { mirrorLineFor, mirrorBox, mirrorPlacement } = await import('../src/clipboard.js');
  const w = new World(16);
  w.setMany([[2, 0, 2, 1], [3, 1, 2, 2]]);
  w.addLabel(2, 1, 3, 'hi');
  const a = [2, 0, 2];
  const b = [3, 1, 3];
  const clip = extract(w, a, b);
  // pointing at the cell just right of the area: line on its left edge, copy flush against the area
  assert.deepEqual(mirrorLineFor(a, b, [4, 0, 2]), { axis: 'x', boundary: 4, k: 7 });
  let p = mirrorPlacement(w, clip, [2, 0, 2], mirrorLineFor(a, b, [4, 0, 2]));
  assert.deepEqual(p.cells.sort(), [[4, 1, 2, 2], [5, 0, 2, 1]]);
  assert.deepEqual(p.labels, [{ x: 5, y: 1, z: 3, text: 'hi' }]);
  // to the left: the line sits on the right edge of the pointed cell
  assert.deepEqual(mirrorLineFor(a, b, [0, 0, 3]), { axis: 'x', boundary: 1, k: 1 });
  // beyond in z more than x picks the z axis
  assert.equal(mirrorLineFor(a, b, [3, 0, 9]).axis, 'z');
  // inside the area: its nearest side
  assert.deepEqual(mirrorLineFor(a, b, [2, 0, 2]), { axis: 'x', boundary: 2, k: 3 });
  assert.deepEqual(mirrorBox(a, b, mirrorLineFor(a, b, [4, 0, 2])), [[5, 0, 2], [4, 1, 3]]);
  // a copy that would leave the world is dropped and counted
  p = mirrorPlacement(w, clip, [2, 0, 2], mirrorLineFor(a, b, [12, 0, 2]));
  assert.equal(p.cells.length, 0);
  assert.equal(p.dropped, 3);
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
  assert.deepEqual(r, { blocks: 4 * 3 * 4, labels: 0, people: 0, doors: 0, lights: 0 }); // the sign at y=3 is above the box
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
  assert.deepEqual(w.clearRegion([0, 0, 0], [5, 3, 5]), { blocks: 0, labels: 0, people: 0, doors: 0, lights: 0 }); // nothing left: no history entry
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

await test('measure: steps along each axis, straight line and the box round both cells', async () => {
  const m = measure([0, 0, 0], [5, 2, -3]);
  assert.deepEqual([m.dx, m.dy, m.dz], [5, 2, -3]);
  assert.deepEqual(m.box, [6, 3, 4]);
  assert.equal(m.label, '6.2 blocks');
  assert.equal(m.text, '5 east · 2 up · 3 north — straight line 6.2 — a box around both is 6×3×4');
  assert.equal(measure([3, 0, 0], [0, 0, 0]).text.startsWith('3 west'), true);
  assert.equal(measure([1, 4, 1], [1, 1, 1]).text.startsWith('3 down'), true);
  assert.equal(measure([2, 2, 2], [2, 2, 2]).label, 'same block');
});

await test('lights: a lamp on a ceiling can hang on a string, and the light comes from the bulb', async () => {
  const { cleanLight, bulbCell, MAX_STRING } = await import('../src/world.js');
  assert.equal(cleanLight({ kind: 'lamp', at: 2, string: 3, x: 1, y: 5, z: 1 }).string, 3);
  assert.equal(cleanLight({ kind: 'lamp', at: 2, string: 99, x: 1, y: 5, z: 1 }).string, MAX_STRING);
  assert.equal(cleanLight({ kind: 'lamp', at: 2, string: -2, x: 1, y: 5, z: 1 }).string, 0);
  assert.equal(cleanLight({ kind: 'lamp', at: 2, string: 'long', x: 1, y: 5, z: 1 }).string, 0);
  assert.equal('string' in cleanLight({ kind: 'lamp', at: 3, string: 3, x: 1, y: 5, z: 1 }), false, 'only a lamp on a ceiling hangs');
  assert.equal('string' in cleanLight({ kind: 'switch', at: 2, string: 3, x: 1, y: 5, z: 1 }), false);
  const w = new World(12);
  w.setMany([[4, 5, 4, 3], [4, 2, 4, 3]]); // a ceiling block at y 5, and something on the floor of the string's way down at y 2
  assert.equal(w.canPlaceLight(4, 4, 4, 2, null, 0), true); // the ceiling cell is y 4 (the block above it is at y 5)
  assert.equal(w.canPlaceLight(4, 4, 4, 2, null, 1), true);
  assert.equal(w.canPlaceLight(4, 4, 4, 2, null, 2), false); // the second cell down (y 2) is a block: the string cannot go through it
  assert.equal(w.canPlaceLight(4, 4, 4, 2, null, 3), false);
  const lamp = w.addLight({ kind: 'lamp', x: 4, y: 4, z: 4, at: 2, string: 1 });
  assert.deepEqual(bulbCell(lamp), [4, 3, 4]);
  assert.deepEqual(bulbCell({ x: 1, y: 3, z: 1 }), [1, 3, 1]);
  const back = await decodeWorld(await encodeWorld(w));
  assert.equal(back.lights[0].string, 1, 'the string is saved');
  w.changeLight(lamp.id, { string: 0 });
  assert.equal(w.getLight(lamp.id).string, 0);
  w.undo();
  assert.equal(w.getLight(lamp.id).string, 1, 'and undone');
});

await test('lights: a lamp that shines down lights a floor within 7 blocks strongly; a plain lamp and a farther floor are as before', async () => {
  const { computeLight } = await import('../src/light.js');
  const { MAX_STRING } = await import('../src/world.js');
  assert.equal(MAX_STRING, 31);
  const w = new World(16);
  w.setMany(w.boxCells([0, 0, 0], [15, 0, 15]).map(([x, y, z]) => [x, y, z, 3])); // a stone floor; the air above it is y 1
  const passes = (id) => id === 0;
  const at = (L, x, y, z) => L[w.index(x, y, z)];
  const plain = computeLight(w, passes, () => 0, [[8, 8, 8, 14]], { sky: false });
  const down = computeLight(w, passes, () => 0, [[8, 8, 8, 14, 7]], { sky: false });
  assert.equal(at(plain, 8, 1, 8), 7); // 7 blocks below: one level lost per block, as before
  assert.equal(at(down, 8, 1, 8), 12); // an aura that reaches the floor
  assert.equal(at(plain, 10, 1, 8) <= at(down, 10, 1, 8), true);
  assert.equal(at(down, 8, 8, 8), 14);
  // 8 blocks up is outside the aura's reach: the same as a plain lamp
  const far = computeLight(w, passes, () => 0, [[8, 9, 8, 14, 7]], { sky: false });
  const farPlain = computeLight(w, passes, () => 0, [[8, 9, 8, 14]], { sky: false });
  assert.equal(at(far, 8, 1, 8), at(farPlain, 8, 1, 8));
  // light still does not go through blocks: a roof block under the lamp keeps the floor under it dark
  const roofed = new World(16);
  roofed.setMany(roofed.boxCells([0, 0, 0], [15, 0, 15]).map(([x, y, z]) => [x, y, z, 3]).concat(roofed.boxCells([5, 4, 5], [11, 4, 11]).map(([x, y, z]) => [x, y, z, 3])));
  const shut = computeLight(roofed, passes, () => 0, [[8, 8, 8, 14, 7]], { sky: false });
  assert.equal(shut[roofed.index(8, 1, 8)] < 10, true);
});

await test('light: does not leak through a diagonal wall or a closed door', async () => {
  const { computeLight } = await import('../src/light.js');
  const { HEIGHT } = await import('../src/world.js');
  const passes = (id) => id === 0;
  // a full-height wall running corner to corner: the blocks touch only at their edges, and no light may slip between them
  const w = new World(24);
  w.setMany(Array.from({ length: 24 }, (_, i) => Array.from({ length: HEIGHT }, (_, y) => [i, y, i, 2])).flat());
  for (const src of [[8, 2, 4, 14], [8, 2, 4, 14, 7], [10, 10, 6, 14, 7]]) {
    const L = computeLight(w, passes, () => 0, [src], { sky: false });
    let far = 0;
    for (let y = 0; y < HEIGHT; y++) for (let z = 0; z < 24; z++) for (let x = 0; x < 24; x++) if (z > x && L[w.index(x, y, z)] > 0) far++;
    assert.equal(far, 0, `lamp ${src}: nothing lit on the far side`);
  }
  // a wall with a two-cell doorway: light goes through while the door is open and stops when it is shut
  const d = new World(24);
  d.setMany(d.boxCells([0, 0, 12], [23, HEIGHT - 1, 12]).map(([x, y, z]) => [x, y, z, 2]));
  d.setMany([[10, 0, 12, 0], [10, 1, 12, 0]]);
  const behind = (L) => {
    let n = 0;
    for (let y = 0; y < HEIGHT; y++) for (let z = 13; z < 24; z++) for (let x = 0; x < 24; x++) if (L[d.index(x, y, z)] > 0) n++;
    return n;
  };
  const open = computeLight(d, passes, () => 0, [[10, 1, 8, 14]], { sky: false });
  const shut = computeLight(d, passes, () => 0, [[10, 1, 8, 14]], { sky: false, shut: new Set([d.index(10, 0, 12), d.index(10, 1, 12)]) });
  assert.equal(behind(open) > 100, true);
  assert.equal(behind(shut), 0);
  // light still goes round a corner and through steps in a straight (face) path
  const L = computeLight(w, passes, () => 0, [[8, 2, 4, 14]], { sky: false });
  assert.equal(L[w.index(8, 2, 4)], 14);
  assert.equal(L[w.index(8, 2, 5)], 13);
});

await test('measure: counts the blocks in the box and finds its middle', async () => {
  const { countBlocks, centerOf, describe } = await import('../src/measure.js');
  const w = new World(12);
  w.setMany([[1, 0, 1, 3], [2, 0, 1, 3], [3, 1, 2, 3], [9, 9, 9, 3]]);
  assert.deepEqual(countBlocks(w, [1, 0, 1], [3, 1, 2]), { cells: 12, blocks: 3 }); // 3x2x2 spaces, three with a block
  assert.deepEqual(countBlocks(w, [3, 1, 2], [1, 0, 1]), { cells: 12, blocks: 3 }); // either corner first
  assert.deepEqual(countBlocks(w, [5, 5, 5], [5, 5, 5]), { cells: 1, blocks: 0 });
  const odd = centerOf([0, 0, 0], [4, 2, 6]); // 5 x 3 x 7: a single middle block
  assert.deepEqual([odd.lo, odd.hi], [[2, 1, 3], [2, 1, 3]]);
  assert.match(odd.text, /the highlighted block/);
  const even = centerOf([0, 0, 0], [3, 2, 5]); // 4 x 3 x 6: two in the middle along x and z
  assert.deepEqual([even.lo, even.hi], [[1, 1, 2], [2, 1, 3]]);
  assert.deepEqual(even.size, [2, 1, 2]);
  assert.match(even.text, /2×1×2/);
  assert.equal(describe(w, [1, 0, 1], [3, 1, 2]).startsWith('3×2×2 box: 12 spaces, 3 blocks in it — '), true);
  assert.match(describe(w, [5, 5, 5], [5, 5, 5]), /^1×1×1 box: 1 space, 0 blocks in it/);
});

await test('light: a lamp lights a round ball, not a diamond', async () => {
  const { computeLight } = await import('../src/light.js');
  const w = new World(16);
  const passes = (id) => id === 0;
  const L = computeLight(w, passes, () => 0, [[8, 5, 8, 14]], { sky: false });
  const at = (dx, dy, dz) => L[w.index(8 + dx, 5 + dy, 8 + dz)];
  assert.equal(at(0, 0, 0), 14);
  assert.equal(at(3, 0, 0), 11); // along an axis: one level per cell, as before
  assert.equal(at(3, 0, 3), 10); // across the floor diagonal: 14 - 4.24 (a diamond would give 8)
  assert.equal(at(2, 2, 2), 11); // a corner: 14 - 3.46
  assert.equal(at(0, 0, 3), at(3, 0, 0)); // the same in every direction
  assert.equal(at(0, 3, 0), at(3, 0, 0));
  // a wall's corner does not let it through: two solid blocks touching only at an edge
  const wall = new World(16);
  wall.setMany([[9, 5, 8, 2], [8, 5, 9, 2]]);
  const M = computeLight(wall, passes, () => 0, [[8, 5, 8, 14]], { sky: false });
  assert.ok(M[wall.index(9, 5, 9)] < 14 - Math.SQRT2 - 0.5, 'light goes round the corner, not through it');
});

await test('stairs: ids are unique per block and direction, and turn and flip like the clipboard says', async () => {
  const { BLOCKS, BLOCK_BY_ID, STAIR_BLOCKS, stairId, isStair, turnStair, flipStair } = await import('../src/blocks.js');
  const ids = new Set([...BLOCKS, ...STAIR_BLOCKS].map((b) => b.id));
  assert.equal(ids.size, BLOCKS.length + STAIR_BLOCKS.length);
  assert.equal(Math.max(...ids) < 256, true);
  assert.equal(stairId(9, 0), 0, 'water cannot be stairs');
  assert.equal(stairId(10, 0), 0, 'lava cannot be stairs');
  assert.equal(BLOCK_BY_ID.get(stairId(3, 2)).name, 'Stone stairs');
  assert.equal(isStair(stairId(3, 2)), true);
  assert.equal(isStair(3), false);
  assert.equal(BLOCK_BY_ID.get(turnStair(stairId(3, 3), 1)).stair.rot, 0);
  assert.equal(turnStair(3, 1), 3);
  const east = stairId(12, 1);
  assert.equal(flipStair(east, 'x'), stairId(12, 3)); // left-right: east and west swap
  assert.equal(flipStair(east, 'z'), east); // front-back leaves east alone
  assert.equal(flipStair(stairId(12, 0), 'z'), stairId(12, 2));
});

await test('stairs: clipboard rotate and mirror turn them; symmetric building mirrors them', async () => {
  const { stairId } = await import('../src/blocks.js');
  const { symmetricPlacements } = await import('../src/clipboard.js');
  const clip = { w: 2, h: 1, d: 1, cells: [[0, 0, 0, stairId(3, 1)]], labels: [] };
  assert.equal(rotate90(clip).cells[0][3], stairId(3, 2)); // east turned clockwise climbs south
  assert.equal(mirrorX(clip).cells[0][3], stairId(3, 3));
  const placed = symmetricPlacements([[0, 0, 0]], 'x', 5, 5, stairId(3, 1));
  assert.deepEqual(placed.map((p) => p[3]), [stairId(3, 1), stairId(3, 3)]);
  const middle = symmetricPlacements([[2, 0, 0]], 'x', 5, 5, stairId(3, 1)); // the middle cell is its own mirror image: it keeps its direction
  assert.deepEqual(middle, [[2, 0, 0, stairId(3, 1)]]);
});

await test('stairs: people standing on a stair block stand on its middle step', async () => {
  const { stairId } = await import('../src/blocks.js');
  const w = new World(8);
  w.setMany([[2, 0, 2, stairId(3, 0)], [3, 0, 2, 3]]);
  assert.equal(Math.abs(w.standOffset(2, 1, 2) + 1 / 3) < 1e-9, true);
  assert.equal(w.standOffset(3, 1, 2), 0);
  assert.equal(w.standOffset(2, 0, 2), 0);
  const back = await decodeWorld(await encodeWorld(w));
  assert.equal(back.get(2, 0, 2), stairId(3, 0), 'stairs survive save and load');
});

console.log(`${n} tests passed`);
