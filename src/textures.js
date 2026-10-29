// 16x16 pixel-art textures drawn with canvas (no image files). Deterministic per texture name.
const N = 16;

function rng(name) {
  let h = 1779033703;
  for (const ch of name) h = Math.imul(h ^ ch.charCodeAt(0), 3432918353);
  let a = (h ^ (h >>> 16)) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const clamp = (v) => Math.max(0, Math.min(255, Math.round(v)));
const css = (c, a = 1) => `rgba(${clamp(c[0])},${clamp(c[1])},${clamp(c[2])},${a})`;
const shade = (c, d) => [c[0] + d, c[1] + d, c[2] + d];

function noise(ctx, rand, base, amp) {
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      ctx.fillStyle = css(shade(base, (rand() - 0.5) * amp));
      ctx.fillRect(x, y, 1, 1);
    }
  }
}
const px = (ctx, x, y, color, a = 1) => {
  ctx.fillStyle = css(color, a);
  ctx.fillRect(x, y, 1, 1);
};
const speckles = (ctx, rand, color, count, a = 1) => {
  for (let i = 0; i < count; i++) px(ctx, Math.floor(rand() * N), Math.floor(rand() * N), color, a);
};

const PAINTERS = {
  grassTop(ctx, r) {
    noise(ctx, r, [92, 150, 52], 34);
    speckles(ctx, r, [60, 120, 40], 14);
  },
  dirt(ctx, r) {
    noise(ctx, r, [121, 85, 58], 28);
    speckles(ctx, r, [90, 62, 42], 16);
    speckles(ctx, r, [150, 112, 80], 8);
  },
  grassSide(ctx, r) {
    PAINTERS.dirt(ctx, r);
    for (let x = 0; x < N; x++) {
      const depth = 3 + Math.floor(r() * 3);
      for (let y = 0; y < depth; y++) px(ctx, x, y, shade([92, 150, 52], (r() - 0.5) * 34));
    }
  },
  stone(ctx, r) {
    noise(ctx, r, [125, 125, 128], 24);
    speckles(ctx, r, [95, 95, 100], 14);
  },
  cobble(ctx, r) {
    // irregular rounded stones separated by dark mortar; each stone has its own shade and a lit top-left edge
    const mortar = [84, 84, 88];
    ctx.fillStyle = css(mortar);
    ctx.fillRect(0, 0, N, N);
    const rows = [
      { y: 0, h: 5, cuts: [0, 7, 11, 16] },
      { y: 5, h: 5, cuts: [0, 4, 11, 16] },
      { y: 10, h: 6, cuts: [0, 3, 9, 16] },
    ];
    for (const row of rows) {
      for (let i = 0; i < row.cuts.length - 1; i++) {
        const x0 = row.cuts[i];
        const x1 = row.cuts[i + 1] - 1; // leave a 1px mortar line on the right
        const y0 = row.y;
        const y1 = row.y + row.h - 1; // and on the bottom
        const base = 116 + r() * 30;
        for (let y = y0; y < y1; y++) {
          for (let x = x0; x < x1; x++) {
            const corner = (x === x0 || x === x1 - 1) && (y === y0 || y === y1 - 1) && x1 - x0 > 4;
            if (corner) continue; // rounded corner: leave mortar showing
            let shadeAmt = (r() - 0.5) * 16;
            if (x === x0 || y === y0) shadeAmt += 9; // lit edge
            if (x === x1 - 1 || y === y1 - 1) shadeAmt -= 8; // shaded edge
            px(ctx, x, y, [base + shadeAmt, base + shadeAmt, base + shadeAmt + 3]);
          }
        }
      }
    }
  },
  sand(ctx, r) {
    noise(ctx, r, [219, 203, 142], 18);
    speckles(ctx, r, [190, 172, 116], 10);
  },
  hayTop(ctx, r) {
    noise(ctx, r, [214, 178, 62], 30);
    // the cut ends of the straw: a darker rim, a paler ring inside it, and short strands
    for (let i = 0; i < N; i++) for (const [x, y] of [[i, 0], [i, N - 1], [0, i], [N - 1, i]]) px(ctx, x, y, [160, 118, 36]);
    for (let i = 3; i < N - 3; i++) for (const [x, y] of [[i, 3], [i, N - 4], [3, i], [N - 4, i]]) px(ctx, x, y, [238, 206, 96]);
    speckles(ctx, r, [176, 132, 40], 20);
  },
  haySide(ctx, r) {
    noise(ctx, r, [214, 178, 62], 24);
    // vertical straw
    for (let x = 0; x < N; x++) {
      if (r() < 0.45) continue;
      const light = r() < 0.5;
      for (let y = 0; y < N; y++) if (r() < 0.8) px(ctx, x, y, light ? [236, 204, 94] : [178, 136, 44]);
    }
    // two bands of twine around the bale
    for (const y of [3, 4, 11, 12]) for (let x = 0; x < N; x++) px(ctx, x, y, y % 8 === 3 ? [124, 84, 40] : [98, 64, 30]);
    px(ctx, 0, 0, [160, 118, 36]);
  },
  sandstone(ctx, r) {
    noise(ctx, r, [218, 202, 146], 12);
    for (const y of [4, 5, 11]) for (let x = 0; x < N; x++) px(ctx, x, y, [190, 172, 118], 0.9);
  },
  snow(ctx, r) {
    noise(ctx, r, [244, 248, 252], 8);
    speckles(ctx, r, [215, 228, 240], 8);
  },
  ice(ctx, r) {
    noise(ctx, r, [150, 200, 235], 16);
    for (let i = 0; i < 6; i++) px(ctx, Math.floor(r() * N), Math.floor(r() * N), [235, 248, 255]);
  },
  water(ctx, r) {
    noise(ctx, r, [40, 100, 200], 14);
    for (let i = 0; i < 12; i++) {
      const x = Math.floor(r() * 13);
      const y = Math.floor(r() * N);
      for (let k = 0; k < 3; k++) px(ctx, x + k, y, [120, 170, 240], 0.7);
    }
  },
  lava(ctx, r) {
    noise(ctx, r, [230, 90, 20], 70);
    speckles(ctx, r, [255, 220, 90], 22);
    speckles(ctx, r, [150, 40, 10], 12);
  },
  logSide(ctx, r) {
    noise(ctx, r, [102, 78, 48], 16);
    for (let x = 0; x < N; x += 3) for (let y = 0; y < N; y++) px(ctx, x + Math.floor(r() * 2), y, [70, 52, 32], 0.7);
  },
  logTop(ctx, r) {
    noise(ctx, r, [176, 140, 84], 14);
    const rings = [[0, [102, 78, 48]], [3, [196, 160, 100]], [5, [150, 112, 66]]];
    for (const [i, c] of rings) {
      ctx.strokeStyle = css(c);
      ctx.strokeRect(i + 0.5, i + 0.5, N - 1 - 2 * i, N - 1 - 2 * i);
    }
  },
  planks(ctx, r) {
    noise(ctx, r, [176, 140, 84], 16);
    for (const y of [3, 7, 11, 15]) for (let x = 0; x < N; x++) px(ctx, x, y, [120, 90, 52]);
    speckles(ctx, r, [150, 116, 66], 12);
  },
  leaves(ctx, r) {
    noise(ctx, r, [52, 120, 40], 56);
    speckles(ctx, r, [28, 82, 26], 22);
  },
  brick(ctx, r) {
    ctx.fillStyle = css([190, 185, 175]);
    ctx.fillRect(0, 0, N, N);
    for (let row = 0; row < 4; row++) {
      const off = row % 2 ? 4 : 0;
      for (let col = -1; col < 3; col++) {
        const x = col * 8 + off;
        ctx.fillStyle = css(shade([160, 70, 55], (r() - 0.5) * 30));
        ctx.fillRect(x + 1, row * 4 + 1, 7, 3);
      }
    }
  },
  glass(ctx, r) {
    ctx.clearRect(0, 0, N, N);
    ctx.fillStyle = css([200, 235, 245], 0.35);
    ctx.fillRect(0, 0, N, N);
    ctx.strokeStyle = css([235, 250, 255], 0.95);
    ctx.strokeRect(0.5, 0.5, N - 1, N - 1);
    for (let i = 0; i < 4; i++) px(ctx, 3 + i, 3 + i, [255, 255, 255], 0.9);
  },
  glowstone(ctx, r) {
    noise(ctx, r, [250, 210, 110], 56);
    speckles(ctx, r, [255, 250, 190], 18);
    speckles(ctx, r, [190, 140, 60], 10);
  },
  gold(ctx, r) {
    noise(ctx, r, [250, 220, 70], 26);
    for (let i = 0; i < 6; i++) px(ctx, 2 + i, 2 + i, [255, 250, 190], 0.9);
    speckles(ctx, r, [200, 160, 30], 10);
  },
  obsidian(ctx, r) {
    noise(ctx, r, [28, 20, 44], 14);
    speckles(ctx, r, [70, 40, 110], 14);
  },
};

function paintPlanks(ctx, r, rgb) {
  noise(ctx, r, rgb, 16);
  const dark = rgb.map((v) => Math.round(v * 0.68));
  const light = rgb.map((v) => Math.min(255, Math.round(v * 0.85 + 20)));
  for (const y of [3, 7, 11, 15]) for (let x = 0; x < N; x++) px(ctx, x, y, dark);
  speckles(ctx, r, light, 12);
}

function paintWool(ctx, r, rgb) {
  noise(ctx, r, rgb, 16);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) if ((x + y) % 4 === 0) px(ctx, x, y, [0, 0, 0], 0.07);
}

const cache = new Map();
// Returns a 16x16 <canvas> for a texture name (e.g. "stone", "wool:236,236,236" or "planks:178,52,48").
export function textureCanvas(name) {
  if (cache.has(name)) return cache.get(name);
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = N;
  const ctx = canvas.getContext('2d');
  const r = rng(name);
  if (name.startsWith('wool:')) paintWool(ctx, r, name.slice(5).split(',').map(Number));
  else if (name.startsWith('planks:')) paintPlanks(ctx, r, name.slice(7).split(',').map(Number));
  else PAINTERS[name](ctx, r);
  cache.set(name, canvas);
  return canvas;
}

// A 16x32 door face in the style of Minecraft's wooden door, tinted by a planks texture name ("planks" or
// "planks:r,g,b"): planks with four see-through window panes in the top half and two raised panels below (no outline).
const doorCache = new Map();
export function doorCanvas(plankName) {
  if (doorCache.has(plankName)) return doorCache.get(plankName);
  const canvas = document.createElement('canvas');
  canvas.width = N;
  canvas.height = N * 2;
  const ctx = canvas.getContext('2d');
  const base = textureCanvas(plankName);
  ctx.drawImage(base, 0, 0);
  ctx.drawImage(base, 0, N);
  const shade = (x, y, w, h, a) => {
    ctx.fillStyle = `rgba(0,0,0,${a})`;
    ctx.fillRect(x, y, w, h);
  };
  const light = (x, y, w, h, a) => {
    ctx.fillStyle = `rgba(255,255,255,${a})`;
    ctx.fillRect(x, y, w, h);
  };
  // top half: four window panes (2 x 2), cut right out of the texture so you can see through them
  for (const y of [3, 9]) {
    for (const x of [3, 9]) {
      ctx.clearRect(x, y, 4, 4);
      light(x, y + 4, 4, 1, 0.16);
      light(x + 4, y, 1, 5, 0.16);
    }
  }
  // bottom half: two raised panels, one above the other
  for (const y of [N + 2, N + 9]) {
    light(3, y, 10, 1, 0.2);
    light(3, y, 1, 5, 0.2);
    shade(3, y + 5, 10, 1, 0.35);
    shade(12, y, 1, 6, 0.35);
    shade(4, y + 1, 8, 4, 0.12);
  }
  doorCache.set(plankName, canvas);
  return canvas;
}

export function topTextureName(block) {
  return typeof block.tex === 'string' ? block.tex : block.tex.top;
}
