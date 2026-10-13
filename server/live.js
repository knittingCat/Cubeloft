import { WebSocketServer } from 'ws';

// Live editing: people editing the same class diorama are put in a "room" and the server passes their edits
// on to each other. The server never changes or stores the scene here (saving still goes through the normal
// save); it only checks, again and again, that each person is still allowed to edit.
//   authenticate(req) -> user row or null, canEdit(userId, dioramaId) -> bool
const MAX_MESSAGE = 600 * 1024;
const TYPES = new Set(['cells', 'labels', 'people', 'doors', 'state', 'want']);

export function attachLive(server, { authenticate, canEdit }) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE });
  const rooms = new Map(); // dioramaId -> Set of sockets
  let nextId = 1;

  const send = (ws, msg) => ws.readyState === 1 && ws.send(JSON.stringify(msg));
  const names = (room) => [...room].map((s) => s.username);
  const tellPeers = (room) => {
    for (const s of room) send(s, { t: 'peers', names: names(room).filter((n, i, a) => a.indexOf(n) === i) });
  };

  server.on('upgrade', async (req, socket, head) => {
    try {
      const url = new URL(req.url, 'http://x');
      if (url.pathname !== '/ws') return socket.destroy();
      const id = Number(url.searchParams.get('d'));
      const user = Number.isInteger(id) ? await authenticate(req) : null;
      // the page that opens the socket must be this site (browsers send Origin on socket requests)
      const origin = req.headers.origin;
      if (!user || (origin && new URL(origin).host !== req.headers.host) || !(await canEdit(user.id, id))) {
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
        return socket.destroy();
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        ws.dioramaId = id;
        ws.userId = user.id;
        ws.username = user.username;
        ws.peerId = nextId++;
        ws.isAlive = true;
        ws.on('pong', () => (ws.isAlive = true));
        let room = rooms.get(id);
        if (!room) rooms.set(id, (room = new Set()));
        const oldest = [...room][0];
        room.add(ws);
        send(ws, { t: 'hello', you: ws.peerId, name: ws.username });
        tellPeers(room);
        // the newcomer loaded the saved copy, which may be a few seconds behind: ask the longest-present person for theirs
        if (oldest) send(oldest, { t: 'want', to: ws.peerId });
        ws.on('message', (raw) => {
          let msg;
          try {
            msg = JSON.parse(raw);
          } catch {
            return;
          }
          if (!msg || !TYPES.has(msg.t) || msg.t === 'want') return;
          msg.from = ws.peerId;
          const target = Number.isInteger(msg.to) ? msg.to : null;
          for (const s of room) if (s !== ws && (target === null || s.peerId === target)) send(s, msg);
        });
        ws.on('close', () => {
          room.delete(ws);
          if (!room.size) rooms.delete(id);
          else tellPeers(room);
        });
      });
    } catch {
      socket.destroy();
    }
  });

  // Anyone who lost access (editing switched off, diorama moved, left the class) is disconnected; dead sockets are dropped.
  async function recheck(onlyId) {
    for (const [id, room] of [...rooms]) {
      if (onlyId != null && id !== onlyId) continue;
      for (const ws of [...room]) {
        let ok = false;
        try {
          ok = await canEdit(ws.userId, id);
        } catch {
          ok = true; // a database hiccup should not kick people out
        }
        if (!ok) ws.close(4403, 'no longer allowed');
        else if (onlyId == null) {
          if (!ws.isAlive) ws.terminate();
          else {
            ws.isAlive = false;
            ws.ping();
          }
        }
      }
    }
  }
  const timer = setInterval(() => recheck(), 30000);
  timer.unref();
  server.on('close', () => {
    clearInterval(timer);
    for (const ws of wss.clients) ws.terminate();
  });
  return { recheck };
}
