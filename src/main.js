import { World, SIZES, encodeWorld, decodeWorld, PERSON_CHOICES, DOOR_WOODS, MAX_ANIMATION_STEPS } from './world.js';
import { BLOCKS, BLOCK_BY_ID } from './blocks.js';
import { textureCanvas, topTextureName } from './textures.js';
import { DioramaView } from './view.js';
import { initAccount } from './account.js';
import { api } from './api.js';
import { createLive } from './live.js';
import { extract, rotate90, mirrorX, mirrorLineFor, mirrorBox, mirrorPlacement, normalizeBox, originFor, placement, symmetricCells } from './clipboard.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// ---------- storage (best effort) ----------
const store = {
  get(key) {
    try {
      return localStorage.getItem('blockscape:' + key);
    } catch {
      return null;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem('blockscape:' + key, value);
    } catch {}
  },
};

// ---------- starter scenes ----------
const NEW_MIN = 12; // blocks per side: the starter scenes (pond, path) need some room
const NEW_MAX = 96;
function makeScene(sx = 32, kind = 'grass', sz = sx) {
  const w = new World(sx, sz);
  const size = Math.max(sx, sz);
  const set = (x, y, z, id) => w.setMany([[x, y, z, id]], { record: false });
  const c = sx / 2;
  const cz = sz / 2;
  // a tree: log trunk with a rounded top of leaves (blocks that are off the stand are skipped by the world)
  const tree = (tx, tz, height = 4) => {
    for (let y = 1; y <= height; y++) set(tx, y, tz, 11);
    for (let y = height; y <= height + 2; y++) {
      const r = y === height + 2 ? 1 : 2;
      for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) if (!(dx === 0 && dz === 0 && y < height + 1)) set(tx + dx, y, tz + dz, 13);
    }
  };
  if (kind === 'grass' || kind === 'grassTree' || kind === 'forest') {
    for (let z = 0; z < sz; z++) for (let x = 0; x < sx; x++) set(x, 0, z, 1);
  }
  if (kind === 'grassTree') {
    tree(Math.floor(c) - 6, Math.floor(cz) - 4, 4);
  } else if (kind === 'forest') {
    // the same forest every time: a small pond, a dirt path winding through, and trees, bushes and rocks around them
    let seed = 20261004;
    const rand = () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const taken = new Set();
    const mark = (x, z, r) => {
      for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) taken.add(`${x + dx},${z + dz}`);
    };
    // pond
    const px = Math.floor(sx * 0.7);
    const pz = Math.floor(sz * 0.3);
    for (let dx = -7; dx <= 7; dx++) {
      for (let dz = -7; dz <= 7; dz++) {
        const d = Math.hypot(dx, dz);
        if (d < 5.4) set(px + dx, 0, pz + dz, 9); // the pond fills the whole clearing, ringed by sand
        else if (d < 6.4) set(px + dx, 0, pz + dz, 5);
      }
    }
    mark(px, pz, 8); // keep canopies off the pond
    // path: from the front edge up towards the pond, wiggling
    let x = Math.floor(c) - 4;
    for (let z = sz - 1; z >= pz + 8; z--) {
      x += Math.round(rand() * 2 - 1) * (z % 3 === 0 ? 1 : 0);
      x = Math.max(2, Math.min(sx - 3, x));
      for (const dx of [0, 1]) {
        set(x + dx, 0, z, 2);
        mark(x + dx, z, 2); // and off the path
      }
    }
    // trees, spaced out
    const count = Math.round((sx * sz) / 30); // as many as fit; canopies are 5 wide, so trees stay 6 apart and never touch
    let placed = 0;
    for (let tries = 0; tries < count * 12 && placed < count; tries++) {
      const tx = 2 + Math.floor(rand() * (sx - 4));
      const tz = 2 + Math.floor(rand() * (sz - 4));
      if (taken.has(`${tx},${tz}`)) continue;
      tree(tx, tz, 3 + Math.floor(rand() * 4));
      mark(tx, tz, 5);
      placed++;
    }
    // bushes and rocks in the gaps
    for (let n = 0; n < (sx + sz); n++) {
      const bx = 1 + Math.floor(rand() * (sx - 2));
      const bz = 1 + Math.floor(rand() * (sz - 2));
      if (w.get(bx, 0, bz) !== 1 || w.get(bx, 1, bz) !== 0) continue;
      if (rand() < 0.65) set(bx, 1, bz, 13);
      else set(bx, 1, bz, 3);
    }
  } else if (kind === 'island') {
    for (let z = 0; z < sz; z++) {
      for (let x = 0; x < sx; x++) {
        const d = Math.hypot((x + 0.5 - c) / (sx / 2), (z + 0.5 - cz) / (sz / 2)); // 1 = the edge of the stand; an oval on a non-square stand
        if (d < 0.6) set(x, 0, z, 1);
        else if (d < 0.74) set(x, 0, z, 5);
        else set(x, 0, z, 9);
      }
    }
  }
  return w;
}

// ---------- state ----------
let world;
let view;
let tool = 'build';
let selected = 1;
let boxA = null;
let sharedMode = false;
let hoverInfo = null;
let selA = null; // first corner of a selection in progress (also used by the Mirror tool)
let mirrorSel = null; // Mirror tool: the chosen area { a, b, clip, origin }, waiting for the mirror line
const AREA_TOOLS = ['box', 'select', 'paste', 'mirror']; // tools where clicks mark corners or places, not blocks
let selection = null; // { a, b } finished selection
let clip = null; // copied blocks (kept when you open another diorama)
let lastTapKey = null; // touch: first tap previews the paste, second tap places it
let cloud = null; // the saved-online diorama we are looking at, if any
let openStartPicker = () => {}; // opens the starting-scene picker for a first visit
let booted = false; // false until the first-visit sequence has finished
let signedInDuringBoot = false;
const SYMMETRY_MODES = ['off', 'x', 'z', 'xz'];
const SYMMETRY_NAMES = { off: 'off', x: 'left-right', z: 'front-back', xz: 'both ways' };
let symmetry = 'off'; // build symmetrically: every place/erase/box is repeated across the middle
let localState = ''; // browser autosave: Saving… / Saved in this browser
let cloudState = ''; // shown in the status line: Saving… / Saved / …
let cloudTimer = null;
let livePeers = []; // other people editing this diorama right now
const live = createLive({
  getWorld: () => world,
  encode: (w) => encodeWorld(w),
  onPeers: (names) => {
    livePeers = names;
    updateStatus();
  },
  // someone already editing has a newer copy than the one we loaded: take it
  onState: (text) => loadFromText(text, { cloud }),
  onLost: () => {
    toast('Live editing stopped. You may no longer be allowed to edit this diorama.', 6000);
  },
});

// Live editing is on while a class diorama that allows class editing is open for you to edit.
function syncLive() {
  const on = cloud && cloud.mine && cloud.visibility === 'class' && cloud.classEdit && !sharedMode && accountApi && accountApi.isSignedIn();
  if (on) live.connect(cloud.id);
  else live.disconnect();
}
let accountApi = null;

const stage = $('#stage');
const toastEl = $('#toast');
let toastTimer;
function toast(msg, ms = 2600) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), ms);
}

// ---------- palette ----------
const palette = $('#palette');
for (const block of BLOCKS) {
  const btn = document.createElement('button');
  btn.className = 'swatch';
  btn.dataset.id = block.id;
  btn.title = block.name + (block.id <= 9 ? ` (${block.id})` : '');
  btn.setAttribute('aria-label', block.name);
  const cv = document.createElement('canvas');
  cv.width = cv.height = 16;
  cv.getContext('2d').drawImage(textureCanvas(topTextureName(block)), 0, 0);
  btn.appendChild(cv);
  if (block.id <= 9) {
    const k = document.createElement('kbd');
    k.textContent = block.id;
    btn.appendChild(k);
  }
  btn.addEventListener('click', () => {
    selectBlock(block.id);
    if (tool !== 'build' && tool !== 'box' && tool !== 'label') setTool('build');
  });
  palette.appendChild(btn);
}

function selectBlock(id) {
  selected = id;
  $$('.swatch').forEach((b) => b.classList.toggle('selected', Number(b.dataset.id) === id));
  updateStatus();
  refreshHover();
}

function setTool(t) {
  const was = tool;
  tool = t;
  boxA = null;
  selA = null;
  lastTapKey = null;
  if (mirrorSel || was === 'mirror') {
    mirrorSel = null;
    view?.showMirrorLine(null);
    if (t !== 'mirror') selection ? view?.showSelection(selection.a, selection.b) : view?.showSelection(null); // give the Select tool's outline back
  }
  if (t === 'mirror') view?.showSelection(null);
  view?.showRegion(null, null);
  if (t !== 'paste') view?.showFootprint(null);
  $('#pasteBar').hidden = t !== 'paste';
  $$('[data-tool]').forEach((b) => b.classList.toggle('active', b.dataset.tool === t));
  updateStatus();
  refreshHover();
}

// A cell and its mirror images, for symmetric building.
const withSymmetry = (cells) => symmetricCells(cells, symmetry, world.sx, world.sz);

function cycleSymmetry() {
  symmetry = SYMMETRY_MODES[(SYMMETRY_MODES.indexOf(symmetry) + 1) % SYMMETRY_MODES.length];
  view.showSymmetry(symmetry);
  $('#symBtn').classList.toggle('active', symmetry !== 'off');
  $('#symBtn').title = `Symmetric building: ${SYMMETRY_NAMES[symmetry]} (Y to change)`;
  toast(symmetry === 'off' ? 'Symmetric building is off.' : `Symmetric building: ${SYMMETRY_NAMES[symmetry]}. Everything you place or remove is repeated on the other side of the blue line.`);
  updateStatus();
  refreshHover();
}

// What to show about saving, so there is always some feedback.
function saveSuffix() {
  if (cloud && !cloud.mine) return 'viewing someone else\'s diorama (not saved)';
  if (livePeers.length) return `${cloudState ? cloudState + ' · ' : ''}editing live with ${livePeers.join(', ')}`;
  if (cloudState) return cloudState;
  if (!accountApi) return localState;
  if (!accountApi.isSignedIn()) return `${localState ? localState + ' · ' : ''}sign in to save to your account`;
  return `${localState ? localState + ' · ' : ''}not on your account yet (press Save)`;
}

function updateStatus() {
  const names = { build: 'Build', erase: 'Erase', box: 'Box fill', pick: 'Pick', label: 'Sign', select: 'Select', paste: 'Paste', mirror: 'Mirror', person: 'Person', door: 'Door' };
  let hint = tool === 'box' ? (boxA ? ' — click the opposite corner' : ' — click a first corner') : '';
  if (tool === 'mirror') hint = mirrorSel ? ' — click where the mirror line should go (beside the area; the blue line shows it)' : selA ? ' — click the opposite corner of the area' : ' — click one corner of the area to mirror';
  if (tool === 'select') hint = selA ? ' — click the opposite corner' : selection ? ' — copied — press Paste' : ' — click one corner of the area';
  if (tool === 'person') hint = ' — click to put a person here, or click one to change their outfit';
  if (tool === 'door') hint = ' — click to place a door (it takes the planks colour you have selected), click one to open or close it, R turns it, Shift+R flips it to the other side';
  if (tool === 'paste') hint = clip ? ` — ${clip.w}×${clip.h}×${clip.d} footprint: move it, then click to place` : '';
  $('#status').textContent = `${world.count()} blocks · ${names[tool]}${hint} · ${BLOCK_BY_ID.get(selected).name}${symmetry !== 'off' ? ' · symmetry: ' + SYMMETRY_NAMES[symmetry] : ''}${saveSuffix() ? ' · ' + saveSuffix() : ''}`;
  $('#undo').disabled = !world.undoStack.length;
  $('#redo').disabled = !world.redoStack.length;
}

// ---------- world wiring ----------
let saveTimer;
function scheduleSave(remote = false) {
  if (!remote) scheduleCloudSave(); // whoever made the change saves it; the others just keep their own copy current

  localState = 'Saving…';
  updateStatus();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try {
      store.set(sharedMode ? 'shared' : 'scene', await encodeWorld(world));
      localState = 'Saved in this browser';
    } catch {
      localState = 'Could not save in this browser';
    }
    updateStatus();
  }, 500);
}

// ---------- autosave to your account ----------
// Remember which saved diorama this browser was editing, so autosave keeps working after a refresh.
function rememberCloud() {
  store.set('cloud', cloud && cloud.mine ? JSON.stringify({ id: cloud.id, title: cloud.title, owner: cloud.owner, isOwner: cloud.isOwner, visibility: cloud.visibility, classId: cloud.classId, classEdit: cloud.classEdit, hasCode: !!cloud.hasCode }) : '');
}

function setCloudState(text) {
  cloudState = text;
  updateStatus();
}

function scheduleCloudSave() {
  if (!cloud || !cloud.mine || !accountApi || !accountApi.isSignedIn()) return;
  setCloudState('Unsaved changes');
  clearTimeout(cloudTimer);
  cloudTimer = setTimeout(doCloudSave, 2500);
}

async function doCloudSave() {
  const c = cloud;
  if (!c || !c.mine) return false;
  clearTimeout(cloudTimer);
  setCloudState('Saving…');
  try {
    await api('POST', '/api/dioramas', {
      id: c.id,
      title: c.title,
      data: await encodeWorld(world),
      thumb: view.snapshot(320, 200).toDataURL('image/jpeg', 0.72),
      visibility: c.visibility || 'private', // the server keeps the current sharing for autosaves
    });
    setCloudState(cloud === c ? 'Saved' : '');
    return true;
  } catch (err) {
    if (err.status === 404 || err.status === 401) {
      cloud = null;
      rememberCloud();
      updateBanner(sharedMode);
      setCloudState('');
      syncLive();
      toast('Autosave to your account stopped (sign in again and press Save).');
    } else {
      setCloudState('Could not save online — retrying on your next change');
    }
    return false;
  }
}

function attachWorld(w) {
  world = w;
  world.onChange((e) => {
    if (e && (e.type === 'animation' || e.type === 'people' || e.type === 'doors')) renderAnimSteps();
    updateStatus();
    scheduleSave(!!(e && e.remote));
    live.send(e);
  });
  $$('[data-sky]').forEach((b) => b.classList.toggle('active', b.dataset.sky === (world.meta.sky || 'day')));
  updateStatus();
}

function updateBanner(shared) {
  const banner = $('#banner');
  const viewingOthers = cloud && !cloud.mine;
  banner.hidden = !(shared || viewingOthers);
  $('#bannerText').textContent = viewingOthers
    ? `Viewing “${cloud.title}” by ${cloud.owner}. Drag to look around, scroll to zoom.`
    : "Viewing a shared diorama. Drag to look around, scroll to zoom.";
  $('#reportBtn').hidden = !(viewingOthers && accountApi);
  // Someone else's diorama: no toolbar, no palette, no editing.
  document.body.classList.toggle('viewonly', !banner.hidden);
  if (!banner.hidden && view) {
    view.showGhost(null);
    view.showMirrorGhosts([]);
    view.showRegion(null, null);
    view.showSelection(null);
    view.showFootprint(null);
  }
}

const isViewOnly = () => document.body.classList.contains('viewonly');

// Record the starting scene (what Clear leaves alone). `restore` = a page reload: bring back the saved start.
async function rememberStart(w, restore = false) {
  try {
    if (restore) {
      const saved = store.get('start');
      if (saved) w.markStart(await decodeWorld(saved));
    } else {
      w.markStart();
      store.set('start', await encodeWorld(w));
    }
  } catch {}
}

async function loadFromText(text, { shared = false, cloud: cloudInfo = null, restore = false } = {}) {
  const w = await decodeWorld(text.trim());
  await rememberStart(w, restore);
  sharedMode = shared;
  cloud = cloudInfo;
  attachWorld(w);
  view.setWorld(w);
  selection = null;
  view.showSelection(null);
  view.showSymmetry(symmetry);
  clearTimeout(cloudTimer);
  cloudState = cloudInfo && cloudInfo.mine ? 'Saved' : '';
  if (!shared && cloudInfo) rememberCloud();
  setTool(tool);
  updateBanner(shared);
  syncLive();
}

// ---------- people ----------
const pick = (list) => list[Math.floor(Math.random() * list.length)];
const SKINS = ['#fde0c8', '#f1c27d', '#e0ac69', '#c68642', '#8d5524', '#5c3a21'];
const SHIRTS = ['#ef4444', '#f97316', '#eab308', '#22c55e', '#06b6d4', '#3b82f6', '#8b5cf6', '#ec4899', '#f8fafc', '#111827'];
const PANTS = ['#1f2937', '#374151', '#1e3a8a', '#7c2d12', '#3f6212', '#581c87', '#475569'];
const HAIRS = ['#1c1917', '#3b2a1a', '#7c4a1e', '#c27a2c', '#e5c07b', '#b91c1c', '#9ca3af'];
const CHOICE_LABELS = {
  standing: 'Standing', sitting: 'Sitting', ledge: 'Sitting on a block (legs hanging)', lying: 'Lying on back', lyingFront: 'Lying on front', none: 'None', short: 'Short', long: 'Long', pants: 'Pants', shorts: 'Shorts', skirt: 'Skirt',
  cap: 'Cap', beanie: 'Beanie', tophat: 'Top hat', crown: 'Crown',
};
const CHOICE_TITLES = { hairStyle: 'Hair', sleeves: 'Sleeves', bottoms: 'Bottoms', hat: 'Hat' };
const SLEEVE_LABELS = { short: 'Short sleeves', long: 'Long sleeves', none: 'Sleeveless' };

function randomOutfit() {
  return {
    skin: pick(SKINS),
    hair: pick(HAIRS),
    hairStyle: pick(['short', 'short', 'long', 'none']),
    shirt: pick(SHIRTS),
    pants: pick(PANTS),
    shoes: pick(['#111827', '#78350f', '#f8fafc', '#b91c1c']),
    sleeves: pick(['short', 'short', 'long', 'none']),
    bottoms: pick(['pants', 'pants', 'shorts', 'skirt']),
    hat: pick(['none', 'none', 'none', 'cap', 'beanie', 'tophat', 'crown']),
    hatColor: pick(SHIRTS),
  };
}

function openPersonDialog(id) {
  const person = world.getPerson(id);
  if (!person) return;
  const before = { ...person };
  const dlg = $('#personDialog');
  const body = $('#personBody');
  const select = (prop, label) =>
    `<label>${label}<select data-prop="${prop}">${PERSON_CHOICES[prop]
      .map((v) => `<option value="${v}">${(prop === 'sleeves' ? SLEEVE_LABELS : CHOICE_LABELS)[v]}</option>`)
      .join('')}</select></label>`;
  const color = (prop, label) => `<label>${label}<input type="color" data-prop="${prop}"></label>`;
  body.innerHTML = `
    <h2>Customize person</h2>
    <div class="hint">Skin</div>
    <div class="swatches">${SKINS.map((c) => `<button type="button" class="skin" data-skin="${c}" style="background:${c}" aria-label="Skin ${c}"></button>`).join('')}</div>
    <div class="grid2">
      ${select('pose', 'Pose')}<span></span>
      ${select('hairStyle', 'Hair')}${color('hair', 'Hair color')}
      ${select('hat', 'Hat')}${color('hatColor', 'Hat color')}
      ${select('sleeves', 'Top')}${color('shirt', 'Top color')}
      ${select('bottoms', 'Bottoms')}${color('pants', 'Bottoms color')}
    </div>
    ${color('shoes', 'Shoes')}
    <div class="grid2">
      <label>Spin around<input type="range" min="0" max="11" step="1" data-prop="twist"></label>
      <label>Head turn<input type="range" min="-6" max="6" step="1" data-prop="headTurn"></label>
      <label>Head up / down<input type="range" min="-2" max="2" step="1" data-prop="headTilt"></label>
    </div>
    <label>Name (floats above their head)<input type="text" data-prop="name" maxlength="30" autocomplete="off" placeholder="optional"></label>
    <div class="btnrow">
      <button type="button" data-act="left">Turn left</button>
      <button type="button" data-act="right">Turn right</button>
      <button type="button" data-act="random">Surprise me</button>
      <button type="button" data-act="straight">Head straight</button>
      <button type="button" data-act="move">Move</button>
      <button type="button" data-act="look">Look through their eyes</button>
    </div>
    <div class="btnrow">
      <button type="button" data-act="delete">Remove person</button>
      <button type="button" class="primary" data-act="done">Done</button>
    </div>`;
  const sync = () => {
    const p = world.getPerson(id);
    if (!p) return;
    body.querySelectorAll('[data-prop]').forEach((el) => {
      if (document.activeElement !== el || el.type === 'color') el.value = p[el.dataset.prop];
    });
    body.querySelectorAll('.skin').forEach((b) => b.classList.toggle('on', b.dataset.skin === p.skin));
  };
  sync();
  body.querySelectorAll('[data-prop]').forEach((el) => el.addEventListener('input', () => world.updatePerson(id, { [el.dataset.prop]: el.value })));
  body.querySelectorAll('.skin').forEach((b) =>
    b.addEventListener('click', () => {
      world.updatePerson(id, { skin: b.dataset.skin });
      sync();
    }),
  );
  body.querySelector('[data-act=left]').onclick = () => world.updatePerson(id, { rot: world.getPerson(id).rot + 3 });
  body.querySelector('[data-act=right]').onclick = () => world.updatePerson(id, { rot: world.getPerson(id).rot + 1 });
  body.querySelector('[data-act=random]').onclick = () => {
    world.updatePerson(id, randomOutfit());
    sync();
  };
  body.querySelector('[data-act=straight]').onclick = () => {
    world.updatePerson(id, { headTurn: 0, headTilt: 0 });
    sync();
  };
  body.querySelector('[data-act=move]').onclick = () => {
    movingPerson = id;
    dlg.close('move');
    toast('Click where this person should stand (right-click to cancel).', 5000);
  };
  body.querySelector('[data-act=look]').onclick = () => {
    dlg.close('look');
    startLooking(id);
  };
  body.querySelector('[data-act=delete]').onclick = () => {
    world.removePerson(id);
    dlg.close('removed');
  };
  body.querySelector('[data-act=done]').onclick = () => dlg.close('done');
  dlg.addEventListener(
    'close',
    () => {
      if (world.getPerson(id)) world.recordPersonEdit(id, before); // one undo step for the whole outfit change
      updateStatus();
      refreshHover();
    },
    { once: true },
  );
  dlg.showModal();
}

// ---------- pointer handling ----------
function currentHit(e) {
  const ray = view.rayFromPointer(e.clientX, e.clientY);
  return { ray, hit: world.raycast(ray.origin, ray.dir) };
}

// The mirror images of one cell (not including the cell itself).
function otherCells(cell) {
  const key = cell.join(',');
  return withSymmetry([cell]).filter((c) => c.join(',') !== key);
}

function refreshHover(e) {
  if (e) hoverInfo = e;
  if (!hoverInfo || !view || isViewOnly() || view.looking) return;
  const { ray, hit } = currentHit(hoverInfo);
  const erasing = tool === 'erase' || hoverInfo.shiftKey;
  const block = BLOCK_BY_ID.get(selected);
  view.showMirrorGhosts([]);
  if (animOpen()) {
    // no building while animating; show the destination a walking person would go to
    if ((animMode === 'walkDest' || animMode === 'turnDest') && hit?.prev && !view.animating) view.showGhost(hit.prev, { color: 0xfbbf24, opacity: 0.3 });
    else view.showGhost(null);
    return;
  }
  // pointing at a door (clicking it opens, turns or removes it): no block footprint
  if (!AREA_TOOLS.includes(tool) && view.doorAt(ray) != null) {
    view.showGhost(null);
    return;
  }
  if (tool === 'paste') {
    view.showGhost(null);
    if (!hit || !clip || !hit.prev) return view.showFootprint(null);
    const origin = originFor(clip, hit.prev);
    view.showFootprint([clip.w, clip.h, clip.d], origin, placement(world, clip, origin).fits);
    return;
  }
  if (!hit) {
    view.showGhost(null);
    view.showRegion(null, null);
    return;
  }
  if (tool === 'select') {
    const corner = hit.cell || hit.prev;
    view.showGhost(corner, { color: 0x4dd0e1, opacity: 0.3, scale: 1.03 });
    if (selA && corner) view.showRegion(selA, corner);
    return;
  }
  if (tool === 'mirror') {
    const corner = hit.cell || hit.prev;
    view.showGhost(corner, { color: 0x4dd0e1, opacity: 0.3, scale: 1.03 });
    if (!mirrorSel) {
      if (selA && corner) view.showRegion(selA, corner);
      return;
    }
    // choosing the line: show it, where the copy will land, and the copy itself (unless it is huge)
    const line = mirrorLineFor(mirrorSel.a, mirrorSel.b, corner);
    view.showMirrorLine(line.axis, line.boundary);
    const [ra, rb] = mirrorBox(mirrorSel.a, mirrorSel.b, line);
    view.showRegion(ra, rb);
    const p = mirrorPlacement(world, mirrorSel.clip, mirrorSel.origin, line);
    if (p.cells.length <= 400) view.showMirrorGhosts(p.cells, { color: 0x4dd0e1, opacity: 0.35 });
    return;
  }
  if (tool === 'door') {
    view.showGhost(hit.prev, { color: 0xffffff, opacity: 0.18 });
    if (hit.prev) view.showMirrorGhosts([[hit.prev[0], hit.prev[1] + 1, hit.prev[2]]], { color: 0xffffff, opacity: 0.18 });
  } else if (tool === 'person') {
    view.showGhost(hit.prev, { color: 0xffffff, opacity: 0.18 });
  } else if (tool === 'pick') {
    view.showGhost(hit.cell, { color: 0xffffff, opacity: 0.25, scale: 1.03 });
  } else if (tool === 'label') {
    view.showGhost(hit.prev, { color: 0xffffff, opacity: 0.2 });
  } else if (erasing && !(tool === 'box' && !boxA && !hoverInfo.shiftKey)) {
    view.showGhost(hit.cell, { color: 0xff4d4d, opacity: 0.45, scale: 1.03 });
    if (tool !== 'box' && hit.cell) view.showMirrorGhosts(otherCells(hit.cell), { color: 0xff4d4d, opacity: 0.45, scale: 1.03 });
  } else {
    const style = { color: view.setGhostTint(block), opacity: block.alpha ? 0.4 : 0.55 };
    view.showGhost(hit.prev, style);
    if (tool !== 'box' && hit.prev) view.showMirrorGhosts(otherCells(hit.prev), style);
  }
  if (tool === 'box' && boxA) {
    const target = erasing ? hit.cell : hit.prev;
    view.showRegion(boxA, target || boxA);
  }
}

let movingPerson = null; // id of a person waiting to be moved to the next clicked spot

function startLooking(id) {
  const person = world.getPerson(id);
  if (view.animating) return toast('Stop the animation first.');
  if (!person || !view.enterPerson(person)) return;
  $('#lookBar').hidden = false;
}

function toggleFly() {
  if (view.flying) {
    view.exitFly();
    $('#flyBar').hidden = true;
    $('#flyBtn').classList.remove('active');
  } else if (view.animating) {
    toast('Stop the animation first.');
  } else if (view.enterFly()) {
    $('#flyBar').hidden = false;
    $('#flyBtn').classList.add('active');
  } else toast('Finish looking through the person first.');
  refreshHover();
}

// ---------- animation: people walk, doors swing, then play it back ----------
let animMode = null; // null, or what the next click does: 'walkPerson' (pick who), 'walkDest' (pick where), 'turnPerson', 'turnDest', 'door'
let animPerson = null; // the person waiting for a destination
const animOpen = () => !$('#animBar').hidden;

function personLabel(id) {
  const p = world.getPerson(id);
  return p ? p.name || `Person ${id}` : 'someone who is gone';
}

function stepText(s) {
  if (s.type === 'walk') return `${personLabel(s.person)} walks to ${s.x}, ${s.z}`;
  if (s.type === 'turn') return `${personLabel(s.person)} turns to face ${s.x}, ${s.z}`;
  if (s.type === 'door') {
    const d = world.getDoor(s.door);
    return d ? `Door at ${d.x}, ${d.z} ${s.open ? 'opens' : 'closes'}` : 'A door that is gone';
  }
  return `Wait ${s.seconds} second${s.seconds === 1 ? '' : 's'}`;
}

function renderAnimSteps() {
  const list = $('#animSteps');
  if (!list || !world) return;
  list.replaceChildren(
    ...world.animation.map((s, i) => {
      const li = document.createElement('li');
      if (s.together) li.className = 'together';
      const text = document.createElement('span');
      text.textContent = stepText(s);
      const del = document.createElement('button');
      del.type = 'button';
      del.textContent = '×';
      del.title = 'Remove this step';
      del.setAttribute('aria-label', 'Remove this step');
      del.onclick = () => {
        if (!view.animating) world.setAnimation(world.animation.filter((_, k) => k !== i));
      };
      li.append(text, del);
      return li;
    }),
  );
}

function setAnimMode(mode, hint = '') {
  animMode = mode;
  $('#animHint').textContent = hint;
}

function toggleAnimBar(show = !animOpen()) {
  if (!show) {
    view.stopAnimation(false);
    setAnimMode(null);
  }
  $('#animBar').hidden = !show;
  $('#animBtn').classList.toggle('active', show);
  if (show) {
    if (!view.looking) setTool('build');
    renderAnimSteps();
    setAnimMode(null, 'Start as a person to see it through their eyes, or pick Walk, Turn or Door and click what should move. Steps play one after another.');
  }
  refreshHover();
}

function addAnimStep(step) {
  const steps = world.animation.slice();
  if (steps.length >= MAX_ANIMATION_STEPS) return toast(`That is the most steps (${MAX_ANIMATION_STEPS}). Remove some first.`);
  if ($('#animTogether').checked && steps.length) step.together = true;
  steps.push(step);
  world.setAnimation(steps);
  if (step.type !== 'wait') playAnimation(steps.length - 1, true); // show the new step right away, in real time
}

// Is the door open once every step so far has played? (so a new Door step flips it to the other state)
function doorOpenAfterSteps(id) {
  let open = world.getDoor(id)?.open === true;
  for (const s of world.animation) if (s.type === 'door' && s.door === id) open = s.open;
  return open;
}

function animClick(e, button) {
  if (view.animating) return;
  const { ray, hit } = currentHit(e);
  if (button === 2 || e.button === 2) return setAnimMode(null, animMode ? 'Cancelled.' : '');
  if (animMode === 'walkPerson') {
    const id = view.personAt(ray) ?? personAtCells(hit);
    if (id == null) return toast('Click a person.');
    animPerson = id;
    setAnimMode('walkDest', `Click where ${personLabel(id)} should walk to (right-click to cancel).`);
  } else if (animMode === 'walkDest') {
    if (!hit || !hit.prev || !world.getPerson(animPerson)) return;
    addAnimStep({ type: 'walk', person: animPerson, x: hit.prev[0], y: hit.prev[1], z: hit.prev[2] });
    setAnimMode(null, 'Added. It plays once now; press Play to watch it all, or add more steps.');
  } else if (animMode === 'asPerson') {
    const id = view.personAt(ray) ?? personAtCells(hit);
    if (id == null) return toast('Click a person.');
    startLooking(id);
    setAnimMode(null, `You are ${personLabel(id)}. Press Play: you walk and turn with the steps you have, as everyone else does. Without steps, the arrow keys move you (Shift+arrows turn).`);
  } else if (animMode === 'turnPerson') {
    const id = view.personAt(ray) ?? personAtCells(hit);
    if (id == null) return toast('Click a person.');
    animPerson = id;
    setAnimMode('turnDest', `Click the spot ${personLabel(id)} should turn to face (right-click to cancel).`);
  } else if (animMode === 'turnDest') {
    if (!hit || !hit.prev || !world.getPerson(animPerson)) return;
    addAnimStep({ type: 'turn', person: animPerson, x: hit.prev[0], z: hit.prev[2] });
    setAnimMode(null, 'Added. It plays once now; press Play to watch it all, or add more steps.');
  } else if (animMode === 'door') {
    const id = view.doorAt(ray);
    if (id == null) return toast('Click a door.');
    addAnimStep({ type: 'door', door: id, open: !doorOpenAfterSteps(id) });
    setAnimMode(null, 'Added. It plays once now; press Play to watch it all, or add more steps.');
  }
}

// from: index of the step to start at (a just-added step plays by itself, from where the steps before it end)
// onDone: called when it ends or is stopped. Returns whether it started.
function playAnimation(from = 0, quiet = false, onDone = null, hint = 'Playing…') {
  if (!world.animation.length) return toast('Add some steps first: Walk, Turn or Door.'), false;
  const lookText = $('#lookHelp').textContent; // the person bar's usual key help, put back when the animation ends
  const started = view.playAnimation(
    world.animation,
    () => {
      $('#lookHelp').textContent = lookText;
      $('#animPlay').hidden = false;
      $('#animRecord').hidden = false;
      $('#animStop').hidden = true;
      setAnimMode(null, '');
      onDone?.();
    },
    from,
  );
  if (!started) return quiet || toast('Nothing to play: the people or doors in the steps are gone.'), false;
  setAnimMode(null, hint);
  if (view.following()) $('#lookHelp').textContent = 'The animation is walking you around. Drag to look around. Stop to take over with the arrow keys.';
  $('#animPlay').hidden = true;
  $('#animRecord').hidden = true;
  $('#animStop').hidden = false;
  return true;
}

// Play the whole animation from the start while recording the 3D view to a video file (saved when it ends or is stopped).
function recordAnimation() {
  if (view.animating) return;
  if (typeof MediaRecorder === 'undefined' || !view.canvas.captureStream) return toast('This browser cannot record video. Try Chrome, Edge or Firefox.');
  if (!world.animation.length) return toast('Add some steps first: Walk, Turn or Door.');
  const type = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm', 'video/mp4'].find((t) => MediaRecorder.isTypeSupported(t));
  const chunks = [];
  const rec = new MediaRecorder(view.canvas.captureStream(30), { ...(type ? { mimeType: type } : {}), videoBitsPerSecond: 8_000_000 });
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  rec.onstop = () => {
    if (!chunks.length) return;
    const mime = rec.mimeType || type || 'video/webm';
    download(new Blob(chunks, { type: mime }), `${slug(world.meta.title)}.${mime.includes('mp4') ? 'mp4' : 'webm'}`);
    toast('Video saved to your Downloads folder.');
  };
  rec.start(250);
  const started = playAnimation(0, false, () => rec.state !== 'inactive' && rec.stop(), 'Recording… (Stop ends the video early)');
  if (!started) {
    rec.onstop = null;
    rec.stop();
  }
}

function stopLooking() {
  const r = view.exitPerson();
  $('#lookBar').hidden = true;
  if (!r) return;
  const person = world.getPerson(r.id);
  const { id, ...next } = r;
  if (person && Object.keys(next).some((k) => person[k] !== next[k])) {
    const before = { ...person };
    world.updatePerson(r.id, next);
    world.recordPersonEdit(r.id, before);
  }
  refreshHover();
}

function personAtCells(hit) {
  if (!hit) return null;
  for (const c of [hit.cell, hit.prev]) {
    if (!c) continue;
    const p = world.people.find((q) => q.x === c[0] && q.z === c[2] && (q.y === c[1] || q.y + 1 === c[1]));
    if (p) return p.id;
  }
  return null;
}

async function actAt(e, button) {
  if (isViewOnly() || view.looking) return;
  if (animOpen()) return animClick(e, button); // while the Animate bar is open, clicks choose animation steps, not blocks
  const { ray, hit } = currentHit(e);
  if (movingPerson != null) {
    const id = movingPerson;
    const person = world.getPerson(id);
    if (e.button === 2 || !person) movingPerson = null;
    else if (hit && hit.prev) {
      movingPerson = null;
      const before = { ...person };
      world.updatePerson(id, { x: hit.prev[0], y: hit.prev[1], z: hit.prev[2] });
      world.recordPersonEdit(id, before);
      toast('Moved.');
    }
    return;
  }
  const erasing = tool === 'erase' || button === 2 || e.shiftKey;
  // doors: click one with any tool (except the area tools) to open / close it; with the Door tool and a different
  // planks colour selected it is repainted instead; Erase removes it
  if (!AREA_TOOLS.includes(tool)) {
    const doorId = view.doorAt(ray);
    if (doorId != null) {
      const door = world.getDoor(doorId);
      if (erasing) world.removeDoor(doorId);
      else if (tool === 'door' && DOOR_WOODS.includes(selected) && selected !== door.wood) world.changeDoor(doorId, { wood: selected });
      else world.changeDoor(doorId, { open: !door.open });
      return;
    }
  }
  // a person is edited when you click them, or the cell their feet or head are in (even if that is a block's face)
  const personId = view.personAt(ray) ?? (erasing ? null : personAtCells(hit));
  if (personId != null && !AREA_TOOLS.includes(tool)) {
    if (erasing) world.removePerson(personId);
    else openPersonDialog(personId);
    return;
  }
  if (erasing && !AREA_TOOLS.includes(tool)) {
    const labelId = view.labelAt(ray);
    if (labelId != null) {
      world.removeLabel(labelId);
      return;
    }
  }
  if (!hit) return;
  if (tool === 'door') {
    if (!hit.prev) return;
    const [x, y, z] = hit.prev;
    if (!world.canPlaceDoor(x, y, z)) {
      toast('A door needs two free cells, one above the other.');
      return;
    }
    world.addDoor({ x, y, z, rot: view.facingRot(hit.prev), wood: DOOR_WOODS.includes(selected) ? selected : 12 });
    return;
  }
  if (tool === 'person') {
    if (!hit.prev) return;
    const person = world.addPerson({ x: hit.prev[0], y: hit.prev[1], z: hit.prev[2], ...randomOutfit(), rot: view.facingRot(hit.prev) });
    if (person) openPersonDialog(person.id);
    return;
  }
  if (tool === 'select') {
    const corner = hit.cell || hit.prev;
    if (!corner) return;
    if (!selA) {
      selA = corner;
      selection = null;
      view.showSelection(null);
    } else {
      selection = { a: selA, b: corner };
      selA = null;
      view.showRegion(null, null);
      view.showSelection(selection.a, selection.b);
      const w = Math.abs(selection.a[0] - selection.b[0]) + 1;
      const h = Math.abs(selection.a[1] - selection.b[1]) + 1;
      const d = Math.abs(selection.a[2] - selection.b[2]) + 1;
      copySelection(`Selected ${w}×${h}×${d}`); // selecting copies automatically
    }
    updateStatus();
    return;
  }
  if (tool === 'mirror') {
    const corner = hit.cell || hit.prev;
    if (!corner) return;
    if (!mirrorSel) {
      if (!selA) {
        selA = corner;
      } else {
        const { min } = normalizeBox(selA, corner);
        mirrorSel = { a: selA, b: corner, clip: extract(world, selA, corner), origin: min };
        selA = null;
        view.showRegion(null, null);
        view.showSelection(mirrorSel.a, mirrorSel.b);
      }
      updateStatus();
      refreshHover();
      return;
    }
    const line = mirrorLineFor(mirrorSel.a, mirrorSel.b, corner);
    const p = mirrorPlacement(world, mirrorSel.clip, mirrorSel.origin, line);
    if (!p.cells.length && !p.labels.length) {
      toast(p.dropped ? 'That copy would fall outside the diorama — choose a line closer to the area.' : 'There is nothing in that area to mirror.');
      return;
    }
    world.setManyWithLabels(p.cells, p.labels);
    toast(`Mirrored ${p.cells.length} blocks${p.dropped ? ` (${p.dropped} fell outside the diorama)` : ''}. Choose another area, or press Esc.`);
    setTool('mirror'); // back to choosing an area
    return;
  }
  if (tool === 'paste') {
    if (!clip) {
      toast('Nothing to paste yet — use Select on an area first.');
      return;
    }
    if (!hit.prev) return;
    const origin = originFor(clip, hit.prev);
    const key = origin.join(',');
    if (e.pointerType === 'touch' && lastTapKey !== key) {
      lastTapKey = key; // first tap just shows where it would go
      toast('Tap the same spot again to place it, or tap elsewhere to move it.');
      return;
    }
    lastTapKey = null;
    const p = placement(world, clip, origin);
    if (!p.fits) {
      toast("That doesn't fit inside the diorama — move the footprint or Rotate it.");
      return;
    }
    world.setManyWithLabels(p.cells, p.labels);
    toast(`Pasted ${p.cells.length} blocks. Click again to paste another, or press Done.`);
    return;
  }
  if (tool === 'pick') {
    if (hit.cell) {
      selectBlock(world.get(...hit.cell));
      setTool('build');
    }
    return;
  }
  if (tool === 'label') {
    if (!hit.prev) return;
    const text = await askLabel();
    if (text) world.addLabel(hit.prev[0], hit.prev[1], hit.prev[2], text);
    return;
  }
  if (tool === 'box') {
    const target = erasing ? hit.cell : hit.prev;
    if (!target) return;
    if (!boxA) {
      boxA = target;
      updateStatus();
      return;
    }
    const cells = withSymmetry(world.boxCells(boxA, target));
    world.setMany(cells.map(([x, y, z]) => [x, y, z, erasing ? 0 : selected]));
    boxA = null;
    view.showRegion(null, null);
    updateStatus();
    return;
  }
  if (erasing) {
    if (hit.cell) world.setMany(withSymmetry([hit.cell]).map(([x, y, z]) => [x, y, z, 0]));
  } else if (hit.prev) {
    world.setMany(withSymmetry([hit.prev]).map(([x, y, z]) => [x, y, z, selected]));
  }
}

// P: place the selected block where the pointer is, without clicking (or place the paste, when pasting).
function placeAtPointer(e) {
  if (e.repeat) return; // holding the key must not stack blocks
  if (!hoverInfo) {
    toast('Move the pointer over the diorama, then press P.');
    return;
  }
  e.preventDefault();
  if (tool === 'paste') {
    actAt(hoverInfo, 0).finally(() => refreshHover());
    return;
  }
  const { hit } = currentHit(hoverInfo);
  if (hit && hit.prev) world.setMany(withSymmetry([hit.prev]).map(([x, y, z]) => [x, y, z, selected]));
  refreshHover();
}

// R: turn the door under the pointer a quarter turn; Shift+R: flip it to the opposite edge of its block.
function turnDoorAtPointer(quarters = 1) {
  if (!hoverInfo || isViewOnly() || view.looking || AREA_TOOLS.includes(tool)) return;
  const id = view.doorAt(currentHit(hoverInfo).ray);
  if (id != null) world.changeDoor(id, { rot: world.getDoor(id).rot + quarters });
}

function copySelection(prefix = '') {
  if (!selection) {
    toast('Select an area first: Select, then click one corner and the opposite corner.');
    setTool('select');
    return;
  }
  const copied = extract(world, selection.a, selection.b);
  if (!copied.cells.length) {
    clip = null;
    toast(`${prefix ? prefix + ' — but' : ''} that area is empty, so there is nothing to paste.`.trim());
    return;
  }
  clip = copied;
  toast(`${prefix ? prefix + ' and copied' : 'Copied'} ${clip.cells.length} blocks. Press Paste to place them.`);
  updateStatus();
}

// Remove every block and sign. One undo step brings everything back.
function clearAll() {
  // What was there when you started or opened the diorama (the grass, a starter tree, loaded parts) stays;
  // use Select + Delete if you really want to remove those too.
  const keep = (x, y, z, id) => (y === 0 && id === 1) || world.isStartCell(x, y, z, id);
  const keepLabel = (l) => world.isStartLabel(l);
  const keepPerson = (p) => world.isStartPerson(p);
  const keepDoor = (d) => world.isStartDoor(d);
  let anything = world.labels.some((l) => !keepLabel(l)) || world.people.some((p) => !keepPerson(p)) || world.doors.some((d) => !keepDoor(d));
  for (let i = 0; i < world.cells.length && !anything; i++) {
    const id = world.cells[i];
    if (id) {
      const [x, y, z] = world.coords(i);
      if (!keep(x, y, z, id)) anything = true;
    }
  }
  if (!anything) {
    toast('Nothing to clear — only what you add can be cleared. The starting scene stays.');
    return;
  }
  if (!confirm('Clear everything you added? What was there when you started or opened this diorama (like the grass and a tree) stays. You can undo this with Cmd/Ctrl+Z.')) return;
  const r = world.clearRegion([0, 0, 0], [world.sx - 1, world.height - 1, world.sz - 1], { keep, keepLabel, keepPerson, keepDoor });
  selection = null;
  view.showSelection(null);
  const extra = [r.labels ? `${r.labels} sign${r.labels > 1 ? 's' : ''}` : '', r.people ? `${r.people} ${r.people > 1 ? 'people' : 'person'}` : '', r.doors ? `${r.doors} door${r.doors > 1 ? 's' : ''}` : ''].filter(Boolean).join(' and ');
  toast(`Cleared ${r.blocks} blocks${extra ? ' and ' + extra : ''}. The starting scene stays. Cmd/Ctrl+Z brings it all back.`);
  updateStatus();
}

function deleteSelection() {
  if (!selection) return false;
  const r = world.clearRegion(selection.a, selection.b);
  if (!r.blocks && !r.labels && !r.doors) {
    toast('Nothing to delete in that area.');
    return true;
  }
  selection = null;
  view.showSelection(null);
  toast(`Deleted ${r.blocks} blocks${r.labels ? ` and ${r.labels} sign${r.labels > 1 ? 's' : ''}` : ''}. Cmd/Ctrl+Z brings them back.`);
  updateStatus();
  return true;
}

function mirrorClip() {
  if (!clip) {
    toast('Nothing to mirror yet — use Select on an area first.');
    return;
  }
  clip = mirrorX(clip);
  if (tool !== 'paste') setTool('paste'); // show the footprint so the flip is visible
  updateStatus();
  refreshHover();
}

function rotateClip() {
  if (!clip) return;
  clip = rotate90(clip);
  updateStatus();
  refreshHover();
}

function wirePointer(canvas) {
  let down = null;
  const pointers = new Set();
  canvas.addEventListener('pointerdown', (e) => {
    pointers.add(e.pointerId);
    if (pointers.size > 1) {
      down = null; // a second finger means pinch/pan, not a tap
      return;
    }
    down = { x: e.clientX, y: e.clientY, t: performance.now(), button: e.button };
  });
  const finish = (e) => {
    pointers.delete(e.pointerId);
    const d = down;
    down = null;
    if (!d || e.type === 'pointercancel') return;
    const moved = Math.hypot(e.clientX - d.x, e.clientY - d.y);
    if (moved < 6 && performance.now() - d.t < 700 && (d.button === 0 || d.button === 2)) {
      hoverInfo = e;
      actAt(e, d.button).finally(() => refreshHover(e));
    }
  };
  canvas.addEventListener('pointerup', finish);
  canvas.addEventListener('pointercancel', finish);
  canvas.addEventListener('pointermove', (e) => {
    if (e.buttons === 0 && e.pointerType === 'mouse') refreshHover(e);
  });
  canvas.addEventListener('pointerleave', () => {
    hoverInfo = null;
    view.showGhost(null);
  });
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
}

// ---------- dialogs ----------
function askLabel() {
  const dlg = $('#labelDialog');
  const input = $('#labelText');
  input.value = '';
  return new Promise((resolve) => {
    dlg.addEventListener(
      'close',
      () => resolve(dlg.returnValue === 'ok' ? input.value.trim().slice(0, 60) : ''),
      { once: true },
    );
    dlg.showModal();
    input.focus();
  });
}

function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

const slug = (s) => (s || 'diorama').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'diorama';

function composePicture({ preview = false } = {}) {
  let [w, h] = $('#picSize').value.split('x').map(Number);
  if (preview) {
    h = Math.round((h * 640) / w);
    w = 640;
  }
  const canvas = view.snapshot(w, h);
  const title = $('#picTitle').value.trim();
  const sub = $('#picSub').value.trim();
  if ($('#picBar').checked && (title || sub)) {
    const ctx = canvas.getContext('2d');
    const barH = Math.round(h * (sub ? 0.17 : 0.12));
    const g = ctx.createLinearGradient(0, h - barH * 1.4, 0, h);
    g.addColorStop(0, 'rgba(10,12,24,0)');
    g.addColorStop(0.35, 'rgba(10,12,24,0.78)');
    g.addColorStop(1, 'rgba(10,12,24,0.9)');
    ctx.fillStyle = g;
    ctx.fillRect(0, h - barH * 1.4, w, barH * 1.4);
    const pad = Math.round(w * 0.035);
    const fit = (text, weight, size) => {
      let s = size;
      do {
        ctx.font = `${weight} ${s}px system-ui, -apple-system, "Segoe UI", sans-serif`;
        s -= 2;
      } while (ctx.measureText(text).width > w - pad * 2 && s > 10);
    };
    ctx.fillStyle = '#fff';
    ctx.textBaseline = 'alphabetic';
    let y = h - pad * 0.7;
    if (sub) {
      fit(sub, 400, Math.round(h * 0.036));
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      ctx.fillText(sub, pad, y);
      y -= Math.round(h * 0.055);
    }
    if (title) {
      fit(title, 700, Math.round(h * 0.062));
      ctx.fillStyle = '#fff';
      ctx.fillText(title, pad, y);
    }
  }
  return canvas;
}

let previewTimer;
function updatePreview() {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(() => {
    world.meta.title = $('#picTitle').value;
    world.meta.subtitle = $('#picSub').value;
    const c = composePicture({ preview: true });
    $('#picPreview').src = c.toDataURL('image/jpeg', 0.8);
    scheduleSave();
  }, 120);
}

// ---------- toolbar ----------
function wireUI() {
  // Cancel/Close must not be the form's default button, or pressing Enter would cancel the dialog
  $$('dialog button[value=cancel]').forEach((b) => {
    b.type = 'button';
    b.addEventListener('click', () => b.closest('dialog').close('cancel'));
  });
  $$('[data-tool]').forEach((b) =>
    b.addEventListener('click', () => {
      if (b.dataset.tool === 'paste' && !clip) {
        toast('Nothing to paste yet — use Select on an area first.');
        return;
      }
      setTool(b.dataset.tool);
    }),
  );
  $('#copyBtn').addEventListener('click', copySelection);
  $('#rotateBtn').addEventListener('click', rotateClip);
  $('#symBtn').addEventListener('click', cycleSymmetry);
  $('#mirrorBtn2').addEventListener('click', mirrorClip);
  $('#cancelPasteBtn').addEventListener('click', () => setTool('build'));
  $$('[data-sky]').forEach((b) =>
    b.addEventListener('click', () => {
      view.setSky(b.dataset.sky);
      $$('[data-sky]').forEach((x) => x.classList.toggle('active', x === b));
      scheduleSave();
    }),
  );
  $('#clearBtn').addEventListener('click', clearAll);
  $('#undo').addEventListener('click', () => world.undo());
  $('#redo').addEventListener('click', () => world.redo());

  // ----- starting scenes: picture cards -----
  const TEMPLATES = [
    ['grass', 'A grass field'],
    ['grassTree', 'A grass field with a tree'],
    ['forest', 'A forest'],
    ['island', 'A small island'],
    ['empty', 'An empty stand'],
  ];
  const cardsEl = $('#newCards');
  const chooseTemplate = (kind) => {
    $('#newKind').value = kind;
    cardsEl.querySelectorAll('.card').forEach((c) => c.setAttribute('aria-checked', String(c.dataset.kind === kind)));
  };
  let cardsBuilt = false;
  // first = the start screen for someone with nothing yet (nothing to replace, so Cancel says Skip)
  const openNewDialog = (first = false) => {
    if (!cardsBuilt) {
      cardsBuilt = true;
      for (const [kind, label] of TEMPLATES) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'card';
        b.dataset.kind = kind;
        b.setAttribute('role', 'radio');
        const img = document.createElement('img');
        img.src = `img/template-${kind}.jpg`; // a real top-down rendering of the scene
        img.alt = '';
        img.width = img.height = 128;
        b.append(img, document.createTextNode(label));
        b.addEventListener('click', () => chooseTemplate(kind));
        cardsEl.append(b);
      }
    }
    chooseTemplate($('#newKind').value);
    $('#newTitle').textContent = first ? 'Start a diorama' : 'New diorama';
    $('#newHint').hidden = first;
    $('#newCancel').textContent = first ? 'Skip' : 'Cancel';
    $('#newDialog').showModal();
  };
  const syncCustom = () => {
    const custom = $('#newSize').value === 'custom';
    $('#newCustom').hidden = !custom;
    $('#newDLabel').hidden = $('#newSquare').checked;
    $('#newW').previousSibling.textContent = $('#newSquare').checked ? 'Width and depth (blocks)' : 'Width (blocks)';
  };
  $('#newSize').addEventListener('change', syncCustom);
  $('#newSquare').addEventListener('change', syncCustom);
  openStartPicker = () => openNewDialog(true);
  $('#newBtn').addEventListener('click', () => openNewDialog(false));
  $('#newDialog').addEventListener('close', async () => {
    const dlg = $('#newDialog');
    if (dlg.returnValue !== 'ok') return;
    sharedMode = false;
    cloud = null;
    cloudState = '';
    rememberCloud();
    updateBanner(false);
    history.replaceState(null, '', location.pathname + location.search);
    const preset = $('#newSize').value;
    const clamp = (v) => Math.max(NEW_MIN, Math.min(NEW_MAX, Math.round(Number(v)) || 32));
    const nx = preset === 'custom' ? clamp($('#newW').value) : Number(preset);
    const nz = preset === 'custom' && !$('#newSquare').checked ? clamp($('#newD').value) : nx;
    const w = makeScene(nx, $('#newKind').value, nz);
    await rememberStart(w);
    attachWorld(w);
    view.setWorld(w);
    scheduleSave();
  });

  const saveFile = async () => {
    const text = await encodeWorld(world);
    download(new Blob([text], { type: 'text/plain' }), `${slug(world.meta.title)}.blockscape`);
    toast('Downloaded a file.');
  };
  // With accounts, Save goes to your account; without a server it downloads a file as before.
  $('#saveBtn').addEventListener('click', () => (accountApi ? accountApi.save() : saveFile()));


  $('#picBtn').addEventListener('click', () => {
    $('#picTitle').value = world.meta.title || '';
    $('#picSub').value = world.meta.subtitle || '';
    $('#picDialog').showModal();
    updatePreview();
  });
  ['picTitle', 'picSub', 'picSize', 'picBar'].forEach((id) => $('#' + id).addEventListener('input', updatePreview));
  $('#picDownload').addEventListener('click', (e) => {
    e.preventDefault();
    composePicture().toBlob((blob) => {
      download(blob, `${slug($('#picTitle').value)}.png`);
      toast('Picture saved to your Downloads folder.');
    }, 'image/png');
  });

  $('#helpBtn').addEventListener('click', () => $('#helpDialog').showModal());
  $('#reportBtn').addEventListener('click', () => cloud && accountApi && accountApi.report(cloud.id, cloud.title));
  $('#ownBtn').addEventListener('click', async () => {
    history.replaceState(null, '', location.pathname + location.search);
    await loadStart(false);
  });

  $('#lookDone').onclick = stopLooking;
  $('#animBtn').onclick = () => toggleAnimBar();
  $('#animDone').onclick = () => toggleAnimBar(false);
  $('#animAs').onclick = () => {
    if (view.looking) return toast('You are already looking through a person. Press Done in the person bar to stop.');
    if (!view.animating) setAnimMode('asPerson', 'Click the person you want to be.');
  };
  $('#animWalk').onclick = () => {
    if (view.looking) return toast('Finish looking through the person to add a Walk step. Play and Wait still work.');
    if (!view.animating) setAnimMode('walkPerson', 'Click the person who should walk.');
  };
  $('#animTurn').onclick = () => {
    if (view.looking) return toast('Finish looking through the person to add a Turn step. Play and Wait still work.');
    if (!view.animating) setAnimMode('turnPerson', 'Click the person who should turn.');
  };
  $('#animDoor').onclick = () => {
    if (view.looking) return toast('Finish looking through the person to add a Door step. Play and Wait still work.');
    if (!view.animating) setAnimMode('door', 'Click the door to open or close.');
  };
  $('#animWait').onclick = () => !view.animating && addAnimStep({ type: 'wait', seconds: 1 });
  $('#animPlay').onclick = () => playAnimation();
  $('#animRecord').onclick = recordAnimation;
  $('#animStop').onclick = () => view.stopAnimation(false);
  $('#animClear').onclick = () => {
    if (view.animating || !world.animation.length) return;
    if (confirm('Remove every animation step?')) world.setAnimation([]);
  };
  $('#flyBtn').onclick = toggleFly;
  $('#flyDone').onclick = toggleFly;
  view.onFlyMove = () => refreshHover();
  $('#lookMatch').onclick = () => view.matchHeadToBody();
  window.addEventListener('keydown', (e) => {
    if (view.looking) {
      if (e.key === 'Escape' || e.key === 'Enter') stopLooking();
      else if (e.key.toLowerCase() === 'a' && !e.metaKey && !e.ctrlKey && !e.altKey) toggleAnimBar();
      return;
    }
    if (e.target.closest?.('input, textarea, select') || document.querySelector('dialog[open]')) return;
    if (view.flying && e.key === 'Escape') return toggleFly();
    if (animOpen() && e.key === 'Escape') return animMode ? setAnimMode(null, 'Cancelled.') : toggleAnimBar(false);
    if (e.key.toLowerCase() === 'a' && !e.metaKey && !e.ctrlKey && !e.altKey && !isViewOnly()) return toggleAnimBar();
    if (e.key.toLowerCase() === 'f' && !e.metaKey && !e.ctrlKey && !e.altKey) return toggleFly();
    if (isViewOnly()) return;
    const mod = e.metaKey || e.ctrlKey;
    const key = e.key.toLowerCase();
    if (mod && key === 'z') {
      e.preventDefault();
      e.shiftKey ? world.redo() : world.undo();
    } else if (mod && key === 'y') {
      e.preventDefault();
      world.redo();
    } else if (mod && key === 'c') {
      if (selection) {
        e.preventDefault();
        copySelection();
      }
    } else if (mod && key === 'v') {
      if (clip) {
        e.preventDefault();
        setTool('paste');
      }
    } else if (mod) {
      return;
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && selection) {
      e.preventDefault();
      deleteSelection();
    } else if (/^[1-9]$/.test(e.key)) {
      selectBlock(Number(e.key));
    } else if (key === 'b') setTool('build');
    else if (key === 'e') setTool('erase');
    else if (key === 'x') setTool('box');
    else if (key === 's') setTool('select');
    else if (key === 'c') copySelection();
    else if (key === 'p') placeAtPointer(e);
    else if (key === 'v') clip ? setTool('paste') : toast('Nothing to paste yet — use Select on an area first.');
    else if (key === 'h') setTool('person');
    else if (key === 'd') setTool('door');
    else if (key === 'r') turnDoorAtPointer(e.shiftKey ? 2 : 1);
    else if (key === 'q') rotateClip();
    else if (key === 'm') setTool('mirror');
    else if (key === 'y') cycleSymmetry();
    else if (key === 'i') setTool('pick');
    else if (key === 't') setTool('label');
    else if (e.key === 'Escape') {
      boxA = null;
      selA = null;
      selection = null;
      view.showRegion(null, null);
      view.showSelection(null);
      if (tool === 'paste' || tool === 'select' || tool === 'mirror') setTool('build');
      updateStatus();
    }
  });
  window.addEventListener('keyup', () => refreshHover());
  window.addEventListener('hashchange', () => {
    if (location.hash.startsWith('#s=') || location.hash.startsWith('#d=')) loadStart(true);
  });
}

// ---------- start ----------
async function loadStart(allowHash = true) {
  // #d=12 is a link to a saved diorama: anyone can open it, signed in or not
  const linkMatch = allowHash && /^#d=(\d+)$/.exec(location.hash);
  if (linkMatch) {
    try {
      const d = await api('GET', `/api/dioramas/${linkMatch[1]}/public`);
      await loadFromText(d.data, { shared: !d.mine, cloud: { id: d.id, title: d.title, owner: d.owner, mine: d.mine, visibility: d.visibility } });
      return;
    } catch (err) {
      toast(err.message || "That link didn't work — showing your own diorama instead.", 5000);
    }
  }
  if (allowHash && location.hash.startsWith('#s=')) {
    try {
      await loadFromText(location.hash.slice(3), { shared: true });
      toast('Opened a shared diorama — look around!');
      return;
    } catch {
      toast("That link didn't work — showing your own diorama instead.");
    }
  }
  const saved = store.get('scene');
  if (saved) {
    try {
      await loadFromText(saved, { restore: true });
      return;
    } catch {}
  }
  // ?scene=forest starts from another template (handy for screenshots); normally a plain grass field
  const sceneKind = new URLSearchParams(location.search).get('scene');
  await loadFromText(await encodeWorld(makeScene(32, ['grass', 'grassTree', 'forest', 'island', 'empty'].includes(sceneKind) ? sceneKind : 'grass')));
}

async function main() {
  if (location.search.includes('clean')) document.body.classList.add('clean');
  world = makeScene(32, 'grass');
  attachWorld(world);
  view = new DioramaView(stage, world);
  wirePointer(view.canvas);
  wireUI();
  selectBlock(1);
  setTool('build');
  await loadStart(true);
  accountApi = await initAccount({
    getWorld: () => world,
    loadScene: loadFromText,
    makeThumb: () => view.snapshot(320, 200).toDataURL('image/jpeg', 0.72),
    toast,
    statusChanged: updateStatus,
    onSignedIn: () => {
      // Signing in offers a new diorama (Skip keeps what is on screen). While the page is still starting up,
      // the start sequence below shows it after the help window instead.
      if (!booted) signedInDuringBoot = true;
      else if (!location.hash.startsWith('#d=')) openStartPicker();
    },
    onSignedOut: async () => {
      // Signing out takes your diorama away: forget the browser copy and start from a blank scene.
      clearTimeout(cloudTimer);
      clearTimeout(saveTimer);
      store.set('scene', '');
      store.set('shared', '');
      store.set('cloud', '');
      cloud = null;
      cloudState = '';
      localState = '';
      sharedMode = false;
      selection = null;
      const fresh = makeScene(32, 'grass');
      await rememberStart(fresh);
      attachWorld(fresh);
      view.setWorld(fresh);
      view.showSelection(null);
      setTool(tool);
      updateBanner(false);
    },
    saveNow: doCloudSave,
    getCloud: () => cloud,
    setCloud: (c) => {
      cloud = c;
      cloudState = c && c.mine ? 'Saved' : '';
      rememberCloud();
      updateBanner(sharedMode);
      updateStatus();
      syncLive();
    },
  });
  if (!cloud && !sharedMode && accountApi && accountApi.isSignedIn()) {
    try {
      const saved = JSON.parse(store.get('cloud') || 'null');
      if (saved && saved.id) {
        cloud = { ...saved, mine: true };
        cloudState = 'Autosaving to your account';
        syncLive();
      }
    } catch {}
  }
  // ?cam=x,y,z,tx,ty,tz places the camera (used for test screenshots)
  const camParam = new URLSearchParams(location.search).get('cam');
  if (camParam) {
    const n = camParam.split(',').map(Number);
    if (n.length === 6 && n.every(Number.isFinite)) {
      view.camera.position.set(n[0], n[1], n[2]);
      view.controls.target.set(n[3], n[4], n[5]);
      view.controls.update();
      view.invalidate();
    }
  }
  updateBanner(sharedMode);
  updateStatus();
  // First visit order: sign-in prompt, then the help window, then the starting-scene picker.
  const waitFor = (dialog) => new Promise((resolve) => (dialog.open ? dialog.addEventListener('close', resolve, { once: true }) : resolve()));
  const shouldAskToSignIn = () => accountApi && !location.hash.startsWith('#s=') && !location.hash.startsWith('#d=') && !location.search.includes('nosignin');
  if (shouldAskToSignIn()) {
    accountApi.promptIfSignedOut();
    await waitFor($('#panel'));
  }
  if (!store.get('seen-help') && !location.search.includes('nohelp')) {
    store.set('seen-help', '1');
    $('#helpDialog').showModal();
    await waitFor($('#helpDialog'));
  }
  if (location.search.includes('startpicker')) openStartPicker(); // dev: always show the picker (screenshots)
  else if (signedInDuringBoot) openStartPicker();
  else if (!location.search.includes('nohelp') && !location.hash.startsWith('#s=') && !location.hash.startsWith('#d=')) openStartPicker();
  booted = true;
  window.blockscape = { get world() { return world; }, get view() { return view; }, setTool, selectBlock, loadFromText, composePicture };
}

window.addEventListener('error', (e) => {
  document.title = 'ERROR: ' + e.message;
});
window.addEventListener('unhandledrejection', (e) => {
  document.title = 'ERROR: ' + (e.reason && e.reason.message ? e.reason.message : e.reason);
});

main();
