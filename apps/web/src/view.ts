import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import type { Sim } from "@digmole/sim";

/** Ground colour ramp, from a shadowed pit floor up to sunlit sand. */
const RAMP: Array<[number, number]> = [
  [-3.0, 0x4b3d29],
  [-0.8, 0x6a5940],
  [0.1, 0x9a8358],
  [1.2, 0xbca57b],
  [2.6, 0xdccaa6],
  [3.6, 0xf0e4c9],
];

const _a = new THREE.Color();
const _b = new THREE.Color();
const _tmp = new THREE.Color();

function colorAt(h: number, target: THREE.Color): void {
  const first = RAMP[0]!;
  if (h <= first[0]) {
    target.setHex(first[1]);
  } else {
    let done = false;
    for (let i = 1; i < RAMP.length; i++) {
      const [h1, c1] = RAMP[i]!;
      if (h <= h1) {
        const [h0, c0] = RAMP[i - 1]!;
        const k = (h - h0) / (h1 - h0 || 1);
        _a.setHex(c0);
        _b.setHex(c1);
        target.copy(_a).lerp(_b, k);
        done = true;
        break;
      }
    }
    if (!done) target.setHex(RAMP[RAMP.length - 1]![1]);
  }
  // Faint contours every half meter: enough to read the shape of the ground
  // without turning it into a topographic map.
  const band = Math.abs(((h / 0.5) % 1) - 0.5) * 2;
  const shade = 0.93 + 0.07 * band;
  target.multiplyScalar(shade);
}

export interface WorldView {
  update(sim: Sim): void;
  resize(): void;
}

export function createWorldView(canvas: HTMLCanvasElement, sim: Sim): WorldView {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xa9c4e2);
  scene.fog = new THREE.Fog(0xa9c4e2, 55, 135);

  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 400);
  camera.position.set(13, 15, -17);

  const controls = new OrbitControls(camera, canvas);
  controls.target.set(0, 0, 0);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.maxPolarAngle = Math.PI * 0.48;
  controls.minDistance = 6;
  controls.maxDistance = 80;

  // The camera trails the machine so it never drives out of frame, while the
  // player is still free to orbit. Both target and camera move by the same
  // delta, so the orbit offset is preserved.
  const follow = new THREE.Vector3(sim.world.machine.state.x, 1.4, sim.world.machine.state.z);
  const scratch = new THREE.Vector3();
  let followInit = false;

  // --- light ---
  scene.add(new THREE.HemisphereLight(0xcfe3ff, 0x6b5a44, 0.85));

  const sun = new THREE.DirectionalLight(0xfff0d2, 2.6);
  sun.position.set(26, 34, 7);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 160;
  sun.shadow.camera.left = -55;
  sun.shadow.camera.right = 55;
  sun.shadow.camera.top = 55;
  sun.shadow.camera.bottom = -55;
  sun.shadow.bias = -0.0008;
  scene.add(sun);
  scene.add(sun.target);
  sun.target.position.set(0, 0, 0);

  // --- terrain ---
  const t = sim.world.terrain;
  const nx = t.nx;
  const nz = t.nz;
  const positions = new Float32Array(nx * nz * 3);
  const colors = new Float32Array(nx * nz * 3);
  const indices = new Uint32Array((nx - 1) * (nz - 1) * 6);

  for (let iz = 0; iz < nz; iz++) {
    for (let ix = 0; ix < nx; ix++) {
      const i = iz * nx + ix;
      positions[i * 3] = t.vx(ix);
      positions[i * 3 + 1] = 0;
      positions[i * 3 + 2] = t.vz(iz);
    }
  }
  let k = 0;
  for (let iz = 0; iz < nz - 1; iz++) {
    for (let ix = 0; ix < nx - 1; ix++) {
      const a = iz * nx + ix;
      const b = a + 1;
      const c = a + nx;
      const d = c + 1;
      // Winding chosen so the face normal points up (+Y).
      indices[k++] = a;
      indices[k++] = c;
      indices[k++] = b;
      indices[k++] = b;
      indices[k++] = c;
      indices[k++] = d;
    }
  }

  const geo = new THREE.BufferGeometry();
  const posAttr = new THREE.BufferAttribute(positions, 3);
  const colAttr = new THREE.BufferAttribute(colors, 3);
  geo.setAttribute("position", posAttr);
  geo.setAttribute("color", colAttr);
  geo.setIndex(new THREE.BufferAttribute(indices, 1));

  const terrainMat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.96,
    metalness: 0,
  });
  const terrainMesh = new THREE.Mesh(geo, terrainMat);
  terrainMesh.castShadow = true;
  terrainMesh.receiveShadow = true;
  scene.add(terrainMesh);

  function refreshTerrain(): void {
    const heights = t.heights;
    for (let iz = 0; iz < nz; iz++) {
      for (let ix = 0; ix < nx; ix++) {
        const i = iz * nx + ix;
        const h = heights[i] ?? 0;
        positions[i * 3 + 1] = h;
        colorAt(h, _tmp);

        // Cheap slope shading: steep faces go darker, which is what makes the
        // heap and the pit read as shapes instead of a flat plane.
        const xm = ix > 0 ? (heights[i - 1] ?? h) : h;
        const xp = ix < nx - 1 ? (heights[i + 1] ?? h) : h;
        const zm = iz > 0 ? (heights[i - nx] ?? h) : h;
        const zp = iz < nz - 1 ? (heights[i + nx] ?? h) : h;
        const slope = Math.hypot((xp - xm) / (2 * t.cell), (zp - zm) / (2 * t.cell));
        _tmp.multiplyScalar(1 - Math.min(0.32, slope * 0.45));

        colors[i * 3] = _tmp.r;
        colors[i * 3 + 1] = _tmp.g;
        colors[i * 3 + 2] = _tmp.b;
      }
    }
    posAttr.needsUpdate = true;
    colAttr.needsUpdate = true;
    geo.computeVertexNormals();
    geo.computeBoundingSphere();
  }
  refreshTerrain();

  // --- excavator ---
  const cfg = sim.world.machine.cfg;
  const yellow = new THREE.MeshStandardMaterial({ color: 0xf0a800, roughness: 0.5, metalness: 0.2 });
  const yellowDark = new THREE.MeshStandardMaterial({ color: 0xb98800, roughness: 0.6, metalness: 0.15 });
  const steel = new THREE.MeshStandardMaterial({ color: 0x3a3f46, roughness: 0.5, metalness: 0.55 });
  const trackMat = new THREE.MeshStandardMaterial({ color: 0x24262b, roughness: 0.95 });
  const glass = new THREE.MeshStandardMaterial({ color: 0x1d2c3b, roughness: 0.15, metalness: 0.7 });

  function box(
    w: number,
    h: number,
    d: number,
    mat: THREE.Material,
    x = 0,
    y = 0,
    z = 0,
  ): THREE.Mesh {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    m.position.set(x, y, z);
    m.castShadow = true;
    m.receiveShadow = true;
    return m;
  }

  const root = new THREE.Group();
  const turret = new THREE.Group();
  root.add(turret);
  scene.add(root);

  // tracks
  root.add(box(4.0, 0.85, 0.8, trackMat, 0, 0.42, 0.75));
  root.add(box(4.0, 0.85, 0.8, trackMat, 0, 0.42, -0.75));
  root.add(box(3.2, 0.3, 1.2, steel, 0, 0.85, 0));

  // upper structure
  turret.add(box(3.1, 1.0, 2.3, yellow, 0, 1.35, 0));
  turret.add(box(0.9, 1.15, 2.2, yellowDark, -1.5, 1.45, 0));
  turret.add(box(1.15, 1.05, 1.0, glass, 0.5, 2.3, 0.62));
  turret.add(box(1.2, 0.12, 1.05, yellow, 0.5, 2.86, 0.62));

  const armRoot = new THREE.Group();
  armRoot.position.y = cfg.pivotHeight;
  turret.add(armRoot);

  const boomGroup = new THREE.Group();
  armRoot.add(boomGroup);
  boomGroup.add(box(cfg.boomLength, 0.42, 0.62, yellow, cfg.boomLength / 2, 0, 0));

  const elbow = new THREE.Group();
  elbow.position.x = cfg.boomLength;
  boomGroup.add(elbow);

  const stickGroup = new THREE.Group();
  elbow.add(stickGroup);
  stickGroup.add(box(cfg.stickLength, 0.34, 0.46, yellow, cfg.stickLength / 2, 0, 0));

  const bucketPivot = new THREE.Group();
  bucketPivot.position.x = cfg.stickLength;
  stickGroup.add(bucketPivot);

  const bucketGroup = new THREE.Group();
  bucketPivot.add(bucketGroup);
  bucketGroup.add(box(cfg.bucketLength * 0.95, 0.9, cfg.bucketWidth, yellowDark, cfg.bucketLength * 0.45, -0.1, 0));
  for (let i = 0; i < 4; i++) {
    const z = -cfg.bucketWidth / 2 + (cfg.bucketWidth / 4) * (i + 0.5);
    bucketGroup.add(box(0.16, 0.1, 0.22, steel, cfg.bucketLength * 0.92, -0.52, z));
  }

  // a little hydraulic cylinder so the arm reads as a machine, not a stick figure
  const ram = box(1.7, 0.16, 0.16, steel, 0, 0, 0);
  ram.position.set(1.9, 0.55, 0);
  boomGroup.add(ram);

  // --- truck ---
  const truckTarget = sim.world.truck("truck-01");
  const truck = new THREE.Group();
  if (truckTarget) {
    const blue = new THREE.MeshStandardMaterial({ color: 0x2f6fb5, roughness: 0.5, metalness: 0.3 });
    const bedMat = new THREE.MeshStandardMaterial({ color: 0x4a4f57, roughness: 0.85, metalness: 0.3 });
    const wheel = new THREE.MeshStandardMaterial({ color: 0x1a1c1f, roughness: 0.95 });

    truck.add(box(2.2, 1.9, 2.4, blue, 2.9, 1.55, 0)); // cab
    truck.add(box(5.6, 0.35, 2.7, bedMat, -1.0, 1.15, 0)); // bed floor
    truck.add(box(5.6, 1.2, 0.16, bedMat, -1.0, 1.75, 1.27));
    truck.add(box(5.6, 1.2, 0.16, bedMat, -1.0, 1.75, -1.27));
    truck.add(box(0.16, 1.2, 2.7, bedMat, -3.75, 1.75, 0));
    truck.add(box(0.16, 1.2, 2.7, bedMat, 1.75, 1.75, 0));

    const loadGeo = new THREE.BoxGeometry(5.2, 1, 2.4);
    loadGeo.translate(0, 0.5, 0);
    const loadMat = new THREE.MeshStandardMaterial({ color: 0x8a7656, roughness: 0.95 });
    const load = new THREE.Mesh(loadGeo, loadMat);
    load.position.set(-1.0, 1.35, 0);
    load.castShadow = true;
    truck.add(load);
    (truck as unknown as { loadMesh: THREE.Mesh }).loadMesh = load;

    for (const x of [2.4, -2.6, -3.6]) {
      for (const z of [1.15, -1.15]) {
        const w = new THREE.Mesh(new THREE.CylinderGeometry(0.62, 0.62, 0.42, 18), wheel);
        w.rotation.x = Math.PI / 2;
        w.position.set(x, 0.62, z);
        w.castShadow = true;
        truck.add(w);
      }
    }
    truck.position.set(truckTarget.x, 0, truckTarget.z);
    truck.rotation.y = -0.45;
    scene.add(truck);
  }

  // --- site props (scale reference) ---
  const coneMat = new THREE.MeshStandardMaterial({ color: 0xf2600f, roughness: 0.7 });
  const coneGeo = new THREE.ConeGeometry(0.28, 0.75, 14);
  for (const [x, z] of [
    [-13.5, -10],
    [-11.2, -9.2],
    [-6.6, -9.4],
    [-4.6, -11.4],
    [-13, -16],
    [-6, -16.6],
  ]) {
    const cone = new THREE.Mesh(coneGeo, coneMat);
    cone.position.set(x, 0.38, z);
    cone.castShadow = true;
    scene.add(cone);
    const base = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.06, 0.62), coneMat);
    base.position.set(x, 0.03, z);
    scene.add(base);
  }

  // --- loop helpers ---
  let lastTerrainVersion = -1;
  let lastTerrainAt = 0;

  function resize(): void {
    const w = canvas.clientWidth || window.innerWidth;
    const h = canvas.clientHeight || window.innerHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  resize();
  window.addEventListener("resize", resize);

  function update(simNow: Sim): void {
    const m = simNow.world.machine;
    root.position.set(m.state.x, m.baseY, m.state.z);
    root.rotation.y = -m.state.heading;
    turret.rotation.y = -m.state.swing;
    boomGroup.rotation.z = m.state.boom;
    stickGroup.rotation.z = m.state.stick - m.state.boom;
    bucketGroup.rotation.z = m.state.curl;

    const now = performance.now();
    const tip = m.tipWorld();
    // Aim between the machine and its bucket: that is where the work happens.
    scratch.set(
      m.state.x + (tip.x - m.state.x) * 0.45,
      m.baseY + 2.4,
      m.state.z + (tip.z - m.state.z) * 0.45,
    );
    if (!followInit) {
      follow.copy(scratch);
      controls.target.copy(follow);
      camera.position.copy(follow).add(new THREE.Vector3(13, 15, -17));
      followInit = true;
    } else {
      const k = 1 - Math.exp(-3 * 0.016);
      follow.lerp(scratch, k);
      scratch.copy(follow).sub(controls.target);
      if (scratch.lengthSq() > 1e-8) {
        controls.target.add(scratch);
        camera.position.add(scratch);
      }
    }

    if (t.version !== lastTerrainVersion && now - lastTerrainAt > 55) {
      lastTerrainVersion = t.version;
      lastTerrainAt = now;
      refreshTerrain();
    }

    if (truckTarget) {
      const mesh = (truck as unknown as { loadMesh?: THREE.Mesh }).loadMesh;
      if (mesh) {
        const fill = Math.max(0, Math.min(1, truckTarget.filled / truckTarget.capacity));
        mesh.scale.y = Math.max(0.001, fill * 1.0);
        mesh.visible = fill > 0.005;
      }
    }

    controls.update();
    renderer.render(scene, camera);
  }

  return { update, resize };
}
