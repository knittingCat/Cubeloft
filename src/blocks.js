// Block catalogue. ids are stored in saved scenes, so never renumber or reuse them.
// tex: one texture name for all faces, or { top, side, bottom }.
export const BLOCKS = [
  { id: 1, name: 'Grass', tex: { top: 'grassTop', side: 'grassSide', bottom: 'dirt' } },
  { id: 2, name: 'Dirt', tex: 'dirt' },
  { id: 3, name: 'Stone', tex: 'stone' },
  { id: 4, name: 'Cobblestone', tex: 'cobble' },
  { id: 5, name: 'Sand', tex: 'sand' },
  { id: 6, name: 'Sandstone', tex: 'sandstone' },
  { id: 7, name: 'Snow', tex: 'snow' },
  { id: 8, name: 'Ice', tex: 'ice', alpha: 0.75 },
  { id: 9, name: 'Water', tex: 'water', alpha: 0.65 },
  { id: 10, name: 'Lava', tex: 'lava', glow: 0.9 },
  { id: 11, name: 'Log', tex: { top: 'logTop', side: 'logSide', bottom: 'logTop' } },
  { id: 12, name: 'Planks', tex: 'planks' },
  { id: 13, name: 'Leaves', tex: 'leaves' },
  { id: 14, name: 'Bricks', tex: 'brick' },
  { id: 15, name: 'Glass', tex: 'glass', alpha: 0.4 },
  { id: 16, name: 'Glowstone', tex: 'glowstone', glow: 0.8 },
  { id: 17, name: 'Gold', tex: 'gold' },
  { id: 18, name: 'Obsidian', tex: 'obsidian' },
  { id: 19, name: 'White wool', tex: 'wool:236,236,236' },
  { id: 20, name: 'Red wool', tex: 'wool:176,46,38' },
  { id: 21, name: 'Orange wool', tex: 'wool:240,118,19' },
  { id: 22, name: 'Yellow wool', tex: 'wool:249,198,40' },
  { id: 23, name: 'Green wool', tex: 'wool:94,124,22' },
  { id: 24, name: 'Blue wool', tex: 'wool:60,68,170' },
  { id: 25, name: 'Purple wool', tex: 'wool:137,50,184' },
  { id: 26, name: 'Pink wool', tex: 'wool:237,141,172' },
  { id: 27, name: 'Brown wool', tex: 'wool:114,71,40' },
  { id: 28, name: 'Black wool', tex: 'wool:29,29,33' },
  { id: 29, name: 'Red planks', tex: 'planks:178,52,48' },
  { id: 30, name: 'Orange planks', tex: 'planks:214,112,40' },
  { id: 31, name: 'Yellow planks', tex: 'planks:226,190,60' },
  { id: 32, name: 'Green planks', tex: 'planks:80,150,60' },
  { id: 33, name: 'Blue planks', tex: 'planks:58,100,190' },
  { id: 34, name: 'Indigo planks', tex: 'planks:68,60,150' },
  { id: 35, name: 'Violet planks', tex: 'planks:140,70,170' },
];

// ---- stairs: a block variant with three steps (heights 1/3, 2/3, 1). A stair is stored in the grid as its own id, one per
// block it can be made of and per direction, so saving, undo, copying and live sync need nothing extra.
// rot = the way you climb: 0 north (-z), 1 east (+x), 2 south (+z), 3 west (-x); the tall end is that side.
export const STAIR_BASE = 36;
export const STAIR_SOURCES = BLOCKS.filter((b) => b.id !== 9 && b.id !== 10).map((b) => b.id); // anything but flowing water and lava
export const stairId = (base, rot) => {
  const i = STAIR_SOURCES.indexOf(base);
  return i < 0 ? 0 : STAIR_BASE + i * 4 + (((rot % 4) + 4) % 4);
};
export const STAIR_BLOCKS = STAIR_SOURCES.flatMap((base, i) => {
  const b = BLOCKS.find((x) => x.id === base);
  return [0, 1, 2, 3].map((rot) => ({ ...b, id: STAIR_BASE + i * 4 + rot, name: `${b.name} stairs`, stair: { base, rot } }));
});
export const ALL_BLOCKS = [...BLOCKS, ...STAIR_BLOCKS];
export const BLOCK_BY_ID = new Map(ALL_BLOCKS.map((b) => [b.id, b]));
export const isStair = (id) => id >= STAIR_BASE && BLOCK_BY_ID.get(id)?.stair != null;
// The same stair turned by `quarters` quarter turns clockwise seen from above (other ids come back unchanged).
export const turnStair = (id, quarters) => {
  const s = BLOCK_BY_ID.get(id)?.stair;
  return s ? stairId(s.base, s.rot + quarters) : id;
};
// The same stair seen in a mirror: axis 'x' flips left-right (east and west swap), 'z' flips front-back.
export const flipStair = (id, axis) => {
  const s = BLOCK_BY_ID.get(id)?.stair;
  if (!s) return id;
  const flipped = axis === 'x' ? [0, 3, 2, 1][s.rot] : [2, 1, 0, 3][s.rot];
  return stairId(s.base, flipped);
};
