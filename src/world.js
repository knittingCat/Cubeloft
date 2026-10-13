// Pure voxel-world logic: no DOM, no three.js. Cell (x, y, z): x/z in [0, size), y in [0, HEIGHT).
// A cell occupies [x, x+1] x [y, y+1] x [z, z+1]; the diorama stand's top surface is the plane y = 0.

export const HEIGHT = 32;

// ---- people (decorative figures with a customizable outfit; not part of the block grid) ----
export const PERSON_CHOICES = {
  pose: ['standing', 'sitting', 'lying', 'lyingFront'], // sitting = on the floor of the cell, legs forward; lying = on their back, lyingFront = on their front
  hairStyle: ['none', 'short', 'long'],
  sleeves: ['short', 'long', 'none'],
  bottoms: ['pants', 'shorts', 'skirt'],
  hat: ['none', 'cap', 'beanie', 'tophat', 'crown'],
};
export const PERSON_DEFAULTS = {
  rot: 0,
  pose: 'standing',
  twist: 0, // whole person turned further, in 30 degree steps on top of rot (0..11)
  headTurn: 0, // head turned left/right in 30 degree steps (-6..6, a full turn)
  headTilt: 0, // head tilted up (+) or down (-) in 20 degree steps (-2..2)
  skin: '#f1c27d',
  hair: '#3b2a1a',
  hairStyle: 'short',
  shirt: '#3b82f6',
  pants: '#374151',
  shoes: '#111827',
  sleeves: 'short',
  bottoms: 'pants',
  hat: 'none',
  hatColor: '#e11d48',
  name: '',
};
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

// Keep only valid values (used for anything loaded from a file, link or the server).
export function cleanPerson(p) {
  const out = { ...PERSON_DEFAULTS };
  for (const key of ['skin', 'hair', 'shirt', 'pants', 'shoes', 'hatColor']) if (COLOR_RE.test(p[key])) out[key] = p[key].toLowerCase();
  for (const key of Object.keys(PERSON_CHOICES)) if (PERSON_CHOICES[key].includes(p[key])) out[key] = p[key];
  out.headTurn = Math.max(-6, Math.min(6, Math.round(Number(p.headTurn)) || 0));
  out.twist = ((Math.round(Number(p.twist)) || 0) % 12 + 12) % 12;
  out.headTilt = Math.max(-2, Math.min(2, Math.round(Number(p.headTilt)) || 0));
  out.rot = Number.isInteger(p.rot) ? ((p.rot % 4) + 4) % 4 : 0;
  out.name = typeof p.name === 'string' ? p.name.slice(0, 30) : '';
  out.x = Number(p.x);
  out.y = Number(p.y);
  out.z = Number(p.z);
  return out;
}
// ---- doors (one cell wide, two cells tall, 3/16 of a cell thick, like Minecraft's; not part of the block grid) ----
// (x, y, z) is the lower cell; the door also fills the cell above. rot = which edge of the cell the closed door sits
// on (0 = north/-z, 1 = east/+x, 2 = south/+z, 3 = west/-x). Open doors swing back onto the hinge edge (left side).
export const DOOR_THICKNESS = 3 / 16;
export const DOOR_WOODS = [12, 29, 30, 31, 32, 33, 34, 35]; // plank block ids: plain planks and the coloured ones
export function cleanDoor(d) {
  const out = { rot: 0, open: false, wood: 12 };
  out.rot = Number.isInteger(d.rot) ? ((d.rot % 4) + 4) % 4 : 0;
  out.open = d.open === true;
  if (DOOR_WOODS.includes(d.wood)) out.wood = d.wood;
  out.x = Number(d.x);
  out.y = Number(d.y);
  out.z = Number(d.z);
  return out;
}
export const SIZES = { small: 24, medium: 32, large: 48 };

export class World {
  // sx = width (x), sz = depth (z); sz defaults to sx (a square). `size` is the longer side, for scaling things.
  constructor(sx = 32, sz = sx) {
    this.sx = sx;
    this.sz = sz;
    this.size = Math.max(sx, sz);
    this.height = HEIGHT;
    this.cells = new Uint8Array(sx * sz * HEIGHT); // 0 = empty, otherwise a block id
    this.labels = []; // { id, x, y, z, text }
    this.people = []; // { id, x, y, z, rot, skin, hair, ... } see PERSON_DEFAULTS
    this.nextPersonId = 1;
    this.doors = []; // { id, x, y, z, rot, open, wood } see cleanDoor
    this.nextDoorId = 1;
    this.meta = { sky: 'day', title: '', subtitle: '' };
    this.undoStack = [];
    this.redoStack = [];
    this.nextLabelId = 1;
    this.listeners = new Set();
  }

  // ----- cells -----
  index(x, y, z) {
    return x + this.sx * (z + this.sz * y);
  }
  inBounds(x, y, z) {
    return x >= 0 && y >= 0 && z >= 0 && x < this.sx && z < this.sz && y < this.height;
  }
  get(x, y, z) {
    return this.inBounds(x, y, z) ? this.cells[this.index(x, y, z)] : 0;
  }
  coords(i) {
    const x = i % this.sx;
    const z = Math.floor(i / this.sx) % this.sz;
    const y = Math.floor(i / (this.sx * this.sz));
    return [x, y, z];
  }
  count() {
    let n = 0;
    for (let i = 0; i < this.cells.length; i++) if (this.cells[i]) n++;
    return n;
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  emit(event) {
    for (const fn of this.listeners) fn(event);
  }

  // Set many cells in ONE undo step. list: [[x, y, z, id], ...]. Returns number of cells changed.
  setMany(list, { record = true } = {}) {
    const changes = [];
    for (const [x, y, z, id] of list) {
      if (!this.inBounds(x, y, z)) continue;
      const i = this.index(x, y, z);
      if (this.cells[i] === id) continue;
      changes.push({ i, from: this.cells[i], to: id });
      this.cells[i] = id;
    }
    if (record) this.settleSources(changes);
    if (!changes.length) return 0;
    if (record) {
      this.undoStack.push({ cells: changes });
      this.redoStack.length = 0;
      if (this.undoStack.length > 200) this.undoStack.shift();
    }
    this.emit({ type: 'cells', changes });
    return changes.length;
  }

  // A water or lava source with nothing under it drops until it rests on something. Called after an edit
  // with the changes made so far; the moves are added to the same list (so they undo together).
  settleSources(changes) {
    const seen = new Set();
    for (const c of [...changes]) {
      const [x, y, z] = this.coords(c.i);
      for (const yy of [y, y + 1]) {
        const k = this.index(x, Math.min(yy, this.height - 1), z);
        if (seen.has(k)) continue;
        seen.add(k);
        let cy = Math.min(yy, this.height - 1);
        const id = this.get(x, cy, z);
        if (id !== 9 && id !== 10) continue;
        let ny = cy;
        while (ny > 0 && this.get(x, ny - 1, z) === 0) ny--;
        if (ny === cy) continue;
        const from = this.index(x, cy, z);
        const to = this.index(x, ny, z);
        changes.push({ i: from, from: id, to: 0 }, { i: to, from: 0, to: id });
        this.cells[from] = 0;
        this.cells[to] = id;
      }
    }
  }

  // Like setMany, but also adds text labels, all as ONE undo step (used by paste).
  setManyWithLabels(list, labelList) {
    const changes = [];
    for (const [x, y, z, id] of list) {
      if (!this.inBounds(x, y, z)) continue;
      const i = this.index(x, y, z);
      if (this.cells[i] === id) continue;
      changes.push({ i, from: this.cells[i], to: id });
      this.cells[i] = id;
    }
    this.settleSources(changes);
    const labelsAdd = [];
    for (const l of labelList) {
      if (!this.inBounds(l.x, l.y, l.z)) continue;
      const label = { id: this.nextLabelId++, x: l.x, y: l.y, z: l.z, text: String(l.text).slice(0, 80) };
      this.labels.push(label);
      labelsAdd.push(label);
    }
    if (!changes.length && !labelsAdd.length) return 0;
    this.undoStack.push({ cells: changes, labelsAdd });
    this.redoStack.length = 0;
    if (changes.length) this.emit({ type: 'cells', changes });
    if (labelsAdd.length) this.emit({ type: 'labels' });
    return changes.length + labelsAdd.length;
  }

  // Remember what the scene looked like when it was created or opened (the "starting scene"): Clear leaves
  // those blocks, signs and people alone and only removes what was added afterwards. `from` may be another
  // world with the same size (used to restore the starting scene after a page reload).
  markStart(from = this) {
    if (from.sx !== this.sx || from.sz !== this.sz) return;
    const labelKey = (l) => `${l.x},${l.y},${l.z},${l.text}`;
    this.start = { cells: from.cells.slice(), labels: new Set(from.labels.map(labelKey)), people: new Set(from.people.map((p) => p.id)), doors: new Set(from.doors.map((d) => d.id)) };
  }
  isStartCell(x, y, z, id) {
    return !!this.start && this.start.cells[this.index(x, y, z)] === id;
  }
  isStartLabel(l) {
    return !!this.start && this.start.labels.has(`${l.x},${l.y},${l.z},${l.text}`);
  }
  isStartDoor(d) {
    return !!this.start && this.start.doors.has(d.id);
  }
  isStartPerson(p) {
    return !!this.start && this.start.people.has(p.id);
  }

  // Remove every block and sign inside the box (corners in any order) as ONE undo step.
  // keep(x, y, z, id) => true leaves that block alone (used so Clear keeps the starting scene).
  // keepLabel(label) / keepPerson(person) => true leaves that sign / person alone.
  clearRegion(a, b, { keep = null, keepLabel = null, keepPerson = null, keepDoor = null } = {}) {
    const lo = [0, 1, 2].map((i) => Math.min(a[i], b[i]));
    const hi = [0, 1, 2].map((i) => Math.max(a[i], b[i]));
    const changes = [];
    for (let y = Math.max(lo[1], 0); y <= Math.min(hi[1], this.height - 1); y++) {
      for (let z = Math.max(lo[2], 0); z <= Math.min(hi[2], this.sz - 1); z++) {
        for (let x = Math.max(lo[0], 0); x <= Math.min(hi[0], this.sx - 1); x++) {
          const i = this.index(x, y, z);
          if (this.cells[i] && !(keep && keep(x, y, z, this.cells[i]))) {
            changes.push({ i, from: this.cells[i], to: 0 });
            this.cells[i] = 0;
          }
        }
      }
    }
    const inside = (l) => l.x >= lo[0] && l.x <= hi[0] && l.y >= lo[1] && l.y <= hi[1] && l.z >= lo[2] && l.z <= hi[2];
    const goesL = (l) => inside(l) && !(keepLabel && keepLabel(l));
    const goesP = (p) => inside(p) && !(keepPerson && keepPerson(p));
    const labelsRemove = this.labels.filter(goesL);
    this.labels = this.labels.filter((l) => !goesL(l));
    const peopleRemove = this.people.filter(goesP).map((p) => ({ ...p }));
    this.people = this.people.filter((p) => !goesP(p));
    const goesD = (d) => inside(d) && !(keepDoor && keepDoor(d));
    const doorsRemove = this.doors.filter(goesD).map((d) => ({ ...d }));
    this.doors = this.doors.filter((d) => !goesD(d));
    if (!changes.length && !labelsRemove.length && !peopleRemove.length && !doorsRemove.length) return { blocks: 0, labels: 0, people: 0, doors: 0 };
    this.undoStack.push({ cells: changes, labelsRemove, peopleRemove, doorsRemove });
    this.redoStack.length = 0;
    if (changes.length) this.emit({ type: 'cells', changes });
    if (labelsRemove.length) this.emit({ type: 'labels' });
    if (peopleRemove.length) this.emit({ type: 'people' });
    if (doorsRemove.length) this.emit({ type: 'doors' });
    return { blocks: changes.length, labels: labelsRemove.length, people: peopleRemove.length, doors: doorsRemove.length };
  }

  boxCells(a, b) {
    const out = [];
    const [x0, x1] = [Math.min(a[0], b[0]), Math.max(a[0], b[0])];
    const [y0, y1] = [Math.min(a[1], b[1]), Math.max(a[1], b[1])];
    const [z0, z1] = [Math.min(a[2], b[2]), Math.max(a[2], b[2])];
    for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) out.push([x, y, z]);
    return out;
  }

  fillBox(a, b, id) {
    return this.setMany(this.boxCells(a, b).map(([x, y, z]) => [x, y, z, id]));
  }

  // ----- labels -----
  addLabel(x, y, z, text, { record = true, id } = {}) {
    const label = { id: id ?? this.nextLabelId++, x, y, z, text };
    this.nextLabelId = Math.max(this.nextLabelId, label.id + 1);
    this.labels.push(label);
    if (record) {
      this.undoStack.push({ labelAdd: label });
      this.redoStack.length = 0;
    }
    this.emit({ type: 'labels' });
    return label;
  }
  removeLabel(id, { record = true } = {}) {
    const k = this.labels.findIndex((l) => l.id === id);
    if (k < 0) return false;
    const [label] = this.labels.splice(k, 1);
    if (record) {
      this.undoStack.push({ labelRemove: label });
      this.redoStack.length = 0;
    }
    this.emit({ type: 'labels' });
    return true;
  }

  // ----- flowing water and lava -----
  // Water and lava blocks are sources. Like in Minecraft they fall down through empty cells and, once they
  // rest on something, spread sideways (water 7 cells, lava 3), getting shallower with distance.
  // Flow is worked out from the sources each time (nothing extra is saved). Where water and lava flows
  // meet, the cell turns to cobblestone. Returns [{ x, y, z, id, r, fall, step }] (r = reach left, step = how
  // many steps from the source, used to animate the spreading).
  computeFlow(cap = 30000) {
    const key = (x, y, z) => `${x},${y},${z}`;
    const canFall = (x, y, z) => y > 0 && this.get(x, y - 1, z) === 0;
    const canEnter = (x, y, z) => this.get(x, y, z) === 0 && this.inBounds(x, y, z);
    const result = new Map(); // fluid id -> Map(key -> cell)
    for (const [fid, R] of [[9, 7], [10, 3]]) {
      const best = new Map();
      let layer = [];
      for (let i = 0; i < this.cells.length; i++) {
        if (this.cells[i] === fid) {
          const [x, y, z] = this.coords(i);
          layer.push({ x, y, z, r: R, step: 0 });
        }
      }
      const improve = (next, x, y, z, r, fall, step) => {
        const k = key(x, y, z);
        const cur = best.get(k);
        if (cur && (r < cur.r || (r === cur.r && (!fall || cur.fall)))) return;
        best.set(k, { x, y, z, r, fall, step: cur ? Math.min(cur.step, step) : step });
        next.push({ x, y, z, r, step });
      };
      while (layer.length && best.size < cap) {
        const next = [];
        for (const c of layer) {
          const { x, y, z } = c;
          if (canFall(x, y, z)) {
            improve(next, x, y - 1, z, R, true, c.step + 1);
            continue;
          }
          if (c.r < 1) continue;
          // like Minecraft: if a drop is within 4 cells, only flow toward the nearest one(s)
          const open = [];
          for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) if (canEnter(x + dx, y, z + dz)) open.push([dx, dz]);
          const dists = open.map(([dx, dz]) => this.dropDistance(x, y, z, dx, dz));
          const nearest = Math.min(...dists);
          open.forEach(([dx, dz], k) => {
            if (nearest <= 4 && dists[k] !== nearest) return;
            improve(next, x + dx, y, z + dz, c.r - 1, false, c.step + 1);
          });
        }
        layer = next;
      }
      for (const cell of best.values()) {
        if (this.get(cell.x, cell.y + 1, cell.z) === fid || best.has(key(cell.x, cell.y + 1, cell.z))) cell.fall = true;
      }
      result.set(fid, best);
    }
    const out = [];
    const water = result.get(9);
    const lava = result.get(10);
    for (const [k, c] of water) {
      if (lava.has(k)) out.push({ x: c.x, y: c.y, z: c.z, id: 4, r: 0, fall: true, step: Math.max(c.step, lava.get(k).step) });
      else out.push({ ...c, id: 9 });
    }
    // flowing lava that touches water (beside it or underneath it) cools to cobblestone; lava sources are left alone
    const wet = (x, y, z) => this.get(x, y, z) === 9 || water.has(key(x, y, z));
    for (const [k, c] of lava) {
      if (water.has(k)) continue;
      const touching = wet(c.x, c.y + 1, c.z) || wet(c.x + 1, c.y, c.z) || wet(c.x - 1, c.y, c.z) || wet(c.x, c.y, c.z + 1) || wet(c.x, c.y, c.z - 1);
      out.push(touching ? { ...c, id: 4, r: 0, fall: true } : { ...c, id: 10 });
    }
    return out;
  }

  // How many steps until a cell with nothing underneath, going first one step in (dx, dz) and then in any
  // direction over empty cells. Up to 4 steps are looked at; returns 99 when there is no drop that close.
  dropDistance(x, y, z, dx, dz) {
    let frontier = [[x + dx, z + dz]];
    const seen = new Set([`${x},${z}`, `${x + dx},${z + dz}`]);
    for (let d = 1; d <= 4; d++) {
      for (const [fx, fz] of frontier) if (y > 0 && this.get(fx, y - 1, fz) === 0) return d;
      const next = [];
      for (const [fx, fz] of frontier) {
        for (const [ex, ez] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = fx + ex;
          const nz = fz + ez;
          const k = `${nx},${nz}`;
          if (seen.has(k) || this.get(nx, y, nz) !== 0 || !this.inBounds(nx, y, nz)) continue;
          seen.add(k);
          next.push([nx, nz]);
        }
      }
      frontier = next;
    }
    return 99;
  }

  // ----- people -----
  addPerson(props, { record = true, id } = {}) {
    const p = cleanPerson(props);
    if (!Number.isInteger(p.x) || !Number.isInteger(p.y) || !Number.isInteger(p.z) || !this.inBounds(p.x, p.y, p.z)) return null;
    p.id = id ?? this.nextPersonId++;
    this.nextPersonId = Math.max(this.nextPersonId, p.id + 1);
    this.people.push(p);
    if (record) {
      this.undoStack.push({ personAdd: { ...p } });
      this.redoStack.length = 0;
    }
    this.emit({ type: 'people' });
    return p;
  }
  removePerson(id, { record = true } = {}) {
    const k = this.people.findIndex((p) => p.id === id);
    if (k < 0) return false;
    const [p] = this.people.splice(k, 1);
    if (record) {
      this.undoStack.push({ personRemove: { ...p } });
      this.redoStack.length = 0;
    }
    this.emit({ type: 'people' });
    return true;
  }
  getPerson(id) {
    return this.people.find((p) => p.id === id) || null;
  }
  // Live edits while a customize window is open: not recorded; call recordPersonEdit when done.
  updatePerson(id, changes) {
    const p = this.getPerson(id);
    if (!p) return null;
    Object.assign(p, cleanPerson({ ...p, ...changes }), { id: p.id });
    this.emit({ type: 'people' });
    return p;
  }
  // One undo step for everything changed since `before` (a copy of the person taken when editing began).
  recordPersonEdit(id, before) {
    const now = this.getPerson(id);
    if (!now || JSON.stringify(before) === JSON.stringify(now)) return false;
    this.undoStack.push({ personUpdate: { before: { ...before }, after: { ...now } } });
    this.redoStack.length = 0;
    return true;
  }

  // ----- doors -----
  // The cell above must be free of blocks and of another door, and inside the stand.
  canPlaceDoor(x, y, z, ignoreId = null) {
    if (!this.inBounds(x, y, z) || !this.inBounds(x, y + 1, z)) return false;
    if (this.get(x, y, z) || this.get(x, y + 1, z)) return false;
    return !this.doors.some((d) => d.id !== ignoreId && d.x === x && d.z === z && Math.abs(d.y - y) < 2);
  }
  addDoor(props, { record = true, id } = {}) {
    const d = cleanDoor(props);
    if (![d.x, d.y, d.z].every(Number.isInteger) || !this.inBounds(d.x, d.y, d.z) || !this.inBounds(d.x, d.y + 1, d.z)) return null;
    d.id = id ?? this.nextDoorId++;
    this.nextDoorId = Math.max(this.nextDoorId, d.id + 1);
    this.doors.push(d);
    if (record) {
      this.undoStack.push({ doorAdd: { ...d } });
      this.redoStack.length = 0;
    }
    this.emit({ type: 'doors' });
    return d;
  }
  removeDoor(id, { record = true } = {}) {
    const k = this.doors.findIndex((d) => d.id === id);
    if (k < 0) return false;
    const [d] = this.doors.splice(k, 1);
    if (record) {
      this.undoStack.push({ doorRemove: { ...d } });
      this.redoStack.length = 0;
    }
    this.emit({ type: 'doors' });
    return true;
  }
  getDoor(id) {
    return this.doors.find((d) => d.id === id) || null;
  }
  // Open / close / turn / re-wood a door as one undo step.
  changeDoor(id, changes, { record = true } = {}) {
    const d = this.getDoor(id);
    if (!d) return null;
    const before = { ...d };
    Object.assign(d, cleanDoor({ ...d, ...changes }), { id: d.id });
    if (record) {
      this.undoStack.push({ doorUpdate: { before, after: { ...d } } });
      this.redoStack.length = 0;
    }
    this.emit({ type: 'doors' });
    return d;
  }

  // ----- history -----
  undo() {
    const step = this.undoStack.pop();
    if (!step) return false;
    this.apply(step, true);
    this.redoStack.push(step);
    return true;
  }
  redo() {
    const step = this.redoStack.pop();
    if (!step) return false;
    this.apply(step, false);
    this.undoStack.push(step);
    return true;
  }
  apply(step, reverse) {
    if (step.cells) {
      const changes = [];
      for (const c of reverse ? [...step.cells].reverse() : step.cells) {
        const value = reverse ? c.from : c.to;
        if (this.cells[c.i] !== value) {
          changes.push({ i: c.i, from: this.cells[c.i], to: value });
          this.cells[c.i] = value;
        }
      }
      this.emit({ type: 'cells', changes });
    }
    if (step.personAdd) {
      if (reverse) this.removePerson(step.personAdd.id, { record: false });
      else this.addPerson(step.personAdd, { record: false, id: step.personAdd.id });
    }
    if (step.personRemove) {
      if (reverse) this.addPerson(step.personRemove, { record: false, id: step.personRemove.id });
      else this.removePerson(step.personRemove.id, { record: false });
    }
    if (step.personUpdate) {
      const target = reverse ? step.personUpdate.before : step.personUpdate.after;
      this.updatePerson(target.id, target);
    }
    if (step.doorAdd) {
      if (reverse) this.removeDoor(step.doorAdd.id, { record: false });
      else this.addDoor(step.doorAdd, { record: false, id: step.doorAdd.id });
    }
    if (step.doorRemove) {
      if (reverse) this.addDoor(step.doorRemove, { record: false, id: step.doorRemove.id });
      else this.removeDoor(step.doorRemove.id, { record: false });
    }
    if (step.doorUpdate) this.changeDoor(step.doorUpdate.after.id, reverse ? step.doorUpdate.before : step.doorUpdate.after, { record: false });
    if (step.doorsRemove) {
      if (reverse) for (const d of step.doorsRemove) this.addDoor(d, { record: false, id: d.id });
      else for (const d of step.doorsRemove) this.removeDoor(d.id, { record: false });
    }
    if (step.peopleRemove) {
      if (reverse) for (const p of step.peopleRemove) this.addPerson(p, { record: false, id: p.id });
      else for (const p of step.peopleRemove) this.removePerson(p.id, { record: false });
    }
    if (step.labelsRemove) {
      if (reverse) for (const l of step.labelsRemove) this.addLabel(l.x, l.y, l.z, l.text, { record: false, id: l.id });
      else for (const l of step.labelsRemove) this.removeLabel(l.id, { record: false });
    }
    if (step.labelsAdd) {
      if (reverse) for (const l of step.labelsAdd) this.removeLabel(l.id, { record: false });
      else for (const l of step.labelsAdd) this.addLabel(l.x, l.y, l.z, l.text, { record: false, id: l.id });
    }
    if (step.labelAdd) {
      if (reverse) this.removeLabel(step.labelAdd.id, { record: false });
      else this.addLabel(step.labelAdd.x, step.labelAdd.y, step.labelAdd.z, step.labelAdd.text, { record: false, id: step.labelAdd.id });
    }
    if (step.labelRemove) {
      if (reverse) this.addLabel(step.labelRemove.x, step.labelRemove.y, step.labelRemove.z, step.labelRemove.text, { record: false, id: step.labelRemove.id });
      else this.removeLabel(step.labelRemove.id, { record: false });
    }
  }
  clearHistory() {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
  }

  // ----- ray casting (Amanatides & Woo voxel traversal) -----
  // origin/dir in world cell units. Returns null or:
  //   { cell: [x,y,z] | null, prev: [x,y,z] | null, floor: bool }
  // cell = first solid block hit; prev = the empty cell just before it (where a new block goes);
  // floor = the ray reached the stand's top surface (y = 0) first, and prev is the cell to build on.
  raycast(origin, dir, maxDist = 400) {
    const lim = [this.sx, this.height, this.sz];
    const lo = [0, 0, 0];
    const hi = lim;
    // clip the ray to the world box
    let tMin = 0;
    let tMax = maxDist;
    for (let a = 0; a < 3; a++) {
      if (Math.abs(dir[a]) < 1e-9) {
        if (origin[a] < lo[a] || origin[a] > hi[a]) return null;
      } else {
        let t1 = (lo[a] - origin[a]) / dir[a];
        let t2 = (hi[a] - origin[a]) / dir[a];
        if (t1 > t2) [t1, t2] = [t2, t1];
        tMin = Math.max(tMin, t1);
        tMax = Math.min(tMax, t2);
        if (tMin > tMax) return null;
      }
    }
    const eps = 1e-6;
    const p = [0, 1, 2].map((a) => origin[a] + dir[a] * (tMin + eps));
    const cell = p.map((v, a) => Math.min(Math.max(Math.floor(v), 0), lim[a] - 1));
    const step = dir.map((d) => (d > 0 ? 1 : d < 0 ? -1 : 0));
    const tDelta = dir.map((d) => (d === 0 ? Infinity : Math.abs(1 / d)));
    const tNext = [0, 1, 2].map((a) => {
      if (step[a] === 0) return Infinity;
      const boundary = step[a] > 0 ? cell[a] + 1 : cell[a];
      return (boundary - origin[a]) / dir[a];
    });
    let prev = null;
    for (let guard = 0; guard < (this.sx + this.sz) * 2 + this.height * 2; guard++) {
      if (this.get(cell[0], cell[1], cell[2])) return { cell: cell.slice(), prev, floor: false };
      prev = cell.slice();
      // advance along the axis with the nearest boundary
      let a = 0;
      if (tNext[1] < tNext[a]) a = 1;
      if (tNext[2] < tNext[a]) a = 2;
      if (tNext[a] > tMax) return null;
      cell[a] += step[a];
      tNext[a] += tDelta[a];
      if (cell[1] < 0) return { cell: null, prev, floor: true };
      if (!this.inBounds(cell[0], cell[1], cell[2])) return null;
    }
    return null;
  }

  // ----- serialisation -----
  // Binary layout: [version, size, height] + RLE (varint run length, block id) + UTF-8 JSON {labels, meta}
  toBytes() {
    const out = this.sx === this.sz ? [1, this.sx, this.height] : [2, this.sx, this.sz, this.height]; // v1 = square (older saves), v2 = width x depth
    const varint = (n) => {
      while (n >= 128) {
        out.push((n & 127) | 128);
        n >>>= 7;
      }
      out.push(n);
    };
    let run = 0;
    let cur = this.cells[0];
    for (let i = 0; i < this.cells.length; i++) {
      if (this.cells[i] === cur) run++;
      else {
        varint(run);
        out.push(cur);
        cur = this.cells[i];
        run = 1;
      }
    }
    varint(run);
    out.push(cur);
    const json = new TextEncoder().encode(JSON.stringify({ labels: this.labels, meta: this.meta, people: this.people, doors: this.doors }));
    const header = [];
    let n = json.length;
    while (n >= 128) {
      header.push((n & 127) | 128);
      n >>>= 7;
    }
    header.push(n);
    return Uint8Array.from([...out, ...header, ...json]);
  }

  static fromBytes(bytes) {
    if (bytes[0] !== 1 && bytes[0] !== 2) throw new Error('Unknown scene version');
    const sx = bytes[1];
    const sz = bytes[0] === 2 ? bytes[2] : sx;
    let pos = bytes[0] === 2 ? 4 : 3;
    const height = bytes[pos - 1];
    if (!(sx >= 8 && sx <= 96 && sz >= 8 && sz <= 96) || height !== HEIGHT) throw new Error('Bad scene size');
    const world = new World(sx, sz);
    const varint = () => {
      let result = 0;
      let shift = 0;
      for (;;) {
        const b = bytes[pos++];
        if (b === undefined) throw new Error('Scene data is cut off');
        result |= (b & 127) << shift;
        if (b < 128) return result >>> 0;
        shift += 7;
      }
    };
    let i = 0;
    while (i < world.cells.length) {
      const run = varint();
      const id = bytes[pos++];
      if (id === undefined || i + run > world.cells.length) throw new Error('Scene data is damaged');
      if (id) world.cells.fill(id, i, i + run);
      i += run;
    }
    const jsonLen = varint();
    const json = JSON.parse(new TextDecoder().decode(bytes.subarray(pos, pos + jsonLen)));
    for (const l of json.labels || []) world.addLabel(l.x, l.y, l.z, String(l.text).slice(0, 80), { record: false, id: l.id });
    for (const p of json.people || []) world.addPerson({ ...p }, { record: false, id: Number.isInteger(p.id) ? p.id : undefined });
    for (const d of json.doors || []) world.addDoor({ ...d }, { record: false, id: Number.isInteger(d.id) ? d.id : undefined });
    Object.assign(world.meta, json.meta || {});
    return world;
  }
}

// ----- text form (URL hash / files) -----
const b64 = (bytes) => {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const unb64 = (str) => {
  const s = atob(str.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
};
const pipe = async (bytes, stream) => new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer());

// "z" = deflate-compressed, "r" = raw (used when CompressionStream is missing)
export async function encodeWorld(world) {
  const bytes = world.toBytes();
  if (typeof CompressionStream === 'function') return 'z' + b64(await pipe(bytes, new CompressionStream('deflate-raw')));
  return 'r' + b64(bytes);
}

export async function decodeWorld(text) {
  const kind = text[0];
  const body = unb64(text.slice(1));
  if (kind === 'r') return World.fromBytes(body);
  if (kind !== 'z') throw new Error('Not a Cubeloft link');
  if (typeof DecompressionStream !== 'function') throw new Error('This browser cannot open compressed scenes');
  return World.fromBytes(await pipe(body, new DecompressionStream('deflate-raw')));
}
