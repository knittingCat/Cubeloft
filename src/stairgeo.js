// The shape of a stair block: three steps, 1/3, 2/3 and 1 high, climbing toward `rot` (0 north -z, 1 east +x, 2 south +z, 3 west -x).
// The turn is baked into the vertices, so every face keeps a world-axis normal (the per-face light in view.js picks its
// brightness from the normal) and its texture side: material groups follow the box order +x -x +y -y +z -z.
import * as THREE from 'three';

const cache = new Map();

export function stairGeometry(rot) {
  const r = ((rot % 4) + 4) % 4;
  if (cache.has(r)) return cache.get(r);
  // the faces of the stair climbing north: the axis of the normal, its sign, the plane position and the range on each of the two other axes
  const faces = [];
  const rect = (axis, sign, at, lo, hi) => faces.push({ axis, sign, at, lo, hi });
  for (let k = 0; k < 3; k++) {
    const h = (k + 1) / 3;
    const zLo = 1 - (k + 1) / 3;
    const zHi = 1 - k / 3;
    rect(1, 1, h, [0, zLo], [1, zHi]); // top (ranges are x, z)
    rect(1, -1, 0, [0, zLo], [1, zHi]); // bottom
    rect(0, 1, 1, [0, zLo], [h, zHi]); // east side (ranges are y, z)
    rect(0, -1, 0, [0, zLo], [h, zHi]); // west side
    rect(2, 1, zHi, [0, k === 0 ? 0 : k / 3], [1, h]); // south face: all of the first step, then just each riser (ranges are x, y)
  }
  rect(2, -1, 0, [0, 0], [1, 1]); // the tall back wall
  const byMat = [[], [], [], [], [], []];
  const turn = (x, z) => {
    let dx = x - 0.5;
    let dz = z - 0.5;
    for (let i = 0; i < r; i++) [dx, dz] = [-dz, dx]; // a quarter turn clockwise seen from above: north becomes east
    return [dx + 0.5, dz + 0.5];
  };
  for (const f of faces) {
    const others = [0, 1, 2].filter((a) => a !== f.axis);
    const corner = (i, j) => {
      const p = [0, 0, 0];
      p[f.axis] = f.at;
      p[others[0]] = i ? f.hi[0] : f.lo[0];
      p[others[1]] = j ? f.hi[1] : f.lo[1];
      return p;
    };
    let pts = [corner(0, 0), corner(1, 0), corner(1, 1), corner(0, 1)];
    const n = [0, 0, 0];
    n[f.axis] = f.sign;
    const a = pts[1].map((v, i) => v - pts[0][i]);
    const b = pts[2].map((v, i) => v - pts[0][i]);
    const cross = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    if (cross[0] * n[0] + cross[1] * n[1] + cross[2] * n[2] < 0) pts = pts.reverse(); // wind it counter-clockwise seen from outside
    const [nx, nz] = turn(n[0] + 0.5, n[2] + 0.5).map((v) => v - 0.5);
    const wn = [Math.round(nx), n[1], Math.round(nz)];
    const mat = wn[0] > 0 ? 0 : wn[0] < 0 ? 1 : wn[1] > 0 ? 2 : wn[1] < 0 ? 3 : wn[2] > 0 ? 4 : 5;
    const out = pts.map((p) => {
      const [x, z] = turn(p[0], p[2]);
      return [x, p[1], z];
    });
    // texture coordinates follow the cube's, so a step shows the part of the block's texture that its place in the cell would
    const uvOf = ([x, y, z]) => [[1 - z, y], [z, y], [x, 1 - z], [x, z], [x, y], [1 - x, y]][mat];
    byMat[mat].push({ out, wn, uv: out.map(uvOf) });
  }
  const pos = [];
  const nor = [];
  const uv = [];
  const geo = new THREE.BufferGeometry();
  let vertex = 0;
  for (let mat = 0; mat < 6; mat++) {
    const start = vertex;
    for (const q of byMat[mat]) {
      for (const i of [0, 1, 2, 0, 2, 3]) {
        pos.push(q.out[i][0] - 0.5, q.out[i][1] - 0.5, q.out[i][2] - 0.5); // around the cell centre, like the cube
        nor.push(...q.wn);
        uv.push(...q.uv[i]);
        vertex++;
      }
    }
    if (vertex > start) geo.addGroup(start, vertex - start, mat);
  }
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  cache.set(r, geo);
  return geo;
}
