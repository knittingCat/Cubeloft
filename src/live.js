import { cleanPerson, cleanDoor } from './world.js';

// Live editing in the browser: while a class diorama is open for editing, every change is sent to the server,
// which passes it on to everyone else editing the same diorama, and theirs arrive here.
//   cells: [index, block id] pairs  ·  labels / people: the whole (small) list  ·  state: a whole saved scene
const MAX_LABELS = 500;
const MAX_PEOPLE = 200;
const MAX_DOORS = 500;

export function createLive({ getWorld, encode, onPeers, onState, onLost }) {
  let ws = null;
  let wantId = null; // the diorama we should be connected to
  let myName = '';
  let retry = 0;
  let retryTimer = null;
  let dirty = false; // did this person change anything since connecting? (then a newcomer's copy must not replace it)
  let gotState = false;

  const open = () => ws && ws.readyState === 1;
  const post = (msg) => open() && ws.send(JSON.stringify(msg));

  function applyCells(world, list) {
    if (!Array.isArray(list)) return;
    const changes = [];
    for (const pair of list) {
      if (!Array.isArray(pair)) continue;
      const [i, to] = pair;
      if (!Number.isInteger(i) || i < 0 || i >= world.cells.length || !Number.isInteger(to) || to < 0 || to > 255) continue;
      if (world.cells[i] === to) continue;
      changes.push({ i, from: world.cells[i], to });
      world.cells[i] = to;
    }
    if (changes.length) world.emit({ type: 'cells', changes, remote: true });
  }

  function applyLabels(world, list) {
    if (!Array.isArray(list) || list.length > MAX_LABELS) return;
    const labels = [];
    for (const l of list) {
      if (!l || ![l.id, l.x, l.y, l.z].every(Number.isInteger) || !world.inBounds(l.x, l.y, l.z)) continue;
      labels.push({ id: l.id, x: l.x, y: l.y, z: l.z, text: String(l.text).slice(0, 80) });
    }
    world.labels = labels;
    world.nextLabelId = Math.max(world.nextLabelId, ...labels.map((l) => l.id + 1));
    world.emit({ type: 'labels', remote: true });
  }

  function applyPeople(world, list) {
    if (!Array.isArray(list) || list.length > MAX_PEOPLE) return;
    const people = [];
    for (const raw of list) {
      if (!raw || !Number.isInteger(raw.id) || ![raw.x, raw.y, raw.z].every(Number.isInteger) || !world.inBounds(raw.x, raw.y, raw.z)) continue;
      people.push({ ...cleanPerson(raw), id: raw.id });
    }
    world.people = people;
    world.nextPersonId = Math.max(world.nextPersonId, ...people.map((p) => p.id + 1));
    world.emit({ type: 'people', remote: true });
  }

  function applyDoors(world, list) {
    if (!Array.isArray(list) || list.length > MAX_DOORS) return;
    const doors = [];
    for (const raw of list) {
      if (!raw || !Number.isInteger(raw.id) || ![raw.x, raw.y, raw.z].every(Number.isInteger) || !world.inBounds(raw.x, raw.y, raw.z) || !world.inBounds(raw.x, raw.y + 1, raw.z)) continue;
      doors.push({ ...cleanDoor(raw), id: raw.id });
    }
    world.doors = doors;
    world.nextDoorId = Math.max(world.nextDoorId, ...doors.map((d) => d.id + 1));
    world.emit({ type: 'doors', remote: true });
  }

  async function onMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    const world = getWorld();
    if (!msg || !world) return;
    if (msg.t === 'hello') myName = msg.name || '';
    else if (msg.t === 'peers') onPeers((msg.names || []).filter((n) => n !== myName));
    else if (msg.t === 'want') post({ t: 'state', to: msg.to, data: await encode(world) });
    else if (msg.t === 'state') {
      // only the first copy offered, and only if nothing has been changed here yet
      if (gotState || dirty || typeof msg.data !== 'string') return;
      gotState = true;
      onState(msg.data);
    } else if (msg.t === 'cells') applyCells(world, msg.c);
    else if (msg.t === 'labels') applyLabels(world, msg.labels);
    else if (msg.t === 'people') applyPeople(world, msg.people);
    else if (msg.t === 'doors') applyDoors(world, msg.doors);
  }

  function start() {
    clearTimeout(retryTimer);
    const id = wantId;
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const sock = new WebSocket(`${proto}//${location.host}/ws?d=${id}`);
    ws = sock;
    dirty = false;
    gotState = false;
    sock.onopen = () => (retry = 0);
    sock.onmessage = (e) => onMessage(e.data);
    sock.onclose = (e) => {
      if (ws !== sock) return; // we closed it on purpose
      ws = null;
      onPeers([]);
      if (wantId !== id) return;
      // 4403 = the server says we may no longer edit; a socket that never opens (refused) is not retried forever either
      if (e.code === 4403 || (e.code === 1006 && retry >= 6)) {
        wantId = null;
        return onLost();
      }
      retry++;
      retryTimer = setTimeout(() => wantId === id && start(), Math.min(1000 * 2 ** retry, 20000));
    };
  }

  return {
    connect(id) {
      if (wantId === id && ws) return;
      this.disconnect();
      wantId = id;
      retry = 0;
      start();
    },
    disconnect() {
      wantId = null;
      clearTimeout(retryTimer);
      const sock = ws;
      ws = null;
      if (sock) sock.close();
      onPeers([]);
    },
    // a change made on this computer (events that came from someone else are marked `remote` and never sent back)
    send(event) {
      if (!wantId || !event || event.remote) return;
      const world = getWorld();
      dirty = true;
      if (event.type === 'cells') post({ t: 'cells', c: event.changes.map((c) => [c.i, c.to]) });
      else if (event.type === 'labels') post({ t: 'labels', labels: world.labels });
      else if (event.type === 'people') post({ t: 'people', people: world.people });
      else if (event.type === 'doors') post({ t: 'doors', doors: world.doors });
    },
  };
}
