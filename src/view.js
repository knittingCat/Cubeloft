import * as THREE from 'three';
import { OrbitControls } from '../vendor/OrbitControls.js';
import { ALL_BLOCKS, BLOCK_BY_ID, isStair } from './blocks.js';
import { stairGeometry } from './stairgeo.js';
import { textureCanvas, doorCanvas } from './textures.js';
import { DOOR_THICKNESS, LIGHT_SIDES, lampLit, bulbCell } from './world.js';
import { computeLight, faceLevels, brightness, glowAmount, NO_EDGE_LIGHT } from './light.js';

// Put a switch's number on the plate so it reads upright: on a wall it sits at the bottom end of the plate with the top of the
// digit pointing up; on a floor or ceiling the top of the digit points north. `rootQ` and `innerEuler` are how the switch is turned
// (see buildLight); the plate is in its own frame with the face on +y and the long edge along z.
export function placeSwitchNumber(T, num, rootQ, innerEuler) {
  const total = rootQ.clone().multiply(new T.Quaternion().setFromEuler(innerEuler));
  const inv = total.clone().invert();
  const up = new T.Vector3(0, 1, 0).applyQuaternion(inv); // world up in the plate's frame
  const flat = Math.abs(up.y) > 0.9; // lying on a floor or ceiling: there is no "up" along the plate, use north instead
  const t = flat ? new T.Vector3(0, 0, -1).applyQuaternion(inv) : up;
  const len = Math.hypot(t.x, t.z) || 1;
  const [tx, tz] = [t.x / len, t.z / len];
  num.position.set(0, -0.437, tz > 0.5 ? -0.175 : 0.175); // the end of the plate the digit's feet point to
  num.rotation.set(-Math.PI / 2, 0, 0);
  num.rotateZ(Math.atan2(-tx, -tz)); // turn the digit about the plate's normal until its top points the right way
}

const DOOR_OPEN_ANGLE = -Math.PI / 2; // hinge turn of a fully open door
const WALK_SPEED = 1.4; // cells per second (about a person's walking pace: the figure is ~1.5 cells tall)
const STRIDE = 1.5; // cells covered by one full leg cycle (two steps)
const TURN_TIME = 0.3; // seconds spent turning on the spot before walking off
const DOOR_TIME = 0.7; // seconds for a door to swing open or shut
const SWITCH_TIME = 0.4; // seconds a switch step takes in the animation
const HANG_REACH = 7; // a lamp hanging from a ceiling lights the floor strongly when it is this many blocks below, or closer
const LAMP_LEVEL = 14; // the light level of the cell a lit lamp hangs in (a glowing block gives its level minus one next to it)
const smooth = (u) => u * u * (3 - 2 * u);
const angleDiff = (a, b) => ((b - a + Math.PI * 3) % (Math.PI * 2)) - Math.PI; // shortest signed turn from a to b

// glow = how much faces next to a lamp or glowing block shine on their own (they matter most when the sky is dark)
const SKIES = {
  day: { top: '#5aa9ee', bottom: '#cfeaff', hemiSky: 0xdbeeff, hemiGround: 0x8a7a62, hemi: 2.6, sun: 0xfff2d6, sunI: 3.4, sunPos: [0.8, 1.2, 0.55], stars: false, glow: 0.3 },
  sunset: { top: '#4a5aa8', bottom: '#ffae72', hemiSky: 0xffcfa6, hemiGround: 0x5b4060, hemi: 2.0, sun: 0xffa760, sunI: 3.0, sunPos: [1.5, 0.5, 0.35], stars: false, glow: 0.6 },
  night: { top: '#050816', bottom: '#1b2a5c', hemiSky: 0x3a4a8c, hemiGround: 0x14142a, hemi: 1.6, sun: 0x9bb4ff, sunI: 0.9, sunPos: [-0.7, 1.2, 0.6], stars: true, glow: 1 },
};

export class DioramaView {
  constructor(container, world) {
    this.container = container;
    this.world = world;
    this.typeMeshes = new Map(); // block id -> { mesh, capacity }
    this.labelSprites = new Map(); // label id -> Sprite
    this.personGroups = new Map(); // person id -> { sig, group }
    this.personMats = new Map(); // colour -> material (shared)
    this.doorGroups = new Map(); // door id -> { sig, group }
    this.lightGroups = new Map(); // lamp / switch id -> { sig, group }
    this.animGroups = null; // while an animation plays: switch number -> on, overriding the real switches
    this.glowScale = { value: 1 }; // shared by every block material: how much lamp-lit faces shine (set from the sky)
    this.textures = new Map();
    this.flowMeshes = new Map();
    this.materials = new Map();
    this.geometry = new THREE.BoxGeometry(1, 1, 1);

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.shadowMap.autoUpdate = false; // the sun is fixed: redraw shadows only when the scene changes, not on every camera move
    container.appendChild(this.renderer.domElement);
    this.canvas = this.renderer.domElement;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(45, 1, 0.1, 600);
    this.controls = new OrbitControls(this.camera, this.canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;
    this.controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
    this.controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };
    // Smooth zoom: wheel events add to a goal distance and the loop eases the camera toward it
    // (OrbitControls applies each wheel event instantly, which feels jumpy).
    this.zoomGoal = null;
    container.addEventListener('wheel', (e) => { // capture phase: runs before OrbitControls' own wheel handler (pinch still uses it)
      if (e.target !== this.canvas || this.looking || this.flying || !this.controls.enabled) return;
      e.preventDefault();
      e.stopPropagation();
      const d = this.camera.position.distanceTo(this.controls.target);
      const dy = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
      const step = Math.max(-120, Math.min(120, dy)); // one notch or one trackpad burst, never a leap
      const base = this.zoomGoal ?? d;
      this.zoomGoal = Math.max(this.controls.minDistance, Math.min(this.controls.maxDistance, base * Math.pow(0.95, -step * 0.01)));
    }, { passive: false, capture: true });
    // A pinch on a touchscreen or precision touchpad arrives as Ctrl + wheel; left alone it zooms the browser page
    // instead of the diorama, so the page itself never zooms (Ctrl +/- on the keyboard still works).
    window.addEventListener('wheel', (e) => { if (e.ctrlKey) e.preventDefault(); }, { passive: false });
    for (const name of ['gesturestart', 'gesturechange']) document.addEventListener(name, (e) => e.preventDefault()); // Safari
    this.controls.addEventListener('start', () => { this.zoomGoal = null; }); // touch/mouse drags and pinches take over from a wheel ease
    this.controls.maxPolarAngle = Math.PI / 2 - 0.03;
    this.controls.autoRotateSpeed = 1.6;

    this.hemi = new THREE.HemisphereLight(0xffffff, 0x888888, 1);
    this.sun = new THREE.DirectionalLight(0xffffff, 1);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.03;
    this.scene.add(this.hemi, this.sun, this.sun.target);

    this.stars = this.makeStars();
    this.scene.add(this.stars);

    this.initGlow();
    this.helpers = new THREE.Group(); // hidden when taking pictures
    this.scene.add(this.helpers);
    this.makeCursor();

    this.buildStage();
    this.setSky(world.meta.sky || 'day');
    this.resetCamera();
    this.rebuildAll();
    this.rebuildLabels();
    this.rebuildPeople();
    this.rebuildDoors();
    this.rebuildLights();

    this.onResize = () => this.resize();
    window.addEventListener('resize', this.onResize);
    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();

    world.onChange((e) => {
      if (e.type === 'cells') {
        this.rebuild(new Set(e.changes.flatMap((c) => [c.from, c.to])));
        if (e.changes.some((c) => isStair(c.from) || isStair(c.to))) this.rebuildPeople(); // people on a stair block stand lower
      }
      else if (e.type === 'labels') this.rebuildLabels();
      else if (e.type === 'people') this.rebuildPeople();
      else if (e.type === 'doors') this.rebuildDoors();
      else if (e.type === 'lights') this.rebuildLights();
    });

    this.loop = this.loop.bind(this);
    requestAnimationFrame(this.loop);
  }

  get offset() {
    return this.world.sx / 2;
  }
  get offsetZ() {
    return this.world.sz / 2;
  }

  // ----- stage: stand, grid, lights sized to the world -----
  buildStage() {
    const sx = this.world.sx;
    const sz = this.world.sz;
    const size = this.world.size;
    if (this.stage) {
      this.scene.remove(this.stage);
      this.helpers.remove(this.grid);
    }
    this.stage = new THREE.Group();
    const dark = this.texture('planks');
    const floor = new THREE.MeshLambertMaterial({ map: this.texture('dirt'), color: 0xbbbbbb });
    const woodSide = new THREE.MeshLambertMaterial({ map: this.texture('logSide'), color: 0xb0a090 });
    const slab = (w, h, d, y, mats) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mats);
      m.position.y = y;
      m.receiveShadow = true;
      m.castShadow = true;
      this.stage.add(m);
    };
    const frame = new THREE.MeshLambertMaterial({ map: dark, color: 0x8d6b45 });
    slab(sx + 1.2, 1.4, sz + 1.2, -0.7, [woodSide, woodSide, floor, frame, woodSide, woodSide]);
    slab(sx + 2.6, 0.6, sz + 2.6, -1.7, [frame, frame, frame, frame, frame, frame]);
    this.scene.add(this.stage);

    const gridPts = [];
    for (let i = 0; i <= sx; i++) gridPts.push(i - sx / 2, 0, -sz / 2, i - sx / 2, 0, sz / 2);
    for (let j = 0; j <= sz; j++) gridPts.push(-sx / 2, 0, j - sz / 2, sx / 2, 0, j - sz / 2);
    const gridGeo = new THREE.BufferGeometry();
    gridGeo.setAttribute('position', new THREE.Float32BufferAttribute(gridPts, 3));
    this.grid = new THREE.LineSegments(gridGeo, new THREE.LineBasicMaterial({ color: 0x000000 }));
    this.grid.material.transparent = true;
    this.grid.material.opacity = 0.18;
    this.grid.position.y = 0.02;
    this.helpers.add(this.grid);

    const s = size * 0.95;
    Object.assign(this.sun.shadow.camera, { left: -s, right: s, top: s, bottom: -s, near: 1, far: size * 6 });
    this.sun.shadow.camera.updateProjectionMatrix();
    this.controls.maxDistance = size * 3.2;
    this.controls.minDistance = 4;
  }

  makeStars() {
    const pts = [];
    let a = 12345;
    const r = () => ((a = (a * 1664525 + 1013904223) >>> 0) / 4294967296);
    for (let i = 0; i < 500; i++) {
      const u = r() * Math.PI * 2;
      const v = Math.acos(r() * 0.9 + 0.08);
      pts.push(Math.sin(v) * Math.cos(u) * 280, Math.cos(v) * 280, Math.sin(v) * Math.sin(u) * 280);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    const stars = new THREE.Points(g, new THREE.PointsMaterial({ color: 0xffffff, size: 1.4, sizeAttenuation: false, fog: false }));
    stars.visible = false;
    return stars;
  }

  makeCursor() {
    this.ghost = new THREE.Mesh(this.geometry, new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.5, depthWrite: false }));
    this.ghost.scale.setScalar(1.002);
    this.ghostEdges = new THREE.LineSegments(new THREE.EdgesGeometry(this.geometry), new THREE.LineBasicMaterial({ color: 0x000000 }));
    this.ghost.add(this.ghostEdges);
    this.ghost.visible = false;
    this.ghost.renderOrder = 5;
    this.helpers.add(this.ghost);

    // selected area (cyan) and paste footprint (green/red plate + outline)
    this.selection = new THREE.Group();
    this.selection.add(
      new THREE.LineSegments(new THREE.EdgesGeometry(this.geometry), new THREE.LineBasicMaterial({ color: 0x4dd0e1 })),
      new THREE.Mesh(this.geometry, new THREE.MeshBasicMaterial({ color: 0x4dd0e1, transparent: true, opacity: 0.14, depthWrite: false })),
    );
    this.selection.visible = false;
    this.footprint = new THREE.Group();
    this.footprintEdges = new THREE.LineSegments(new THREE.EdgesGeometry(this.geometry), new THREE.LineBasicMaterial({ color: 0xffffff }));
    this.footprintBody = new THREE.Mesh(this.geometry, new THREE.MeshBasicMaterial({ color: 0x34d399, transparent: true, opacity: 0.12, depthWrite: false }));
    this.footprintPlate = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ color: 0x34d399, transparent: true, opacity: 0.5, depthWrite: false, side: THREE.DoubleSide }));
    this.footprintPlate.rotation.x = -Math.PI / 2;
    this.footprint.add(this.footprintEdges, this.footprintBody, this.footprintPlate);
    this.footprint.visible = false;
    this.helpers.add(this.selection, this.footprint);

    // extra ghosts for the mirrored copies, and the two symmetry planes
    this.mirrorGhosts = [];
    this.planeX = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ color: 0x7c9cff, transparent: true, opacity: 0.14, depthWrite: false, side: THREE.DoubleSide }));
    this.planeZ = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ color: 0x7c9cff, transparent: true, opacity: 0.14, depthWrite: false, side: THREE.DoubleSide }));
    this.planeX.rotation.y = Math.PI / 2; // the plane x = centre
    this.planeX.visible = this.planeZ.visible = false;
    this.helpers.add(this.planeX, this.planeZ);

    this.region = new THREE.LineSegments(new THREE.EdgesGeometry(this.geometry), new THREE.LineBasicMaterial({ color: 0xffd23f }));
    this.region.visible = false;
    this.helpers.add(this.region);

    // the Measure tool: an outline round each of the two cells, a line between their centres and a label on it
    const outline = () => {
      const o = new THREE.LineSegments(new THREE.EdgesGeometry(this.geometry), new THREE.LineBasicMaterial({ color: 0x4dd0e1, depthTest: false }));
      o.visible = false;
      o.renderOrder = 8;
      this.helpers.add(o);
      return o;
    };
    this.measureA = outline();
    this.measureB = outline();
    this.measureLine = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]), new THREE.LineBasicMaterial({ color: 0x4dd0e1, depthTest: false }));
    this.measureLine.visible = false;
    this.measureLine.renderOrder = 8;
    this.helpers.add(this.measureLine);
    this.measureLabel = null;
  }

  // Show a measurement between cells a and b (b may be null while only the first is chosen; a null hides it all). The numbers
  // are shown in the Measure bar, not in the scene.
  showMeasure(a, b) {
    this.dirty = true;
    this.measureA.visible = !!a;
    this.measureB.visible = !!(a && b);
    this.measureLine.visible = !!(a && b);
    if (!a) return;
    const centre = (c) => new THREE.Vector3(c[0] + 0.5 - this.offset, c[1] + 0.5, c[2] + 0.5 - this.offsetZ);
    this.measureA.position.copy(centre(a));
    this.measureA.scale.setScalar(1.03);
    if (!b) return;
    this.measureB.position.copy(centre(b));
    this.measureB.scale.setScalar(1.03);
    const pa = centre(a);
    const pb = centre(b);
    this.measureLine.geometry.setFromPoints([pa, pb]);
  }

  // ----- sky & lighting -----
  setSky(name) {
    const s = SKIES[name] || SKIES.day;
    this.world.meta.sky = SKIES[name] ? name : 'day';
    const c = document.createElement('canvas');
    c.width = 2;
    c.height = 256;
    const ctx = c.getContext('2d');
    const g = ctx.createLinearGradient(0, 0, 0, 256);
    g.addColorStop(0, s.top);
    g.addColorStop(1, s.bottom);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 2, 256);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    this.scene.background?.dispose?.();
    this.scene.background = tex;
    this.hemi.color.set(s.hemiSky);
    this.hemi.groundColor.set(s.hemiGround);
    this.hemi.intensity = s.hemi;
    this.sun.color.set(s.sun);
    this.sun.intensity = s.sunI;
    const k = this.world.size;
    this.sun.position.set(s.sunPos[0] * k, s.sunPos[1] * k, s.sunPos[2] * k);
    this.stars.visible = s.stars;
    this.glowScale.value = s.glow;
    this.applyGlow();
    // lamps set to a time of day go on or off with the sky
    if (this.typeMeshes.size && this.world.lights.some((l) => l.kind === 'lamp' && l.mode === 'time')) {
      this.updateLighting();
      this.refreshLightLook();
    }
    this.dirty = true;
  }

  // ----- glow: a faint halo around glowstone and lava blocks -----
  initGlow() {
    this.glowKinds = new Map(); // block id -> { material, points }
    // glowstone and lava: wide, faint halos (tinted by each material's colour), so overlapping ones stay soft instead of blowing out
    const soft = document.createElement('canvas');
    soft.width = soft.height = 64;
    const sg = soft.getContext('2d');
    const sgrad = sg.createRadialGradient(32, 32, 0, 32, 32, 32);
    sgrad.addColorStop(0, 'rgba(255,255,255,0.55)');
    sgrad.addColorStop(0.5, 'rgba(255,255,255,0.18)');
    sgrad.addColorStop(1, 'rgba(255,255,255,0)');
    sg.fillStyle = sgrad;
    sg.fillRect(0, 0, 64, 64);
    const softTex = new THREE.CanvasTexture(soft);
    softTex.colorSpace = THREE.SRGBColorSpace;
    for (const [id, color, size, map, day, night] of [[16, 0xffd070, 4.2, softTex, 0.3, 0.55], [10, 0xff7a30, 4.2, softTex, 0.3, 0.55]]) {
      const material = new THREE.PointsMaterial({ map, size, color, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: day });
      material.userData.day = day;
      material.userData.night = night;
      const points = new THREE.Points(new THREE.BufferGeometry(), material);
      points.frustumCulled = false;
      points.visible = false;
      this.scene.add(points);
      this.glowKinds.set(id, { material, points });
    }
    // a fixed number of soft lights (changing the count would make the shaders rebuild); they sit over the biggest
    // groups of glowstone and lava and gently light the blocks around them
    this.glowLights = [];
    for (let i = 0; i < 8; i++) {
      const l = new THREE.PointLight(0xffc766, 0, 9, 1.6);
      l.userData.base = 0;
      this.scene.add(l);
      this.glowLights.push(l);
    }
    // halos for flowing lava (follows the animated flow, see updateFlowReveal)
    this.lavaFlowPoints = new THREE.Points(new THREE.BufferGeometry(), this.glowKinds.get(10).material);
    this.lavaFlowPoints.frustumCulled = false;
    this.lavaFlowPoints.visible = false;
    this.scene.add(this.lavaFlowPoints);
  }

  rebuildGlow() {
    const w = this.world;
    const off = this.offset;
    const offZ = this.offsetZ;
    const ptsById = new Map([...this.glowKinds.keys()].map((id) => [id, []]));
    const buckets = new Map();
    for (let i = 0; i < w.cells.length; i++) {
      const id = w.cells[i];
      const pts = ptsById.get(id);
      if (!pts) continue;
      const [x, y, z] = w.coords(i);
      const p = [x + 0.5 - off, y + 0.5, z + 0.5 - offZ];
      pts.push(...p);
      const k = `${id}:${Math.floor(x / 6)},${Math.floor(y / 6)},${Math.floor(z / 6)}`;
      const b = buckets.get(k) || { id, n: 0, x: 0, y: 0, z: 0 };
      b.n++;
      b.x += p[0];
      b.y += p[1];
      b.z += p[2];
      buckets.set(k, b);
    }
    for (const [id, { points }] of this.glowKinds) {
      const pts = ptsById.get(id);
      points.geometry.dispose();
      points.geometry = new THREE.BufferGeometry();
      points.geometry.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
      points.visible = pts.length > 0;
    }
    const top = [...buckets.values()].sort((a, b) => b.n - a.n).slice(0, this.glowLights.length);
    this.glowLights.forEach((l, i) => {
      const b = top[i];
      if (b) {
        l.position.set(b.x / b.n, b.y / b.n + 0.7, b.z / b.n);
        l.color.setHex(b.id === 10 ? 0xff7a30 : 0xffd070);
        l.userData.base = Math.min(1.1, 0.35 + 0.1 * b.n);
      } else l.userData.base = 0;
    });
    this.applyGlow();
    this.dirty = true;
  }

  applyGlow() {
    const night = this.world.meta.sky === 'night';
    for (const { material } of this.glowKinds.values()) material.opacity = night ? material.userData.night : material.userData.day;
    for (const l of this.glowLights || []) l.intensity = l.userData.base * (night ? 2 : 0.7);
    for (const mats of this.materials.values()) for (const m of mats) if (m.userData.glow) m.emissiveIntensity = m.userData.glow * (night ? 1.4 : 0.8);
  }

  // ----- materials & textures -----
  texture(name) {
    if (!this.textures.has(name)) {
      const t = new THREE.CanvasTexture(textureCanvas(name));
      t.colorSpace = THREE.SRGBColorSpace;
      t.magFilter = THREE.NearestFilter;
      t.minFilter = THREE.NearestMipmapLinearFilter;
      t.anisotropy = 4;
      this.textures.set(name, t);
    }
    return this.textures.get(name);
  }

  blockMaterials(block) {
    if (this.materials.has(block.id)) return this.materials.get(block.id);
    const tex = typeof block.tex === 'string' ? { top: block.tex, side: block.tex, bottom: block.tex } : block.tex;
    const make = (name) => {
      const m = new THREE.MeshLambertMaterial({ map: this.texture(name) });
      // each block face is lit by the cell it looks into (see light.js): two per-instance vec3s hold the six face brightnesses
      m.customProgramCacheKey = () => 'faceLightGlow';
      m.onBeforeCompile = (shader) => {
        shader.vertexShader = shader.vertexShader
          .replace('#include <common>', '#include <common>\nattribute vec3 lightA;\nattribute vec3 lightB;\nattribute vec3 glowA;\nattribute vec3 glowB;\nvarying float vFaceLight;\nvarying float vFaceGlow;')
          .replace(
            '#include <begin_vertex>',
            '#include <begin_vertex>\nvFaceLight = normal.x > 0.5 ? lightA.x : normal.x < -0.5 ? lightA.y : normal.y > 0.5 ? lightA.z : normal.y < -0.5 ? lightB.x : normal.z > 0.5 ? lightB.y : lightB.z;\nvFaceGlow = normal.x > 0.5 ? glowA.x : normal.x < -0.5 ? glowA.y : normal.y > 0.5 ? glowA.z : normal.y < -0.5 ? glowB.x : normal.z > 0.5 ? glowB.y : glowB.z;',
          );
        shader.uniforms.uGlowScale = this.glowScale;
        // a face lit by a lamp or glowing block shines a little on its own, so it is not as dark as the dim sky around it
        shader.fragmentShader = shader.fragmentShader
          .replace('#include <common>', '#include <common>\nvarying float vFaceLight;\nvarying float vFaceGlow;\nuniform float uGlowScale;')
          .replace('#include <map_fragment>', '#include <map_fragment>\ndiffuseColor.rgb *= vFaceLight;')
          .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += diffuseColor.rgb / max(vFaceLight, 0.05) * vFaceGlow * uGlowScale;');
      };
      if (block.alpha) {
        m.transparent = true;
        m.opacity = block.alpha;
        m.depthWrite = false;
      }
      if (block.glow) {
        m.emissive = new THREE.Color(0xffffff);
        m.emissiveMap = this.texture(name);
        m.userData.glow = block.glow;
        m.emissiveIntensity = block.glow * 0.8;
      }
      return m;
    };
    // BoxGeometry face order: +x, -x, +y, -y, +z, -z
    const side = make(tex.side);
    const mats = [side, side, make(tex.top), make(tex.bottom), side, side];
    this.materials.set(block.id, mats);
    return mats;
  }

  // A copy of the cube geometry with the per-instance face light attributes (all full bright until updateLighting fills them in).
  lightGeometry(capacity, block) {
    const geo = (block?.stair ? stairGeometry(block.stair.rot) : this.geometry).clone();
    for (const name of ['lightA', 'lightB']) geo.setAttribute(name, new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3).fill(1), 3));
    for (const name of ['glowA', 'glowB']) geo.setAttribute(name, new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3));
    return geo;
  }

  // Work out the light for the whole world and give every block instance its six face brightnesses.
  updateLighting() {
    const w = this.world;
    const passes = (id) => id === 0 || !!BLOCK_BY_ID.get(id)?.alpha;
    const emit = (id) => Math.round((BLOCK_BY_ID.get(id)?.glow || 0) * 15);
    const lamps = w.lights.filter((l) => this.lampIsLit(l)).map((l) => [...bulbCell(l), LAMP_LEVEL, l.at === 2 ? HANG_REACH : 0]); // a lamp on a string lights from its bulb, and its aura reaches a floor within HANG_REACH blocks
    const levels = computeLight(w, passes, emit, lamps);
    const blockLevels = computeLight(w, passes, emit, lamps, { sky: false }); // lamps and glowing blocks on their own: faces they light shine a little
    for (const { mesh, cellIdx } of this.typeMeshes.values()) {
      if (!cellIdx) continue;
      const a = mesh.geometry.getAttribute('lightA');
      const b = mesh.geometry.getAttribute('lightB');
      const ga = mesh.geometry.getAttribute('glowA');
      const gb = mesh.geometry.getAttribute('glowB');
      for (let k = 0; k < cellIdx.length; k++) {
        const [x, y, z] = w.coords(cellIdx[k]);
        const f = faceLevels(w, levels, passes, x, y, z).map(brightness);
        a.setXYZ(k, f[0], f[1], f[2]);
        b.setXYZ(k, f[3], f[4], f[5]);
        const g = faceLevels(w, blockLevels, passes, x, y, z, NO_EDGE_LIGHT).map(glowAmount);
        ga.setXYZ(k, g[0], g[1], g[2]);
        gb.setXYZ(k, g[3], g[4], g[5]);
      }
      a.needsUpdate = b.needsUpdate = ga.needsUpdate = gb.needsUpdate = true;
    }
    this.dirty = true;
  }

  // ----- voxel meshes -----
  rebuildAll() {
    this.rebuild(new Set(ALL_BLOCKS.map((b) => b.id)));
  }

  rebuild(types) {
    const w = this.world;
    const lists = new Map();
    for (const id of types) if (id) lists.set(id, []);
    const cells = w.cells;
    for (let i = 0; i < cells.length; i++) {
      const id = cells[i];
      if (id && lists.has(id)) lists.get(id).push(i);
    }
    const m = new THREE.Matrix4();
    const off = this.offset;
    const offZ = this.offsetZ;
    for (const [id, idx] of lists) {
      const block = BLOCK_BY_ID.get(id);
      if (!block) continue;
      let entry = this.typeMeshes.get(id);
      if (!entry && !idx.length) continue; // no mesh until the first block of this kind (there are a lot of stair kinds)
      if (!entry || entry.capacity < idx.length) {
        if (entry) {
          this.scene.remove(entry.mesh);
          entry.mesh.geometry.dispose();
          entry.mesh.dispose();
        }
        const capacity = Math.max(256, 2 ** Math.ceil(Math.log2(Math.max(idx.length, 1))));
        const mesh = new THREE.InstancedMesh(this.lightGeometry(capacity, block), this.blockMaterials(block), capacity);
        mesh.frustumCulled = false;
        mesh.castShadow = !block.alpha && !block.glow; // glowing blocks are light sources: no dark shadow under them
        mesh.receiveShadow = true;
        mesh.renderOrder = block.alpha ? 2 : 0;
        mesh.count = 0;
        this.scene.add(mesh);
        entry = { mesh, capacity };
        this.typeMeshes.set(id, entry);
      }
      for (let k = 0; k < idx.length; k++) {
        const [x, y, z] = w.coords(idx[k]);
        m.setPosition(x + 0.5 - off, y + 0.5, z + 0.5 - offZ);
        entry.mesh.setMatrixAt(k, m);
      }
      entry.cellIdx = idx;
      entry.mesh.count = idx.length;
      entry.mesh.instanceMatrix.needsUpdate = true;
    }
    this.updateLighting(); // a new roof or wall changes the light on blocks of every other type too
    if (this.glowKinds && (types.has(16) || types.has(10) || !this.glowBuilt)) {
      this.glowBuilt = true;
      this.rebuildGlow();
    }
    this.applyGlow();
    this.dirty = true;
    this.scheduleFlow();
  }

  // ----- flowing water and lava (worked out from the source blocks; see World.computeFlow) -----
  scheduleFlow() {
    if (this.flowPending) return;
    this.flowPending = true;
    requestAnimationFrame(() => {
      this.flowPending = false;
      this.rebuildFlow();
    });
  }

  rebuildFlow() {
    const fresh = this.world.computeFlow();
    const STEP_TIME = { 9: 0.6, 10: 0.6, 4: 0.8 }; // seconds per step: lava and water spread, drain from the far end
    const key = (c) => `${c.id}:${c.x},${c.y},${c.z}`;
    const elapsed = (performance.now() - (this.flowStart || 0)) / 1000;
    // what is on screen right now (including cells still draining), so interrupted animations carry on smoothly
    const shown = new Map();
    for (const { items } of this.flowMeshes.values()) for (const it of items || []) if (it.t <= elapsed && elapsed < it.until) shown.set(key(it.c), it.c);
    const now = new Map(fresh.map((c) => [key(c), c]));
    const items = [];
    const newOnes = fresh.filter((c) => !shown.has(key(c)));
    const firstStep = newOnes.length ? Math.min(...newOnes.map((c) => c.step)) : 0;
    for (const c of fresh) items.push({ c, t: shown.has(key(c)) ? 0 : (c.step - firstStep + 1) * STEP_TIME[c.id], until: Infinity });
    // cells that lost their source drain away slowly, starting next to where the source was and moving outward
    // and downward (the way liquid runs off), not back up toward it
    const gone = [...shown].filter(([k]) => !now.has(k)).map(([, c]) => c);
    const firstGone = gone.length ? Math.min(...gone.map((c) => c.step)) : 0;
    for (const c of gone) items.push({ c, t: 0, until: (c.step - firstGone + 1) * STEP_TIME[c.id] * 1.2 });
    const byId = new Map();
    for (const it of items) {
      if (!byId.has(it.c.id)) byId.set(it.c.id, []);
      byId.get(it.c.id).push(it);
    }
    const m = new THREE.Matrix4();
    const off = this.offset;
    const offZ = this.offsetZ;
    for (const id of new Set([...this.flowMeshes.keys(), ...byId.keys()])) {
      const list = byId.get(id) || [];
      let entry = this.flowMeshes.get(id);
      if (!entry || entry.capacity < list.length) {
        if (entry) {
          this.scene.remove(entry.mesh);
          entry.mesh.geometry.dispose();
          entry.mesh.dispose();
        }
        const capacity = Math.max(256, 2 ** Math.ceil(Math.log2(Math.max(list.length, 1))));
        const block = BLOCK_BY_ID.get(id);
        const mesh = new THREE.InstancedMesh(this.lightGeometry(capacity), this.blockMaterials(block), capacity); // flowing water and lava stay fully bright
        mesh.frustumCulled = false;
        mesh.castShadow = !block.alpha && !block.glow; // glowing blocks are light sources: no dark shadow under them
        mesh.receiveShadow = true;
        mesh.renderOrder = block.alpha ? 2 : 0;
        mesh.count = 0;
        this.scene.add(mesh);
        entry = { mesh, capacity, id };
        this.flowMeshes.set(id, entry);
      }
      for (const it of list) {
        const c = it.c;
        const R = c.id === 10 ? 3 : 7;
        const h = c.id === 4 || c.fall ? 1 : 0.14 + (0.74 * (c.r + 1)) / (R + 1); // shallower further from the source
        it.mat = new THREE.Matrix4().makeScale(1, h, 1).setPosition(c.x + 0.5 - off, c.y + h / 2, c.z + 0.5 - offZ);
      }
      entry.items = list;
      entry.nextChange = 0;
    }
    this.flowStart = performance.now();
    this.updateFlowReveal();
    this.applyGlow();
  }

  // Show the flow cells whose turn has come and hide the ones that have drained (cells appear and
  // disappear a little at a time, like liquid spreading or running out).
  updateFlowReveal(all = false) {
    const t = (performance.now() - (this.flowStart || 0)) / 1000;
    let waiting = false;
    for (const entry of this.flowMeshes.values()) {
      const { mesh, items } = entry;
      if (!all && t < entry.nextChange) {
        waiting = true;
        continue;
      }
      let k = 0;
      let next = Infinity;
      const halo = [];
      const off = this.offset;
    const offZ = this.offsetZ;
      for (const it of items) {
        if (all ? it.until !== Infinity : false) continue;
        const visible = all || (it.t <= t && t < it.until);
        if (visible) {
          mesh.setMatrixAt(k++, it.mat);
          if (entry.id === 10) halo.push(it.c.x + 0.5 - off, it.c.y + 0.4, it.c.z + 0.5 - offZ);
          if (it.until !== Infinity) next = Math.min(next, it.until);
        } else if (it.t > t) next = Math.min(next, it.t);
      }
      entry.nextChange = next;
      if (entry.id === 10) {
        this.lavaFlowPoints.geometry.dispose();
        this.lavaFlowPoints.geometry = new THREE.BufferGeometry();
        this.lavaFlowPoints.geometry.setAttribute('position', new THREE.Float32BufferAttribute(halo, 3));
        this.lavaFlowPoints.visible = halo.length > 0;
      }
      if (next !== Infinity && !all) waiting = true;
      if (mesh.count !== k || !all) {
        mesh.count = k;
        mesh.instanceMatrix.needsUpdate = true;
        this.dirty = true;
      }
    }
    this.flowWaiting = waiting;
  }

  // Replace the world (new/open): stage and meshes are resized to match.
  setWorld(world) {
    for (const { mesh } of this.typeMeshes.values()) {
      this.scene.remove(mesh);
      mesh.dispose();
    }
    this.typeMeshes.clear();
    for (const { mesh } of this.flowMeshes.values()) {
      this.scene.remove(mesh);
      mesh.dispose();
    }
    this.flowMeshes.clear();
    this.lavaFlowPoints.visible = false;
    for (const s of this.labelSprites.values()) this.scene.remove(s);
    this.labelSprites.clear();
    for (const { group } of this.personGroups.values()) {
      this.scene.remove(group);
      this.disposePerson(group);
    }
    this.personGroups.clear();
    for (const { group } of this.doorGroups.values()) this.scene.remove(group);
    this.doorGroups.clear();
    for (const { group } of this.lightGroups.values()) this.scene.remove(group);
    this.lightGroups.clear();
    this.animGroups = null;
    this.held = null;
    this.world = world;
    this.buildStage();
    this.rebuildAll();
    this.rebuildLabels();
    this.rebuildPeople();
    this.rebuildDoors();
    this.rebuildLights();
    this.setSky(world.meta.sky || 'day');
    this.resetCamera();
    this.showSymmetry(this.symMode || 'off'); // planes follow the new stand size
    world.onChange((e) => {
      if (world !== this.world) return;
      if (e.type === 'cells') {
        this.rebuild(new Set(e.changes.flatMap((c) => [c.from, c.to])));
        if (e.changes.some((c) => isStair(c.from) || isStair(c.to))) this.rebuildPeople(); // people on a stair block stand lower
      }
      else if (e.type === 'labels') this.rebuildLabels();
      else if (e.type === 'people') this.rebuildPeople();
      else if (e.type === 'doors') this.rebuildDoors();
      else if (e.type === 'lights') this.rebuildLights();
    });
  }

  // ----- labels (text signs) -----
  rebuildLabels() {
    this.dirty = true;
    const ids = new Set(this.world.labels.map((l) => l.id));
    for (const [id, sprite] of this.labelSprites) {
      if (!ids.has(id)) {
        this.scene.remove(sprite);
        sprite.material.map.dispose();
        sprite.material.dispose();
        this.labelSprites.delete(id);
      }
    }
    const off = this.offset;
    const offZ = this.offsetZ;
    for (const l of this.world.labels) {
      if (this.labelSprites.has(l.id)) continue;
      const sprite = this.makeLabelSprite(l.text);
      sprite.position.set(l.x + 0.5 - off, l.y + 0.1, l.z + 0.5 - offZ);
      sprite.userData.labelId = l.id;
      this.scene.add(sprite);
      this.labelSprites.set(l.id, sprite);
    }
  }

  makeLabelSprite(text) {
    const font = 'bold 40px system-ui, -apple-system, "Segoe UI", sans-serif';
    const c = document.createElement('canvas');
    const ctx = c.getContext('2d');
    ctx.font = font;
    const tw = Math.ceil(ctx.measureText(text).width);
    const padX = 22;
    const w = tw + padX * 2;
    const h = 84;
    c.width = w;
    c.height = h + 22;
    ctx.font = font;
    ctx.fillStyle = 'rgba(20,20,30,0.88)';
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.roundRect(2, 2, w - 4, h - 4, 16);
    ctx.fill();
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(w / 2 - 14, h - 4);
    ctx.lineTo(w / 2, h + 20);
    ctx.lineTo(w / 2 + 14, h - 4);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';
    ctx.fillText(text, w / 2, h / 2);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
    const unit = 0.022;
    sprite.scale.set(c.width * unit, c.height * unit, 1);
    sprite.center.set(0.5, 0); // the tail tip sits on the anchor point
    sprite.renderOrder = 10;
    return sprite;
  }

  // ----- people -----
  mat(hex) {
    if (!this.personMats.has(hex)) this.personMats.set(hex, new THREE.MeshLambertMaterial({ color: hex }));
    return this.personMats.get(hex);
  }

  faceTexture(skin) {
    // 8x8 pixel face: two eyes and a mouth on the skin colour
    const c = document.createElement('canvas');
    c.width = c.height = 8;
    const ctx = c.getContext('2d');
    ctx.fillStyle = skin;
    ctx.fillRect(0, 0, 8, 8);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(1, 3, 2, 1);
    ctx.fillRect(5, 3, 2, 1);
    ctx.fillStyle = '#2b2118';
    ctx.fillRect(2, 3, 1, 1);
    ctx.fillRect(5, 3, 1, 1);
    ctx.fillStyle = 'rgba(120, 40, 40, 0.85)';
    ctx.fillRect(3, 5, 2, 1);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.magFilter = THREE.NearestFilter;
    t.minFilter = THREE.NearestFilter;
    return t;
  }

  // A blocky figure standing on the floor of its cell. Total height is about 1.7 cells.
  buildPerson(p) {
    const g = new THREE.Group();
    let part = g; // where new pieces go (the head pivot once we reach the head)
    let lower = 0; // height of that pivot
    const add = (w, h, d, x, y, z, hex, face) => {
      const m = new THREE.Mesh(this.geometry, face ? [this.mat(hex), this.mat(hex), this.mat(hex), this.mat(hex), face, this.mat(hex)] : this.mat(hex));
      m.scale.set(w, h, d);
      m.position.set(x, y - lower + h / 2, z);
      m.castShadow = true;
      m.receiveShadow = true;
      part.add(m);
      return m;
    };
    // legs and shoes
    const sitting = p.pose === 'sitting';
    const ledge = p.pose === 'ledge';
    const legs = [];
    const arms = [];
    for (const sx of [-0.13, 0.13]) {
      // each leg hangs from a pivot at the hip, so it can swing (walking) or point forward (sitting)
      const leg = new THREE.Group();
      leg.position.set(sx, 0.7, 0);
      if (sitting) leg.rotation.x = -Math.PI / 2; // the legs stick out along the front of the figure
      g.add(leg);
      legs.push(leg);
      part = leg;
      lower = 0.7;
      const x = 0;
      if (ledge) {
        // sitting on a block: the thigh points forward from the hip, the lower leg hangs straight down from the knee
        leg.rotation.x = -Math.PI / 2;
        add(0.24, 0.4, 0.28, x, 0.3, 0, p.bottoms === 'skirt' ? p.skin : p.pants);
        const shin = new THREE.Group();
        shin.position.set(0, -0.4, 0); // the knee: the thigh's far end, in the leg's own frame
        shin.rotation.x = Math.PI / 2; // cancels the thigh's turn, so it hangs down
        leg.add(shin);
        part = shin;
        lower = 0.3;
        add(0.24, 0.4, 0.28, x, -0.1, 0, p.bottoms === 'pants' ? p.pants : p.skin);
        add(0.26, 0.1, 0.36, x, -0.1, 0.04, p.shoes);
        part = g;
        lower = 0;
        continue;
      }
      if (p.bottoms === 'pants') add(0.24, 0.7, 0.28, x, 0, 0, p.pants);
      else if (p.bottoms === 'shorts') {
        add(0.24, 0.36, 0.28, x, 0.34, 0, p.pants);
        add(0.24, 0.34, 0.28, x, 0, 0, p.skin);
      } else add(0.24, 0.7, 0.28, x, 0, 0, p.skin);
      if (sitting) {
        part = g;
        lower = 0;
        add(0.26, 0.28, 0.12, sx, 0.56, 0.7, p.shoes); // the feet at the end of the legs
      } else add(0.26, 0.1, 0.36, 0, 0, 0.04, p.shoes); // the shoe swings with the leg
    }
    part = g;
    lower = 0;
    if (p.bottoms === 'skirt') add(0.62, 0.34, 0.36, 0, 0.5, 0, p.pants);
    // torso and arms
    add(0.52, 0.7, 0.3, 0, 0.7, 0, p.shirt);
    for (const sx of [-0.36, 0.36]) {
      // each arm hangs from a pivot at the shoulder so it can swing when walking
      const arm = new THREE.Group();
      arm.position.set(sx, 1.35, 0);
      g.add(arm);
      arms.push(arm);
      part = arm;
      lower = 1.35;
      if (p.sleeves === 'long') add(0.2, 0.7, 0.26, 0, 0.7, 0, p.shirt);
      else if (p.sleeves === 'short') {
        add(0.2, 0.3, 0.26, 0, 1.1, 0, p.shirt);
        add(0.2, 0.4, 0.26, 0, 0.7, 0, p.skin);
      } else add(0.2, 0.7, 0.26, 0, 0.7, 0, p.skin);
    }
    part = g;
    lower = 0;
    g.userData.limbs = { legs, arms }; // swung by the walking animation
    // everything from here up turns and tilts together, around the neck
    const head = new THREE.Group();
    head.position.set(0, 1.4, 0);
    head.rotation.order = 'YXZ';
    head.rotation.y = (p.headTurn * Math.PI) / 6;
    head.rotation.x = -p.headTilt * 0.35;
    g.add(head);
    part = head;
    lower = 1.4;
    // head with a face on the front
    const face = new THREE.MeshLambertMaterial({ map: this.faceTexture(p.skin) });
    face.userData.own = true; // not shared, so it can be freed with the figure
    add(0.5, 0.5, 0.5, 0, 1.4, 0, p.skin, face);
    // hair
    if (p.hairStyle !== 'none') {
      add(0.54, 0.12, 0.54, 0, 1.84, 0, p.hair);
      add(0.54, p.hairStyle === 'long' ? 0.7 : 0.3, 0.08, 0, p.hairStyle === 'long' ? 1.2 : 1.6, -0.23, p.hair);
      if (p.hairStyle === 'long') for (const sx of [-0.26, 0.26]) add(0.06, 0.55, 0.3, sx, 1.35, -0.08, p.hair);
      else for (const sx of [-0.26, 0.26]) add(0.06, 0.22, 0.4, sx, 1.62, -0.03, p.hair);
    }
    // hats
    if (p.hat === 'cap') {
      add(0.58, 0.16, 0.58, 0, 1.86, 0, p.hatColor);
      add(0.5, 0.04, 0.26, 0, 1.86, 0.36, p.hatColor);
    } else if (p.hat === 'beanie') {
      add(0.58, 0.26, 0.58, 0, 1.86, 0, p.hatColor);
      add(0.14, 0.14, 0.14, 0, 2.12, 0, p.hatColor);
    } else if (p.hat === 'tophat') {
      add(0.84, 0.04, 0.84, 0, 1.88, 0, p.hatColor);
      add(0.46, 0.42, 0.46, 0, 1.92, 0, p.hatColor);
      add(0.48, 0.07, 0.48, 0, 1.97, 0, '#e5e7eb');
    } else if (p.hat === 'crown') {
      add(0.56, 0.14, 0.56, 0, 1.88, 0, p.hatColor);
      for (const [sx, sz] of [[-0.2, -0.2], [0.2, -0.2], [-0.2, 0.2], [0.2, 0.2], [0, 0]]) add(0.1, 0.14, 0.1, sx, 2.02, sz, p.hatColor);
    }
    g.scale.setScalar(0.9);
    g.rotation.order = 'YXZ'; // lie down first, then turn around the vertical
    g.rotation.y = ((p.rot * 3 + p.twist) * Math.PI) / 6; // rot is quarter turns, twist is 30 degree steps
    const lying = p.pose === 'lying' || p.pose === 'lyingFront';
    if (sitting || ledge) g.position.y = -0.5; // the seat of the figure rests on the floor
    if (ledge) {
      // sit near the front edge of the block so the knees are past it and the lower legs hang free
      const a = g.rotation.y;
      g.position.x = Math.sin(a) * 0.2;
      g.position.z = Math.cos(a) * 0.2;
    }
    if (lying) {
      // on their back (face up) or on their front (face down); head toward the back of the cell
      g.rotation.x = p.pose === 'lyingFront' ? Math.PI / 2 : -Math.PI / 2;
      g.position.y = 0.25; // raise so they rest on the floor
      if (p.pose === 'lyingFront') g.rotation.y += Math.PI; // keep the head at the same end
    }
    const holder = new THREE.Group();
    holder.add(g);
    if (p.name) {
      const tag = this.makeLabelSprite(p.name);
      tag.scale.multiplyScalar(0.7);
      if (lying) {
        const a = ((p.rot * 3 + p.twist) * Math.PI) / 6; // head is at -z of the figure, turned by rot
        tag.position.set(-1.3 * Math.sin(a), 0.9, -1.3 * Math.cos(a));
      } else tag.position.set(0, sitting || ledge ? 1.75 : 2.25, 0);
      holder.add(tag);
    }
    return holder;
  }

  // Free the textures a figure owns (shared colour materials are kept).
  disposePerson(group) {
    group.traverse((o) => {
      if (o.isSprite) {
        o.material.map?.dispose();
        o.material.dispose();
      } else if (o.material) {
        for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
          if (m.userData.own) {
            m.map?.dispose();
            m.dispose();
          }
        }
      }
    });
  }

  rebuildPeople() {
    this.dirty = true;
    const alive = new Set(this.world.people.map((p) => p.id));
    for (const [id, entry] of this.personGroups) {
      if (!alive.has(id)) {
        this.scene.remove(entry.group);
        this.disposePerson(entry.group);
        this.personGroups.delete(id);
      }
    }
    const off = this.offset;
    const offZ = this.offsetZ;
    for (const p of this.world.people) {
      const sig = JSON.stringify({ ...p, x: 0, y: 0, z: 0 });
      let entry = this.personGroups.get(p.id);
      if (!entry || entry.sig !== sig) {
        if (entry) {
          this.scene.remove(entry.group);
          this.disposePerson(entry.group);
        }
        entry = { sig, group: this.buildPerson(p) };
        entry.group.userData.personId = p.id;
        this.scene.add(entry.group);
        this.personGroups.set(p.id, entry);
      }
      entry.group.position.set(p.x + 0.5 - off, p.y + this.world.standOffset(p.x, p.y, p.z), p.z + 0.5 - offZ); // on a stair block: down on its middle step
    }
  }

  // ----- doors -----
  // Two stacked 1 x 1 x 3/16 planks (so the plank texture is not stretched) plus a handle. Built around the
  // lower cell's centre; closed = on the `rot` edge, open = swung back onto the left (hinge) edge.
  // Materials for a door box: plain planks on the thin edges, the Minecraft-style door face on both big sides.
  doorMaterials(wood) {
    this.doorMats ??= new Map();
    if (!this.doorMats.has(wood)) {
      const tex = BLOCK_BY_ID.get(wood)?.tex || 'planks';
      const plank = typeof tex === 'string' ? tex : tex.side;
      const key = `door:${plank}`;
      if (!this.textures.has(key)) {
        const t = new THREE.CanvasTexture(doorCanvas(plank));
        t.colorSpace = THREE.SRGBColorSpace;
        t.magFilter = THREE.NearestFilter;
        t.minFilter = THREE.NearestFilter;
        this.textures.set(key, t);
      }
      const edge = new THREE.MeshLambertMaterial({ map: this.texture(plank) });
      const face = new THREE.MeshLambertMaterial({ map: this.textures.get(key), alphaTest: 0.5 }); // cut-out windows
      this.doorMats.set(wood, [edge, edge, edge, edge, face, face]);
    }
    return this.doorMats.get(wood);
  }

  buildDoor(d) {
    const T = DOOR_THICKNESS;
    const g = new THREE.Group();
    const panel = new THREE.Group();
    const slab = new THREE.Mesh(new THREE.BoxGeometry(1, 2, T), this.doorMaterials(d.wood)); // +x -x +y -y +z -z
    slab.position.y = 1;
    slab.castShadow = slab.receiveShadow = true;
    panel.add(slab);
    // the handle: a short stem through the door with a knob on each face, near the free edge at about hand height
    const handleMat = this.mat('#3a2a18');
    const stem = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.05, T + 0.2), handleMat);
    stem.position.set(0.36, 0.95, 0);
    panel.add(stem);
    for (const side of [1, -1]) {
      const knob = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.12, 0.07), handleMat);
      knob.position.set(0.36, 0.95, side * (T / 2 + 0.1));
      knob.castShadow = true;
      panel.add(knob);
    }
    // two iron hinges on the left edge (the side that sits against the wall): a barrel sticking out of both faces
    // with a leaf plate on each face
    const hingeMat = this.mat('#4b4b50');
    for (const y of [0.4, 1.6]) {
      const barrel = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.22, T + 0.06), hingeMat);
      barrel.position.set(-0.5 + 0.04, y, 0);
      barrel.castShadow = true;
      panel.add(barrel);
      for (const side of [1, -1]) {
        const leaf = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.16, 0.02), hingeMat);
        leaf.position.set(-0.5 + 0.06, y, side * (T / 2 + 0.01));
        leaf.castShadow = true;
        panel.add(leaf);
      }
    }
    // the door swings around a hinge at its left corner; the panel is offset from the hinge so turning the hinge
    // by -90 degrees lays the open door along the hinge edge, inside the cell
    const hinge = new THREE.Group();
    hinge.position.set(-0.5 + T / 2, 0, -0.5 + T / 2);
    panel.position.set(0.5 - T / 2, 0, 0);
    hinge.add(panel);
    hinge.rotation.y = d.open ? DOOR_OPEN_ANGLE : 0;
    g.add(hinge);
    g.userData.hinge = hinge;
    g.rotation.y = -d.rot * (Math.PI / 2);
    return g;
  }

  rebuildDoors() {
    this.dirty = true;
    const alive = new Set(this.world.doors.map((d) => d.id));
    for (const [id, entry] of this.doorGroups) {
      if (!alive.has(id)) {
        this.scene.remove(entry.group);
        this.doorGroups.delete(id);
      }
    }
    const off = this.offset;
    const offZ = this.offsetZ;
    for (const d of this.world.doors) {
      const sig = JSON.stringify({ ...d, x: 0, y: 0, z: 0 });
      let entry = this.doorGroups.get(d.id);
      if (!entry || entry.sig !== sig) {
        if (entry) this.scene.remove(entry.group);
        entry = { sig, group: this.buildDoor(d) };
        entry.group.userData.doorId = d.id;
        this.scene.add(entry.group);
        this.doorGroups.set(d.id, entry);
      }
      entry.group.position.set(d.x + 0.5 - off, d.y, d.z + 0.5 - offZ);
    }
  }

  // id of the door under the pointer, or null
  doorAt(ray) {
    const roots = [...this.doorGroups.values()].map((e) => e.group);
    for (const h of ray.raycaster.intersectObjects(roots, true)) {
      let o = h.object;
      while (o && o.userData.doorId === undefined) o = o.parent;
      if (o) return o.userData.doorId;
    }
    return null;
  }

  // ----- lamps and switches -----
  // Are the switches with this number on? (an animation that is playing overrides the real ones)
  groupIsOn(group) {
    return this.animGroups?.has(group) ? this.animGroups.get(group) : this.world.groupOn(group);
  }
  lampIsLit(l) {
    return lampLit(l, this.world.meta.sky || 'day', (g) => this.groupIsOn(g));
  }

  // A lamp (a bulb on a small base) or a switch (a plate with a rocker), drawn stuck to the side `at` of its cell:
  // built standing on the bottom of the cell, then turned so its base faces the side it is stuck to.
  // A small dark digit on a transparent background, for the plate of a numbered switch.
  numberTexture(n) {
    const key = `switch-number:${n}`;
    if (!this.textures.has(key)) {
      const c = document.createElement('canvas');
      c.width = c.height = 64;
      const g = c.getContext('2d');
      g.fillStyle = '#1f2937';
      g.font = 'bold 56px system-ui, sans-serif';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(String(n), 32, 36);
      const t = new THREE.CanvasTexture(c);
      t.colorSpace = THREE.SRGBColorSpace;
      this.textures.set(key, t);
    }
    return this.textures.get(key);
  }

  buildLight(l) {
    const root = new THREE.Group();
    const inner = new THREE.Group();
    root.add(inner);
    const box = (w, h, d, color, y) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshLambertMaterial({ color }));
      m.position.set(0, y, 0);
      inner.add(m);
      return m;
    };
    if (l.kind === 'lamp' && l.at === 2) {
      // hanging from the ceiling: a small canopy, a cord `string` cells long (plus a little), a shade open to the floor and the bulb under it
      // (here +y points down at the floor)
      const metal = 0x3f3f46;
      const n = l.string || 0;
      box(0.2, 0.05, 0.2, metal, -0.475); // the canopy against the ceiling
      const top = n - 0.3; // where the shade starts
      const cord = box(0.025, top + 0.5, 0.025, 0x1f2937, (top - 0.5) / 2);
      const shade = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.05, 0.2, 16, 1, true), new THREE.MeshLambertMaterial({ color: metal, side: THREE.DoubleSide }));
      shade.position.set(0, top + 0.1, 0); // wide end toward the floor
      inner.add(shade);
      const bulb = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.16, 0.16), new THREE.MeshBasicMaterial({ color: 0xfff1b0 }));
      bulb.position.set(0, top + 0.2, 0);
      inner.add(bulb);
      root.userData.bulb = bulb;
      root.userData.cord = cord;
    } else if (l.kind === 'lamp') {
      box(0.34, 0.06, 0.34, 0x3f3f46, -0.47); // the base against the surface
      box(0.08, 0.14, 0.08, 0x3f3f46, -0.37);
      const bulb = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.3, 0.3), new THREE.MeshBasicMaterial({ color: 0xfff1b0 }));
      bulb.position.set(0, -0.2, 0);
      inner.add(bulb);
      root.userData.bulb = bulb;
    } else {
      box(0.34, 0.06, 0.5, 0xe5e7eb, -0.47);
      root.userData.toggle = box(0.1, 0.12, 0.2, 0x22c55e, -0.4);
      // the switch's number, small on the plate beside the rocker
      const num = new THREE.Mesh(new THREE.PlaneGeometry(0.15, 0.15), new THREE.MeshBasicMaterial({ map: this.numberTexture(l.group), transparent: true, depthWrite: false }));
      num.rotation.x = -Math.PI / 2;
      inner.add(num);
      root.userData.number = num;
    }
    inner.rotation.y = l.at === 0 || l.at === 1 ? Math.PI / 2 : 0; // on a side wall the long edge of a switch stands upright
    root.quaternion.setFromUnitVectors(new THREE.Vector3(0, -1, 0), new THREE.Vector3(...LIGHT_SIDES[l.at]));
    if (root.userData.number) placeSwitchNumber(THREE, root.userData.number, root.quaternion, inner.rotation);
    root.userData.lightId = l.id;
    return root;
  }

  rebuildLights() {
    this.dirty = true;
    const alive = new Set(this.world.lights.map((l) => l.id));
    for (const [id, entry] of this.lightGroups) {
      if (!alive.has(id)) {
        this.scene.remove(entry.group);
        this.lightGroups.delete(id);
      }
    }
    const off = this.offset;
    const offZ = this.offsetZ;
    for (const l of this.world.lights) {
      const sig = `${l.kind}${l.at}${l.kind === 'switch' ? 'n' + l.group : 's' + (l.string || 0)}`; // the look depends on what it is, which side it is on and a switch's number; the rest is shown by refreshLightLook
      let entry = this.lightGroups.get(l.id);
      if (!entry || entry.sig !== sig) {
        if (entry) this.scene.remove(entry.group);
        entry = { sig, group: this.buildLight(l) };
        this.scene.add(entry.group);
        this.lightGroups.set(l.id, entry);
      }
      entry.group.position.set(l.x + 0.5 - off, l.y + 0.5, l.z + 0.5 - offZ);
    }
    if (this.typeMeshes.size) this.updateLighting(); // lit lamps light the blocks around them
    this.refreshLightLook();
  }

  // Lit bulbs glow, unlit ones are dull; a switch's rocker leans one way when on and the other when off.
  refreshLightLook() {
    this.dirty = true;
    for (const l of this.world.lights) {
      const entry = this.lightGroups.get(l.id);
      if (!entry) continue;
      const { bulb, toggle } = entry.group.userData;
      if (bulb) bulb.material.color.set(this.lampIsLit(l) ? 0xfff1b0 : 0x6b6358);
      if (toggle) {
        const on = this.groupIsOn(l.group);
        toggle.rotation.x = on ? -0.55 : 0.55;
        toggle.material.color.set(on ? 0x22c55e : 0xef4444);
      }
    }
  }

  // id of the lamp or switch under the pointer, or null
  lightAt(ray) {
    const roots = [...this.lightGroups.values()].map((e) => e.group);
    for (const h of ray.raycaster.intersectObjects(roots, true)) {
      let o = h.object;
      while (o && o.userData.lightId === undefined) o = o.parent;
      if (o) return o.userData.lightId;
    }
    return null;
  }

  // ----- animation playback -----
  // Turns a list of steps (see cleanAnimation in world.js) into a timeline: for each person a list of walking
  // segments, for each door a list of swings. Steps run one after another; a step marked `together` starts with
  // the one before it. Nothing in the world is changed: playback only moves the drawn figures and doors.
  planAnimation(steps) {
    const world = this.world;
    const people = new Map(); // person id -> { start: {x,y,z,facing}, segs: [], at: current planned state }
    const doors = new Map(); // door id -> { open0, events: [], open: current planned state }
    const lights = new Map(); // switch number -> { on0, events: [{ t, to }] }
    let end = 0;
    let prevStart = 0;
    let total = 0;
    const stepStart = []; // when each step begins, so playback can start part-way through
    for (const [i, s] of steps.entries()) {
      const start = s.together ? prevStart : end;
      stepStart[i] = start;
      let dur = 0;
      if (s.type === 'walk') {
        const p = world.getPerson(s.person);
        if (!p) continue;
        if (!people.has(p.id)) {
          const at = { x: p.x + 0.5, y: p.y + world.standOffset(p.x, p.y, p.z), z: p.z + 0.5, facing: ((p.rot * 3 + p.twist) * Math.PI) / 6 };
          people.set(p.id, { start: { ...at }, segs: [], at });
        }
        const rec = people.get(p.id);
        const to = { x: s.x + 0.5, y: s.y + world.standOffset(s.x, s.y, s.z), z: s.z + 0.5 };
        const L = Math.hypot(to.x - rec.at.x, to.z - rec.at.z);
        if (L < 0.01) continue;
        const heading = Math.atan2(to.x - rec.at.x, to.z - rec.at.z);
        const walkT = L / WALK_SPEED + 0.4; // the ends are eased, so a little longer than L / speed
        dur = TURN_TIME + walkT;
        rec.segs.push({ t0: start, t1: start + dur, walkT, L, from: { x: rec.at.x, y: rec.at.y, z: rec.at.z }, to, heading, faceFrom: rec.at.facing });
        rec.at = { ...to, facing: heading };
      } else if (s.type === 'turn') {
        const p = world.getPerson(s.person);
        if (!p) continue;
        if (!people.has(p.id)) {
          const at = { x: p.x + 0.5, y: p.y + world.standOffset(p.x, p.y, p.z), z: p.z + 0.5, facing: ((p.rot * 3 + p.twist) * Math.PI) / 6 };
          people.set(p.id, { start: { ...at }, segs: [], at });
        }
        const rec = people.get(p.id);
        if (Math.hypot(s.x + 0.5 - rec.at.x, s.z + 0.5 - rec.at.z) < 0.01) continue; // already standing there
        const heading = Math.atan2(s.x + 0.5 - rec.at.x, s.z + 0.5 - rec.at.z);
        dur = TURN_TIME;
        rec.segs.push({ t0: start, t1: start + dur, walkT: 0, L: 0, from: { x: rec.at.x, y: rec.at.y, z: rec.at.z }, to: { x: rec.at.x, y: rec.at.y, z: rec.at.z }, heading, faceFrom: rec.at.facing });
        rec.at = { ...rec.at, facing: heading };
      } else if (s.type === 'door') {
        const d = world.getDoor(s.door);
        if (!d) continue;
        if (!doors.has(d.id)) doors.set(d.id, { open0: d.open, events: [], open: d.open });
        const rec = doors.get(d.id);
        rec.events.push({ t0: start, t1: start + DOOR_TIME, from: rec.open ? 1 : 0, to: s.open ? 1 : 0 });
        rec.open = s.open;
        dur = DOOR_TIME;
      } else if (s.type === 'light') {
        if (!lights.has(s.group)) lights.set(s.group, { on0: world.groupOn(s.group), events: [] });
        lights.get(s.group).events.push({ t: start, to: s.on });
        dur = SWITCH_TIME;
      } else if (s.type === 'wait') dur = s.seconds;
      prevStart = start;
      end = Math.max(end, start + dur);
      total = Math.max(total, start + dur);
    }
    return total > 0 ? { people, doors, lights, total, stepStart } : null;
  }

  // Pose one person at time t: position, facing, and swinging legs and arms.
  poseAnimatedPerson(id, rec, t) {
    const entry = this.personGroups.get(id);
    const p = this.world.getPerson(id);
    if (!entry || !p) return;
    let seg = null;
    for (const s of rec.segs) if (s.t0 <= t) seg = s;
    let pos = rec.start;
    let facing = rec.start.facing;
    let phase = 0;
    let amp = 0;
    if (seg) {
      const tau = t - seg.t0;
      if (t >= seg.t1) {
        pos = seg.to;
        facing = seg.heading;
        phase = seg.L / STRIDE; // stand with the legs where the walk ended: reset below
      } else if (tau < TURN_TIME) {
        pos = seg.from;
        facing = seg.faceFrom + angleDiff(seg.faceFrom, seg.heading) * smooth(tau / TURN_TIME);
      } else {
        const u = Math.min(1, (tau - TURN_TIME) / seg.walkT);
        const s = seg.L * smooth(u);
        const f = s / seg.L;
        pos = { x: seg.from.x + (seg.to.x - seg.from.x) * f, y: seg.from.y + (seg.to.y - seg.from.y) * f, z: seg.from.z + (seg.to.z - seg.from.z) * f };
        facing = seg.heading;
        phase = s / STRIDE;
        const speed = (seg.L * 6 * u * (1 - u)) / seg.walkT; // cells per second right now
        amp = Math.min(1, speed / 1.2);
      }
    }
    const holder = entry.group;
    const g = holder.children[0];
    const standing = p.pose === 'standing';
    holder.position.set(pos.x - this.offset, pos.y + (standing ? Math.abs(Math.sin(phase * Math.PI * 2)) * 0.04 * amp : 0), pos.z - this.offsetZ);
    if (standing) g.rotation.y = facing;
    const limbs = g.userData.limbs;
    if (standing && limbs) {
      const swing = Math.sin(phase * Math.PI * 2) * amp;
      limbs.legs[0].rotation.x = swing * 0.55;
      limbs.legs[1].rotation.x = -swing * 0.55;
      limbs.arms[0].rotation.x = -swing * 0.45; // each arm swings against the leg on its own side
      limbs.arms[1].rotation.x = swing * 0.45;
    }
  }

  poseAnimatedDoor(id, rec, t) {
    const entry = this.doorGroups.get(id);
    if (!entry) return;
    let v = rec.open0 ? 1 : 0;
    for (const ev of rec.events) {
      if (t >= ev.t1) v = ev.to;
      else {
        if (t > ev.t0) v = ev.from + (ev.to - ev.from) * smooth((t - ev.t0) / DOOR_TIME);
        break;
      }
    }
    entry.group.userData.hinge.rotation.y = v * DOOR_OPEN_ANGLE;
  }

  // Switch numbers the steps flip: set each one's state at time t, and when any changed, relight the scene.
  poseAnimatedLights(plan, t) {
    if (!plan.lights.size) return;
    let changed = false;
    this.animGroups ??= new Map();
    for (const [group, rec] of plan.lights) {
      let on = rec.on0;
      for (const ev of rec.events) if (t >= ev.t) on = ev.to;
      if (this.animGroups.get(group) !== on) {
        this.animGroups.set(group, on);
        changed = true;
      }
    }
    if (changed) {
      this.updateLighting();
      this.refreshLightLook();
    }
  }

  get animating() {
    return !!this.anim;
  }

  // Start playing steps; onEnd(finished) is called when it ends or is stopped. Returns false if nothing to play.
  // `from` is the index of the step to start at: everything before it is already done (people and doors stand where they ended).
  // With `hold`, a run that ends by itself leaves everyone and every door in their finished pose (a step you just added
  // stays on screen) until the next play, Stop, or edit of the diorama.
  playAnimation(steps, onEnd, from = 0, hold = false) {
    if (this.anim) this.stopAnimation(false);
    this.clearHold();
    const plan = this.planAnimation(steps);
    if (!plan) return false;
    // Looking through a person: if the steps move them, you ride along (the camera follows their animated walk and turns);
    // if they have no steps, or are lying or sitting, the arrow keys move you as usual.
    if (this.looking && this.looking.pose !== 'standing') plan.people.delete(this.looking.id);
    const skip = plan.stepStart[from] ?? 0;
    if (skip >= plan.total) return false; // the step turned out to do nothing
    this.anim = { plan, t0: performance.now() - skip * 1000, onEnd, hold };
    return true;
  }

  updateAnimation() {
    const { plan, t0 } = this.anim;
    const t = (performance.now() - t0) / 1000;
    for (const [id, rec] of plan.people) this.poseAnimatedPerson(id, rec, t);
    for (const [id, rec] of plan.doors) this.poseAnimatedDoor(id, rec, t);
    this.poseAnimatedLights(plan, t);
    if (this.following()) this.followCamera();
    this.dirty = true;
    if (t <= plan.total + 0.3) return;
    if (this.anim.hold && !this.following()) this.holdAnimation();
    else this.stopAnimation(true);
  }

  // The run is over: stop moving things but leave them in their finished pose (see playAnimation's `hold`).
  holdAnimation() {
    const { plan, onEnd } = this.anim;
    this.anim = null;
    this.held = plan;
    if (onEnd) onEnd(true);
  }

  // Put back whatever a held (finished) run left on screen.
  clearHold() {
    if (!this.held) return;
    const plan = this.held;
    this.held = null;
    this.restoreFigures(plan);
  }

  // Stop and put every figure and door back as the diorama really has them.
  stopAnimation(finished = false) {
    if (!this.anim) return this.clearHold();
    const { plan, onEnd } = this.anim;
    this.anim = null;
    this.restoreFigures(plan);
    if (onEnd) onEnd(finished);
  }

  restoreFigures(plan) {
    for (const id of plan.people.keys()) {
      const entry = this.personGroups.get(id);
      if (entry) {
        this.scene.remove(entry.group);
        this.disposePerson(entry.group);
        this.personGroups.delete(id);
      }
    }
    for (const id of plan.doors.keys()) {
      const entry = this.doorGroups.get(id);
      if (entry) {
        this.scene.remove(entry.group);
        this.doorGroups.delete(id);
      }
    }
    this.rebuildPeople();
    this.rebuildDoors();
    if (this.animGroups) {
      this.animGroups = null; // the real switches rule again
      this.updateLighting();
      this.refreshLightLook();
    }
    if (this.looking) {
      // the figure was rebuilt: keep it hidden from its own eyes, and go back to where the keys left you
      const entry = this.personGroups.get(this.looking.id);
      if (entry) {
        entry.group.visible = false;
        this.looking.group = entry.group;
      }
      this.applyLook();
    }
  }

  // Is the person you are looking through being moved by the animation right now?
  following() {
    return !!(this.looking && this.anim && this.anim.plan.people.has(this.looking.id));
  }

  // Put the camera at the animated person's eyes, facing the way they walk, plus any head turn you dragged.
  followCamera() {
    const L = this.looking;
    const holder = this.personGroups.get(L.id)?.group;
    if (!holder) return;
    this.camera.position.set(holder.position.x, holder.position.y + 1.4, holder.position.z);
    L.headPitch = Math.max(-0.7, Math.min(0.7, L.headPitch));
    this.camera.rotation.set(-L.headPitch, holder.children[0].rotation.y + L.headYaw + Math.PI, 0);
  }

  // Which way (0-3) a figure on this cell should face to look toward the camera.
  facingRot(cell) {
    const off = this.offset;
    const offZ = this.offsetZ;
    const dx = this.camera.position.x - (cell[0] + 0.5 - off);
    const dz = this.camera.position.z - (cell[2] + 0.5 - offZ);
    return (((Math.round(Math.atan2(dx, dz) / (Math.PI / 2))) % 4) + 4) % 4;
  }

  // ----- looking through a person's eyes -----
  // Arrow keys walk, Shift+arrows spin (left/right) and lay down / get up (up/down), dragging turns the head.
  // Nothing is written to the person until exitPerson() hands back the final state.
  enterPerson(p) {
    if (this.looking || this.flying || this.anim) return false;
    this.clearHold();
    const entry = this.personGroups.get(p.id);
    if (!entry) return false;
    this.saved = { pos: this.camera.position.clone(), target: this.controls.target.clone(), fov: this.camera.fov };
    this.looking = {
      id: p.id,
      x: p.x,
      y: p.y,
      z: p.z,
      k: (p.rot * 3 + p.twist) % 12, // body direction in 30 degree steps
      pose: p.pose,
      headYaw: (p.headTurn * Math.PI) / 6,
      headPitch: -p.headTilt * 0.35,
      group: entry.group,
    };
    entry.group.visible = false; // do not look at the inside of their own head
    this.controls.enabled = false;
    this.camera.fov = 70;
    this.camera.updateProjectionMatrix();
    this.camera.rotation.order = 'YXZ';
    const L = this.looking;
    this.applyLook();
    L.down = (e) => {
      L.drag = { x: e.clientX, y: e.clientY };
      this.canvas.setPointerCapture?.(e.pointerId);
    };
    L.move = (e) => {
      if (!L.drag) return;
      L.headYaw += (e.clientX - L.drag.x) * 0.006;
      L.headPitch += (e.clientY - L.drag.y) * 0.006;
      L.drag = { x: e.clientX, y: e.clientY };
      this.applyLook();
    };
    L.up = () => (L.drag = null);
    L.key = (e) => {
      if (!e.key.startsWith('Arrow')) return;
      e.preventDefault();
      if (this.following()) return; // the animation is walking you; the arrows work again when it stops
      if (e.shiftKey) {
        if (e.key === 'ArrowLeft') L.k = (L.k + 1) % 12;
        else if (e.key === 'ArrowRight') L.k = (L.k + 11) % 12;
        else if (e.key === 'ArrowUp') L.pose = L.pose === 'lying' ? 'standing' : 'lyingFront'; // fall forward / get up from your back
        else L.pose = L.pose === 'lyingFront' ? 'standing' : 'lying'; // fall backward / get up from your front
      } else {
        const a = (L.k * Math.PI) / 6;
        const sx = Math.sin(a);
        const sz = Math.cos(a);
        const f = Math.abs(sx) > Math.abs(sz) ? [Math.sign(sx), 0] : [0, Math.sign(sz)]; // the nearest of the 4 grid directions
        const d = e.key === 'ArrowUp' ? f : e.key === 'ArrowDown' ? [-f[0], -f[1]] : e.key === 'ArrowLeft' ? [f[1], -f[0]] : [-f[1], f[0]];
        this.stepPerson(d[0], d[1]);
      }
      this.applyLook();
    };
    this.canvas.addEventListener('pointerdown', L.down);
    this.canvas.addEventListener('pointermove', L.move);
    this.canvas.addEventListener('pointerup', L.up);
    this.canvas.addEventListener('pointercancel', L.up);
    window.addEventListener('keydown', L.key);
    return true;
  }

  // Point the head the same way as the body (straight ahead, level).
  matchHeadToBody() {
    const L = this.looking;
    if (!L) return;
    L.headYaw = 0;
    L.headPitch = 0;
    this.applyLook();
  }

  // Walk one cell: blocked by solid blocks (a single block can be stepped up, a drop of up to 3 is fine).
  stepPerson(dx, dz) {
    const L = this.looking;
    const w = this.world;
    const nx = L.x + dx;
    const nz = L.z + dz;
    if (!w.inBounds(nx, 0, nz)) return;
    const tall = L.pose === 'lying' || L.pose === 'lyingFront' ? 1 : 2;
    const free = (y) => {
      for (let i = 0; i < tall; i++) if (y + i >= w.height || w.get(nx, y + i, nz) !== 0) return false;
      return true;
    };
    let y = L.y;
    if (!free(y)) {
      if (!free(y + 1)) return;
      y += 1;
    } else {
      let fall = 0;
      while (y > 0 && w.get(nx, y - 1, nz) === 0 && fall < 3) {
        y--;
        fall++;
      }
      if (y > 0 && w.get(nx, y - 1, nz) === 0) return; // too far to drop
    }
    L.x = nx;
    L.y = y;
    L.z = nz;
  }

  applyLook() {
    const L = this.looking;
    if (this.following()) return this.followCamera(); // the animation is moving you; only the head drag applies
    const lying = L.pose === 'lying' || L.pose === 'lyingFront';
    const a = (L.k * Math.PI) / 6; // the figure faces (sin a, 0, cos a)
    L.headYaw = Math.max(-Math.PI, Math.min(Math.PI, L.headYaw));
    L.headPitch = Math.max(-0.7, Math.min(0.7, L.headPitch));
    const off = this.offset;
    const offZ = this.offsetZ;
    const at = new THREE.Vector3(L.x + 0.5 - off, L.y + this.world.standOffset(L.x, L.y, L.z) + (lying ? 0.55 : L.pose === 'sitting' || L.pose === 'ledge' ? 0.9 : 1.4), L.z + 0.5 - offZ);
    if (lying) at.add(new THREE.Vector3(-1.1 * Math.sin(a), 0, -1.1 * Math.cos(a))); // head end
    this.camera.position.copy(at);
    const pitch = Math.max(-1.4, Math.min(1.4, (lying ? -1.1 : 0) + L.headPitch));
    this.camera.rotation.set(-pitch, a + L.headYaw + Math.PI, 0);
    this.dirty = true;
  }

  // Leave the person's eyes; returns the person's final state: { id, x, y, z, rot, twist, pose, headTurn, headTilt }.
  exitPerson() {
    const L = this.looking;
    if (!L) return null;
    this.canvas.removeEventListener('pointerdown', L.down);
    this.canvas.removeEventListener('pointermove', L.move);
    this.canvas.removeEventListener('pointerup', L.up);
    this.canvas.removeEventListener('pointercancel', L.up);
    window.removeEventListener('keydown', L.key);
    L.group.visible = true;
    this.looking = null;
    this.camera.rotation.order = 'XYZ';
    this.camera.fov = this.saved.fov;
    this.camera.updateProjectionMatrix();
    this.camera.position.copy(this.saved.pos);
    this.controls.target.copy(this.saved.target);
    this.controls.enabled = true;
    this.controls.update();
    this.dirty = true;
    return {
      id: L.id,
      x: L.x,
      y: L.y,
      z: L.z,
      rot: Math.floor(L.k / 3),
      twist: L.k % 3,
      pose: L.pose,
      headTurn: Math.max(-6, Math.min(6, Math.round(L.headYaw / (Math.PI / 6)))),
      headTilt: Math.max(-2, Math.min(2, -Math.round(L.headPitch / 0.35))),
    };
  }

  // id of the person under the pointer, or null
  personAt(ray) {
    const roots = [...this.personGroups.values()].map((e) => e.group);
    const hits = ray.raycaster.intersectObjects(roots, true);
    for (const h of hits) {
      let o = h.object;
      while (o && o.userData.personId === undefined) o = o.parent;
      if (o) return o.userData.personId;
    }
    return null;
  }

  // ----- picking -----
  // Returns a ray in WORLD cell coordinates for a pointer position.
  rayFromPointer(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    const rc = new THREE.Raycaster();
    rc.setFromCamera(ndc, this.camera);
    const off = this.offset;
    const offZ = this.offsetZ;
    return {
      origin: [rc.ray.origin.x + this.offset, rc.ray.origin.y, rc.ray.origin.z + this.offsetZ],
      dir: [rc.ray.direction.x, rc.ray.direction.y, rc.ray.direction.z],
      ndc,
      raycaster: rc,
    };
  }

  labelAt(ray) {
    const hits = ray.raycaster.intersectObjects([...this.labelSprites.values()], false);
    return hits.length ? hits[0].object.userData.labelId : null;
  }

  // ----- cursor visuals -----
  showGhost(cell, { color = 0xffffff, opacity = 0.5, scale = 1.002, stair = null } = {}) {
    this.dirty = true;
    if (!cell) {
      this.ghost.visible = false;
      return;
    }
    this.ghost.geometry = stair == null ? this.geometry : stairGeometry(stair); // stairs show their steps and which way they climb
    const off = this.offset;
    const offZ = this.offsetZ;
    this.ghost.position.set(cell[0] + 0.5 - off, cell[1] + 0.5, cell[2] + 0.5 - offZ);
    this.ghost.scale.setScalar(scale);
    this.ghost.material.color.set(color);
    this.ghost.material.opacity = opacity;
    this.ghost.visible = true;
  }

  // mode: 'off' | 'x' | 'z' | 'xz' - draws the mirror plane(s) through the middle of the stand
  showSymmetry(mode) {
    this.symMode = mode;
    this.dirty = true;
    const size = this.world.size;
    const tall = 14;
    this.planeX.visible = mode === 'x' || mode === 'xz';
    this.planeZ.visible = mode === 'z' || mode === 'xz';
    this.planeX.scale.set(this.world.sz, tall, 1);
    this.planeX.position.set(0, tall / 2, 0);
    this.planeZ.scale.set(this.world.sx, tall, 1);
    this.planeZ.position.set(0, tall / 2, 0);
  }

  // The Mirror tool's chosen line: a vertical plane on the cell edge `boundary` (axis 'x' or 'z'); null puts the symmetry planes back.
  showMirrorLine(axis, boundary) {
    if (!axis) return this.showSymmetry(this.symMode || 'off');
    this.dirty = true;
    const tall = 14;
    const plane = axis === 'x' ? this.planeX : this.planeZ;
    this.planeX.visible = this.planeZ.visible = false;
    plane.visible = true;
    plane.scale.set(axis === 'x' ? this.world.sz : this.world.sx, tall, 1);
    plane.position.set(axis === 'x' ? boundary - this.offset : 0, tall / 2, axis === 'z' ? boundary - this.offsetZ : 0);
  }

  // Preview of the mirrored copies of the cell under the pointer.
  showMirrorGhosts(cells, { color = 0xffffff, opacity = 0.35, scale = 1.002 } = {}) {
    this.dirty = true;
    const off = this.offset;
    const offZ = this.offsetZ;
    while (this.mirrorGhosts.length < cells.length) {
      const g = new THREE.Mesh(this.geometry, new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false }));
      g.add(new THREE.LineSegments(new THREE.EdgesGeometry(this.geometry), new THREE.LineBasicMaterial({ color: 0x000000 })));
      g.renderOrder = 5;
      this.helpers.add(g);
      this.mirrorGhosts.push(g);
    }
    this.mirrorGhosts.forEach((g, i) => {
      const c = cells[i];
      g.visible = !!c;
      if (!c) return;
      g.position.set(c[0] + 0.5 - off, c[1] + 0.5, c[2] + 0.5 - offZ);
      g.scale.setScalar(scale);
      g.material.color.set(color);
      g.material.opacity = opacity;
    });
  }

  showRegion(a, b) {
    this.dirty = true;
    if (!a || !b) {
      this.region.visible = false;
      return;
    }
    const off = this.offset;
    const offZ = this.offsetZ;
    const lo = [0, 1, 2].map((i) => Math.min(a[i], b[i]));
    const hi = [0, 1, 2].map((i) => Math.max(a[i], b[i]) + 1);
    this.region.scale.set(hi[0] - lo[0] + 0.02, hi[1] - lo[1] + 0.02, hi[2] - lo[2] + 0.02);
    this.region.position.set((lo[0] + hi[0]) / 2 - off, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2 - offZ);
    this.region.visible = true;
  }

  showSelection(a, b) {
    this.dirty = true;
    if (!a || !b) {
      this.selection.visible = false;
      return;
    }
    const off = this.offset;
    const offZ = this.offsetZ;
    const lo = [0, 1, 2].map((i) => Math.min(a[i], b[i]));
    const hi = [0, 1, 2].map((i) => Math.max(a[i], b[i]) + 1);
    this.selection.scale.set(hi[0] - lo[0] + 0.03, hi[1] - lo[1] + 0.03, hi[2] - lo[2] + 0.03);
    this.selection.position.set((lo[0] + hi[0]) / 2 - off, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2 - offZ);
    this.selection.visible = true;
  }

  // Where a pasted clip (w x h x d) would land with its corner at `origin`; ok=false turns it red.
  showFootprint(size, origin, ok) {
    this.dirty = true;
    if (!size || !origin) {
      this.footprint.visible = false;
      return;
    }
    const off = this.offset;
    const offZ = this.offsetZ;
    const [w, h, d] = size;
    this.footprint.position.set(origin[0] + w / 2 - off, origin[1] + h / 2, origin[2] + d / 2 - offZ);
    this.footprintEdges.scale.set(w + 0.02, h + 0.02, d + 0.02);
    this.footprintBody.scale.set(w, h, d);
    this.footprintPlate.scale.set(w, d, 1);
    this.footprintPlate.position.set(0, -h / 2 + 0.04, 0);
    const color = ok ? 0x34d399 : 0xff5c5c;
    this.footprintBody.material.color.set(color);
    this.footprintPlate.material.color.set(color);
    this.footprintEdges.material.color.set(ok ? 0xffffff : 0xff8a8a);
    this.footprint.visible = true;
  }

  setGhostTint(block) {
    // average colour of a block's top texture, used to tint the placement preview
    this.tints = this.tints || new Map();
    if (this.tints.has(block.id)) return this.tints.get(block.id);
    const canvas = textureCanvas(typeof block.tex === 'string' ? block.tex : block.tex.top);
    const d = canvas.getContext('2d').getImageData(0, 0, 16, 16).data;
    let r = 0, g = 0, b = 0;
    for (let i = 0; i < d.length; i += 4) {
      r += d[i];
      g += d[i + 1];
      b += d[i + 2];
    }
    const n = d.length / 4;
    const tint = (Math.round(r / n) << 16) | (Math.round(g / n) << 8) | Math.round(b / n);
    this.tints.set(block.id, tint);
    return tint;
  }

  // ----- fly mode (point of view) -----
  // Arrows fly: up/down forward/back, left/right turn. Shift + arrows: left/right slide sideways, up/down rise/sink.
  // Dragging looks around; a plain click still builds because main.js tells clicks and drags apart.
  enterFly() {
    if (this.flying || this.looking || this.anim) return false;
    const dir = this.controls.target.clone().sub(this.camera.position).normalize();
    this.saved = { pos: this.camera.position.clone(), target: this.controls.target.clone(), fov: this.camera.fov };
    const F = (this.flying = {
      yaw: Math.atan2(-dir.x, -dir.z),
      pitch: Math.asin(Math.max(-1, Math.min(1, dir.y))),
      keys: new Set(),
      shift: false,
      last: performance.now(),
      drag: null,
    });
    this.controls.enabled = false;
    this.camera.fov = 70;
    this.camera.updateProjectionMatrix();
    this.camera.rotation.order = 'YXZ';
    this.camera.rotation.set(F.pitch, F.yaw, 0);
    F.down = (e) => {
      F.drag = { x: e.clientX, y: e.clientY };
      this.canvas.setPointerCapture?.(e.pointerId);
    };
    F.move = (e) => {
      if (!F.drag) return;
      F.yaw -= (e.clientX - F.drag.x) * 0.005;
      F.pitch = Math.max(-1.5, Math.min(1.5, F.pitch - (e.clientY - F.drag.y) * 0.005));
      F.drag = { x: e.clientX, y: e.clientY };
      this.camera.rotation.set(F.pitch, F.yaw, 0);
      this.dirty = true;
      this.onFlyMove?.();
    };
    F.up = () => (F.drag = null);
    const typing = (e) => e.target.closest?.('input, textarea, select') || document.querySelector('dialog[open]');
    F.keydown = (e) => {
      if (!e.key.startsWith('Arrow') || typing(e)) return;
      e.preventDefault();
      F.shift = e.shiftKey;
      F.keys.add(e.key);
    };
    F.keyup = (e) => {
      F.shift = e.shiftKey;
      F.keys.delete(e.key);
    };
    F.blur = () => F.keys.clear();
    this.canvas.addEventListener('pointerdown', F.down);
    this.canvas.addEventListener('pointermove', F.move);
    this.canvas.addEventListener('pointerup', F.up);
    this.canvas.addEventListener('pointercancel', F.up);
    window.addEventListener('keydown', F.keydown);
    window.addEventListener('keyup', F.keyup);
    window.addEventListener('blur', F.blur);
    this.dirty = true;
    return true;
  }

  // Called every frame while flying.
  updateFly() {
    const F = this.flying;
    const now = performance.now();
    const dt = Math.min(0.1, (now - F.last) / 1000);
    F.last = now;
    if (!F.keys.size) return;
    const shift = F.shift;
    const a = (k) => (F.keys.has(k) ? 1 : 0);
    const fwd = a('ArrowUp') - a('ArrowDown');
    const side = a('ArrowRight') - a('ArrowLeft');
    const pos = this.camera.position;
    if (shift) {
      // slide sideways and rise/sink
      pos.x += Math.cos(F.yaw) * side * 8 * dt;
      pos.z += -Math.sin(F.yaw) * side * 8 * dt;
      pos.y += fwd * 6 * dt;
    } else {
      F.yaw -= side * 1.9 * dt;
      pos.x += -Math.sin(F.yaw) * fwd * 8 * dt;
      pos.z += -Math.cos(F.yaw) * fwd * 8 * dt;
    }
    const limX = this.world.sx / 2 + 12;
    const limZ = this.world.sz / 2 + 12;
    pos.x = Math.max(-limX, Math.min(limX, pos.x));
    pos.z = Math.max(-limZ, Math.min(limZ, pos.z));
    pos.y = Math.max(0.6, Math.min(this.world.height + 8, pos.y));
    this.camera.rotation.set(F.pitch, F.yaw, 0);
    this.dirty = true;
    this.onFlyMove?.();
  }

  // Leaves the camera where it is and hands it back to the orbit controls.
  exitFly() {
    const F = this.flying;
    if (!F) return false;
    this.canvas.removeEventListener('pointerdown', F.down);
    this.canvas.removeEventListener('pointermove', F.move);
    this.canvas.removeEventListener('pointerup', F.up);
    this.canvas.removeEventListener('pointercancel', F.up);
    window.removeEventListener('keydown', F.keydown);
    window.removeEventListener('keyup', F.keyup);
    window.removeEventListener('blur', F.blur);
    this.flying = null;
    const dir = new THREE.Vector3(-Math.sin(F.yaw) * Math.cos(F.pitch), Math.sin(F.pitch), -Math.cos(F.yaw) * Math.cos(F.pitch));
    const t = this.camera.position.clone().addScaledVector(dir, 12);
    this.camera.rotation.order = 'XYZ';
    this.camera.fov = this.saved.fov;
    this.camera.updateProjectionMatrix();
    this.controls.target.set(t.x, Math.max(0, t.y), t.z);
    this.controls.enabled = true;
    this.controls.update();
    this.dirty = true;
    return true;
  }

  // ----- camera -----
  resetCamera() {
    this.dirty = true;
    const k = this.world.size;
    this.controls.target.set(0, k * 0.1, 0);
    this.camera.position.set(k * 0.62, k * 0.58, k * 0.8);
    this.controls.update();
  }

  setHelpersVisible(v) {
    this.dirty = true;
    this.helpers.visible = v;
  }

  resize() {
    const w = Math.max(1, this.container.clientWidth);
    const h = Math.max(1, this.container.clientHeight);
    this.renderer.setSize(w, h, false);
    this.canvas.style.width = '100%';
    this.canvas.style.height = '100%';
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.dirty = true;
  }

  invalidate() {
    this.dirty = true;
  }

  // Renders only when something changed (camera moved, scene edited, cursor moved), so an idle
  // page uses almost no CPU/GPU.
  loop() {
    requestAnimationFrame(this.loop);
    const limX = this.world.sx / 2 + 2;
    const limZ = this.world.sz / 2 + 2;
    const t = this.controls.target;
    t.x = Math.max(-limX, Math.min(limX, t.x));
    t.z = Math.max(-limZ, Math.min(limZ, t.z));
    t.y = Math.max(0, Math.min(this.world.height, t.y));
    if (this.flowWaiting) this.updateFlowReveal();
    if (this.flying) this.updateFly();
    if (this.anim) this.updateAnimation();
    let eased = false;
    if (this.zoomGoal != null && !this.looking && !this.flying) {
      const off = this.camera.position.clone().sub(t);
      const d = off.length();
      const nd = d + (this.zoomGoal - d) * 0.2;
      if (Math.abs(this.zoomGoal - d) < 0.01) this.zoomGoal = null;
      else { this.camera.position.copy(t).add(off.setLength(nd)); eased = true; }
    } else this.zoomGoal = null;
    const moved = this.looking || this.flying ? false : this.controls.update() || eased; // the camera is driven by the person view / fly mode
    if (moved || this.dirty) {
      if (this.dirty) this.renderer.shadowMap.needsUpdate = true;
      this.dirty = false;
      this.renderer.render(this.scene, this.camera);
    }
  }

  // Render a clean picture (no grid/cursor) at the given size. Returns a 2D canvas.
  snapshot(width, height) {
    const oldSize = new THREE.Vector2();
    this.renderer.getSize(oldSize);
    const oldPR = this.renderer.getPixelRatio();
    const oldAspect = this.camera.aspect;
    this.updateFlowReveal(true);
    const helpersWere = this.helpers.visible;
    this.helpers.visible = false;
    this.renderer.setPixelRatio(1);
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.shadowMap.needsUpdate = true;
    this.renderer.render(this.scene, this.camera);
    const out = document.createElement('canvas');
    out.width = width;
    out.height = height;
    out.getContext('2d').drawImage(this.canvas, 0, 0);
    this.helpers.visible = helpersWere;
    this.renderer.setPixelRatio(oldPR);
    this.renderer.setSize(oldSize.x, oldSize.y, false);
    this.camera.aspect = oldAspect;
    this.camera.updateProjectionMatrix();
    this.dirty = true;
    return out;
  }
}
