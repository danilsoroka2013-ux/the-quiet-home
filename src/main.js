import * as THREE from 'three';
import { FBXLoader } from '../vendor/addons/loaders/FBXLoader.js';
import { GLTFLoader } from '../vendor/addons/loaders/GLTFLoader.js';
import { connectToQuickGame, isFirebaseConfigured } from './firebase-online.js';

const $ = (id) => document.getElementById(id);
const dom = {
  canvas: $('gameCanvas'),
  loading: $('loadingScreen'), loadingFill: $('loadingFill'), loadingStatus: $('loadingStatus'),
  start: $('startScreen'), pause: $('pauseScreen'), death: $('deathScreen'), win: $('winScreen'), error: $('errorScreen'), errorText: $('errorText'),
  startButton: $('startButton'), resumeButton: $('resumeButton'), restartButton: $('restartButton'), retryButton: $('retryButton'), playAgainButton: $('playAgainButton'), pauseButton: $('pauseButton'),
  objectiveHistory: $('objectiveHistory'), objectiveCurrent: $('objectiveCurrent'), onlineStatus: $('onlineStatus'), observerStatus: $('observerStatus'), trapNotice: $('trapNotice'),
  jumpscareScreen: $('jumpscareScreen'),
  hud: $('hud'), crosshair: $('crosshair'), interactPrompt: $('interactPrompt'), interactLabel: $('interactLabel'),
  objectiveText: $('objectiveText'), staminaFill: $('staminaFill'), damageFlash: $('damageFlash'),
  mobileControls: $('mobileControls'), rotateNotice: $('rotateNotice'), moveStick: $('moveStick'), lookSurface: $('lookSurface'), mobileCrouchButton: $('mobileCrouchButton'), mobileRunButton: $('mobileRunButton'), mobileInteractButton: $('mobileInteractButton'),
};

const mobileDevice = matchMedia('(pointer: coarse)').matches || navigator.maxTouchPoints > 0 || /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
// Safari (WebKit без Chrome) ведёт себя ненадёжно с Pointer Lock: при попытке
// повернуть камеру окно «слетает» (теряет фокус/пытается свернуться). В Safari
// вращение камеры делаем через удержание мыши (drag-look), pointer lock оставляем
// только для Chrome/Firefox/Edge.
const isSafari = /Safari/.test(navigator.userAgent) && !/Chrome|CriOS|Edg|OPR/.test(navigator.userAgent);

function shouldUsePointerLock() {
  return !mobileDevice && !isSafari && !game.pointerLockUnsupported;
}
const MAX_DELTA = 0.05;
const UPPER_FLOOR_Y = 3.0;
// The flight turns 90° to the right (east) and is nudged 0.2 m toward the rear/south.
const STAIR_BOTTOM = { x: 2.4, z: -3.8 };
const STAIR_TOP = { x: 5.3, z: -3.8 };
const STAIR_BOTTOM_APPROACH = { x: 3.1, z: -3.8 };
const STAIR_TOP_APPROACH = { x: 5.75, z: -3.8 };
const STAIR_HOLE = { minX: 2.825, maxX: 4.875, minZ: -4.545, maxZ: -3.005 };
const ROOM = { minX: -10, maxX: 10, minZ: -10, maxZ: 10, height: 3.0, wall: 0.24, doorWidth: 1.18, doorHeight: 2.18 };
const WORLD = { minX: -19, maxX: 19, minZ: -19, maxZ: 19 };
const EXTERIOR_ARM_END = 18;
const EXTERIOR_JUNCTION = 14;
const EXTERIOR_CORRIDOR_HALF = 1.5;
const EXTERIOR_BRANCH_HALF = 1.1;
const EXTERIOR_BRANCH_END = 8;
const ASSET = {
  grannyHigh: './assets/models/granny-high.fbx',
  grannyLow: './assets/models/granny-low.fbx',
  floorColor: './assets/textures/WoodFloor064_1K-JPG_Color.jpg',
  trapClosed: './assets/models/traps/survival__BearTrap_Closed.glb',
  trapOpen: './assets/models/traps/survival__BearTrap_Open.glb',
  ambience: './assets/audio/spooky-ambience.mp3',
  doorSound: './assets/audio/door-creak.mp3',
  footsteps: './assets/audio/wood-footsteps.mp3',
};
const PROP_NAMES = [
  'bedDouble', 'sideTable', 'loungeSofa', 'kitchenFridge',
  'kitchenSink', 'kitchenCabinet', 'bathroomSink', 'cabinetBedDrawer'
];

let renderer, scene, camera, clock, listener, audioLoader, gltfLoader, fbxLoader;
let materials = {}, textures = {}, props = new Map(), trapModels = new Map(), propsReady = false, grannyReady = false;
let granny = null, audioBuffers = {};
let houseLights = [], wallColliders = [], worldColliders = [], doors = [], items = [], searchContainers = [];
let navigationGrids = [], navigationVersion = 0, wallPaintings = [];
const NAV_STEP = 0.5;
const NAV_MIN = WORLD.minX + 0.5;
const NAV_MAX = WORLD.maxX - 0.5;
const NAV_CELLS = Math.round((NAV_MAX - NAV_MIN) / NAV_STEP) + 1;
let playerAudioAnchor = null, currentInteractable = null;
let damageTimer = 0;
let menuNoiseAnimation = 0;

const game = {
  started: false,
  connecting: false,
  paused: false,
  finished: false,
  keys: new Set(),
  player: { x: 0, z: 0, vx: 0, vz: 0, stamina: 100, crouched: false, height: 1.68, floor: 0, floorY: 0, targetFloorY: 0, bob: 0, stepTimer: 0, stepOffset: 0, moved: 0, stairTransition: null, trappedTimer: 0 },
  cameraYaw: 0,
  targetYaw: 0,
  cameraPitch: 0,
  targetPitch: 0,
  mobileMove: { x: 0, y: 0 },
  mobileSprint: false,
  audioEnabled: true,
  audioStarted: false,
  noise: { x: 0, z: 0, floor: 0, timer: 0, level: 0 },
  inventory: new Set(),
  ai: { state: 'patrol', waypoint: 0, searchTimer: 0, losTimer: 0, seesPlayer: false, floor: 0, targetUid: null, timeInState: 0, lastSeen: null, lastHeard: null, searchOrigin: null, searchIndex: 0, stuckTimer: 0, trapTimer: 0, attackPlayed: false, path: [], pathIndex: 0, pathTimer: 0, pathGoal: null, pathFloor: 0, pathMode: null },
  online: null, localAvatar: null, remotePlayers: new Map(), onlineSyncTimer: 0, pendingRemoteWorld: null, pendingHostId: null, remoteGrannyState: null,
  observer: false, watchingUid: null,
  pointerLockUnsupported: false,
  traps: [], trapNoticeTimer: 0,
  deathSequence: null, jumpscarePlayed: false,
};

const patrolRoute = [
  { x: 0, z: -8 }, { x: 0, z: -13.4 }, { x: -4.75, z: -14 },
  { x: 0, z: -14 }, { x: 4.75, z: -14 }, { x: 8.4, z: -14 },
  { x: 14, z: -14 }, { x: 14, z: -8 }, { x: 14, z: 0 }, { x: 14, z: 8 },
  { x: 14, z: 14 }, { x: 8.4, z: 14 }, { x: 0, z: 14 }, { x: -8.4, z: 14 },
  { x: -14, z: 14 }, { x: -14, z: 8 }, { x: -14, z: 0 }, { x: -14, z: -8 },
  { x: -14, z: -14 }, { x: -8.4, z: -14 }, { x: 0, z: -8 },
  { x: 8, z: -8 }, { x: 8, z: 0 }, { x: 8, z: 8 }, { x: 0, z: 8 },
  { x: -8, z: 8 }, { x: -8, z: 0 }, { x: -8, z: -8 },
];

const GRANNY_SPAWN_SPOTS = [
  { x: -6.0, z: -8.0, floor: 0 },
  { x: 4.2, z: -8.0, floor: 0 },
  { x: -6.5, z: 8.0, floor: 0 },
];
const PLAYER_SPAWN_POINTS = [
  { x: 0, z: 0 }, { x: -0.75, z: 0.45 }, { x: 0.75, z: 0.45 }, { x: 0, z: -0.85 },
];
const PLAYER_COLORS = [0xd45b52, 0x4d8cbd, 0x7d9d62, 0xb187c5];
const MENU_ORBIT_POINTS = [
  new THREE.Vector3(0, 12, -25), new THREE.Vector3(18, 9, -19),
  new THREE.Vector3(25, 8, 0), new THREE.Vector3(18, 11, 19),
  new THREE.Vector3(0, 13, 25), new THREE.Vector3(-18, 9, 19),
  new THREE.Vector3(-25, 8, 0), new THREE.Vector3(-18, 12, -19),
];
let menuOrbit = { segment: 0, t: 0, hold: 0, initialized: false };
let objectiveCompleted = false;

function setLoadProgress(value, label) {
  dom.loadingFill.style.width = `${Math.max(0, Math.min(100, value))}%`;
  if (label) dom.loadingStatus.textContent = label;
}

function showError(message) {
  dom.errorText.textContent = message;
  dom.error.classList.remove('hidden');
  dom.loading.classList.add('done');
}

function loadTexture(url, color = false) {
  const loader = new THREE.TextureLoader();
  return loader.loadAsync(url).then((texture) => {
    texture.colorSpace = color ? THREE.SRGBColorSpace : THREE.LinearSRGBColorSpace;
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.anisotropy = Math.min(2, renderer.capabilities.getMaxAnisotropy());
    return texture;
  });
}

async function loadTextures() {
  try { textures.floorColor = await loadTexture(ASSET.floorColor, true); }
  catch (error) { console.warn('Floor texture fallback:', error); textures.floorColor = null; }
}

function cloneRepeating(texture, repeatX, repeatY) {
  if (!texture) return null;
  const copy = texture.clone();
  copy.wrapS = THREE.RepeatWrapping;
  copy.wrapT = THREE.RepeatWrapping;
  copy.repeat.set(repeatX, repeatY);
  copy.needsUpdate = true;
  return copy;
}

function setupRenderer() {
  renderer = new THREE.WebGLRenderer({ canvas: dom.canvas, antialias: false, powerPreference: 'low-power', alpha: false, stencil: false, depth: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, mobileDevice ? 1 : 1.25));
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = mobileDevice ? 1.18 : 1.22;
  renderer.shadowMap.enabled = false;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.domElement.addEventListener('contextmenu', (event) => event.preventDefault());
  renderer.info.autoReset = true;

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x444b43);
  scene.fog = new THREE.Fog(0x444b43, 52, 90);
  camera = new THREE.PerspectiveCamera(71, window.innerWidth / window.innerHeight, 0.06, 90);
  camera.rotation.order = 'YXZ';
  camera.position.set(game.player.x, game.player.height, game.player.z);
  listener = new THREE.AudioListener();
  camera.add(listener);
  audioLoader = new THREE.AudioLoader();
  gltfLoader = new GLTFLoader();
  fbxLoader = new FBXLoader();
  fbxLoader.setResourcePath('./assets/models/');
  clock = new THREE.Clock();

  scene.add(new THREE.AmbientLight(0xe6e1d2, 0.72));
  const hemi = new THREE.HemisphereLight(0xe8e4d8, 0x756957, 1.05);
  scene.add(hemi);
  const moon = new THREE.DirectionalLight(0xd7dec6, 0.45);
  moon.position.set(-8, 12, -6);
  moon.castShadow = false;
  scene.add(moon);

}

function setMaterialTextures() {
  const floorMap = cloneRepeating(textures.floorColor, 2.2, 2.2);
  materials.floor = new THREE.MeshStandardMaterial({ color: 0xf0e7d5, map: floorMap, roughness: 0.9, metalness: 0 });
  materials.wall = new THREE.MeshStandardMaterial({ color: 0xc5c2b6, roughness: 0.96, metalness: 0 });
  materials.ceiling = new THREE.MeshStandardMaterial({ color: 0xd8d5c8, roughness: 1, side: THREE.DoubleSide });
  materials.ground = new THREE.MeshStandardMaterial({ color: 0x78806d, roughness: 1 });
  materials.wood = new THREE.MeshStandardMaterial({ color: 0x876241, roughness: 0.86 });
  materials.trim = new THREE.MeshStandardMaterial({ color: 0x70553c, roughness: 0.84 });
  materials.metal = new THREE.MeshStandardMaterial({ color: 0x555a51, metalness: 0.2, roughness: 0.62 });
  materials.door = new THREE.MeshStandardMaterial({ color: 0x795539, roughness: 0.86 });
  materials.handle = new THREE.MeshStandardMaterial({ color: 0xa28a5c, metalness: 0.4, roughness: 0.44 });
  materials.bulb = new THREE.MeshStandardMaterial({ color: 0xfff4d5, emissive: 0xffdd99, emissiveIntensity: 1.1, roughness: 0.35 });
}

function addMeshBox(w, h, d, x, y, z, material, options = {}) {
  const geometry = new THREE.BoxGeometry(w, h, d);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(x, y, z);
  mesh.castShadow = options.castShadow ?? false;
  mesh.receiveShadow = options.receiveShadow ?? false;
  mesh.userData.collider = options.collider !== false;
  scene.add(mesh);
  if (options.collider !== false) {
    const collider = { minX: x - w / 2, maxX: x + w / 2, minZ: z - d / 2, maxZ: z + d / 2, type: options.type || 'wall', floor: options.floor ?? 0, mesh };
    worldColliders.push(collider);
    if (options.lineOfSight !== false) wallColliders.push(collider);
  }
  return mesh;
}

function addWallBox(w, h, d, x, y, z, { collider = true, floor = 0 } = {}) {
  return addMeshBox(w, h, d, x, y, z, materials.wall, { collider, floor, castShadow: false, receiveShadow: false, type: 'wall' });
}

function addWallX(x, zStart, zEnd, gapCenters = [], options = {}) {
  const thickness = ROOM.wall;
  const doorW = ROOM.doorWidth;
  const wallHeight = options.height ?? ROOM.height;
  const doorHeight = options.doorHeight ?? ROOM.doorHeight;
  const yOffset = options.yOffset ?? 0;
  const floor = options.floor ?? 0;
  const gaps = gapCenters.map((g) => (typeof g === 'number' ? { center: g, width: doorW } : g)).sort((a, b) => a.center - b.center);
  let cursor = zStart;
  for (const gap of gaps) {
    const left = gap.center - gap.width / 2;
    const right = gap.center + gap.width / 2;
    if (left > cursor) addWallBox(thickness, wallHeight, left - cursor, x, yOffset + wallHeight / 2, (cursor + left) / 2, { floor });
    if (wallHeight > doorHeight) addWallBox(thickness, wallHeight - doorHeight, gap.width, x, yOffset + doorHeight + (wallHeight - doorHeight) / 2, gap.center, { collider: false, floor });
    cursor = right;
  }
  if (cursor < zEnd) addWallBox(thickness, wallHeight, zEnd - cursor, x, yOffset + wallHeight / 2, (cursor + zEnd) / 2, { floor });
}

function addWallZ(z, xStart, xEnd, gapCenters = [], options = {}) {
  const thickness = ROOM.wall;
  const doorW = ROOM.doorWidth;
  const wallHeight = options.height ?? ROOM.height;
  const doorHeight = options.doorHeight ?? ROOM.doorHeight;
  const yOffset = options.yOffset ?? 0;
  const floor = options.floor ?? 0;
  const gaps = gapCenters.map((g) => (typeof g === 'number' ? { center: g, width: doorW } : g)).sort((a, b) => a.center - b.center);
  let cursor = xStart;
  for (const gap of gaps) {
    const left = gap.center - gap.width / 2;
    const right = gap.center + gap.width / 2;
    if (left > cursor) addWallBox(left - cursor, wallHeight, thickness, (cursor + left) / 2, yOffset + wallHeight / 2, z, { floor });
    if (wallHeight > doorHeight) addWallBox(gap.width, wallHeight - doorHeight, thickness, gap.center, yOffset + doorHeight + (wallHeight - doorHeight) / 2, z, { collider: false, floor });
    cursor = right;
  }
  if (cursor < xEnd) addWallBox(xEnd - cursor, wallHeight, thickness, (cursor + xEnd) / 2, yOffset + wallHeight / 2, z, { floor });
}

function addDoorFrame(def) {
  const width = def.openingWidth ?? 1.18;
  const h = ROOM.doorHeight;
  const t = 0.12;
  const x = def.centerX, z = def.centerZ;
  const y = def.floor ? UPPER_FLOOR_Y : 0;
  if (def.axis === 'x') {
    // The wall lies on X; the jambs sit at either end of the opening along Z.
    addMeshBox(ROOM.wall + 0.05, h, t, x, y + h / 2, z - width / 2, materials.trim, { collider: false });
    addMeshBox(ROOM.wall + 0.05, h, t, x, y + h / 2, z + width / 2, materials.trim, { collider: false });
    addMeshBox(ROOM.wall + 0.05, t, width + t, x, y + h + t / 2, z, materials.trim, { collider: false });
  } else {
    // The wall lies on Z; the jambs sit at either end of the opening along X.
    addMeshBox(t, h, ROOM.wall + 0.05, x - width / 2, y + h / 2, z, materials.trim, { collider: false });
    addMeshBox(t, h, ROOM.wall + 0.05, x + width / 2, y + h / 2, z, materials.trim, { collider: false });
    addMeshBox(width + t, t, ROOM.wall + 0.05, x, y + h + t / 2, z, materials.trim, { collider: false });
  }
}

function buildFloorLayout(floor = 0) {
  const opts = { yOffset: floor ? UPPER_FLOOR_Y : 0, height: ROOM.height, doorHeight: ROOM.doorHeight, floor };
  const exteriorGaps = floor === 0 ? [{ center: 0, width: EXTERIOR_CORRIDOR_HALF * 2 }] : [];
  addWallX(ROOM.minX, ROOM.minZ, ROOM.maxZ, exteriorGaps, opts);
  addWallX(ROOM.maxX, ROOM.minZ, ROOM.maxZ, exteriorGaps, opts);
  addWallZ(ROOM.minZ, ROOM.minX, ROOM.maxX, floor === 0 ? [{ center: 0, width: EXTERIOR_CORRIDOR_HALF * 2 }] : [], opts);
  addWallZ(ROOM.maxZ, ROOM.minX, ROOM.maxX, floor === 0 ? [{ center: 0, width: 1.22 }] : [], opts);

  // Broad 3.5 m cross-corridors run the full length of the house; eight separate rooms open off them.
  const hallHalf = 2.0;
  const roomDoor = 1.3;
  for (const x of [-hallHalf, hallHalf]) {
    addWallX(x, ROOM.minZ, ROOM.maxZ, [
      { center: 0, width: hallHalf * 2 },
      { center: -7.9, width: roomDoor },
      { center: 7.9, width: roomDoor },
    ], opts);
  }
  for (const z of [-hallHalf, hallHalf]) {
    addWallZ(z, ROOM.minX, ROOM.maxX, [
      { center: 0, width: hallHalf * 2 },
      { center: -7.9, width: roomDoor },
      { center: 7.9, width: roomDoor },
    ], opts);
  }

  // Solid room dividers keep the long wings from reading as furniture-lined corridors.
  for (const z of [-6.3, 5.8]) {
    addWallZ(z, ROOM.minX, -hallHalf, [], opts);
    addWallZ(z, hallHalf, ROOM.maxX, [], opts);
  }
}

function addFlatRect(width, depth, x, z, y, material) {
  const plane = new THREE.Mesh(new THREE.PlaneGeometry(width, depth), material);
  plane.rotation.x = -Math.PI / 2;
  plane.position.set(x, y, z);
  scene.add(plane);
  return plane;
}

function buildExteriorCorridors() {
  const half = EXTERIOR_CORRIDOR_HALF;
  const branch = EXTERIOR_BRANCH_HALF;
  const end = EXTERIOR_BRANCH_END;
  const junction = EXTERIOR_JUNCTION;
  const outer = EXTERIOR_ARM_END;
  const floorOptions = { yOffset: 0, height: ROOM.height, doorHeight: ROOM.doorHeight, floor: 0 };
  materials.ceiling.side = THREE.DoubleSide;
  const addCorridorFloor = (width, depth, x, z) => {
    addFlatRect(width, depth, x, z, -0.045, materials.floor);
    addFlatRect(width, depth, x, z, ROOM.height - 0.035, materials.ceiling);
  };

  // Four covered arms pass through the old outer wall and continue well beyond the house.
  for (const side of [-1, 1]) {
    const zStart = side < 0 ? -outer : ROOM.maxZ;
    const zEnd = side < 0 ? ROOM.minZ : outer;
    const junctionZ = side * junction;
    addWallX(-half, zStart, zEnd, [{ center: junctionZ, width: branch * 2 }], floorOptions);
    addWallX(half, zStart, zEnd, [{ center: junctionZ, width: branch * 2 }], floorOptions);
    addWallZ(side * outer, -half, half, [], floorOptions);
    addCorridorFloor(half * 2, outer - ROOM.maxZ, 0, side * (ROOM.maxZ + (outer - ROOM.maxZ) / 2));

    // Each arm forks left and right into short, enclosed dead-end branches.
    for (const branchSide of [-1, 1]) {
      const xStart = branchSide < 0 ? -end : half;
      const xEnd = branchSide < 0 ? -half : end;
      for (const edgeZ of [junctionZ - branch, junctionZ + branch]) {
        addWallZ(edgeZ, xStart, xEnd, [], floorOptions);
      }
      // Leave the branch end open so the outer loop can join it.
      addWallX(branchSide * end, junctionZ - branch, junctionZ + branch, [{ center: junctionZ, width: branch * 2 }], floorOptions);
      const branchLength = end - half;
      addCorridorFloor(branchLength, branch * 2, branchSide * (half + branchLength / 2), junctionZ);
    }
  }

  for (const side of [-1, 1]) {
    const xStart = side < 0 ? -outer : ROOM.maxX;
    const xEnd = side < 0 ? ROOM.minX : outer;
    const junctionX = side * junction;
    addWallZ(-half, xStart, xEnd, [{ center: junctionX, width: branch * 2 }], floorOptions);
    addWallZ(half, xStart, xEnd, [{ center: junctionX, width: branch * 2 }], floorOptions);
    addWallX(side * outer, -half, half, [], floorOptions);
    addCorridorFloor(outer - ROOM.maxX, half * 2, side * (ROOM.maxX + (outer - ROOM.maxX) / 2), 0);

    // East and west arms also have north/south forks, creating visible T-junctions.
    for (const branchSide of [-1, 1]) {
      const zStart = branchSide < 0 ? -end : half;
      const zEnd = branchSide < 0 ? -half : end;
      for (const edgeX of [junctionX - branch, junctionX + branch]) {
        addWallX(edgeX, zStart, zEnd, [], floorOptions);
      }
      // Leave the branch end open so the outer loop can join it.
      addWallZ(branchSide * end, junctionX - branch, junctionX + branch, [{ center: junctionX, width: branch * 2 }], floorOptions);
      const branchLength = end - half;
      addCorridorFloor(branch * 2, branchLength, junctionX, branchSide * (half + branchLength / 2));
    }
  }

  // Four covered L-connectors join the old branch ends into a perimeter loop.
  // This adds real alternate routes instead of more dead-end corridors.
  const connectorStart = end;
  const connectorTurn = junction - branch;
  const connectorLength = connectorTurn - connectorStart;
  for (const xSide of [-1, 1]) {
    for (const zSide of [-1, 1]) {
      const northSouthZ = zSide * junction;
      const horizontalMinX = xSide * connectorStart < xSide * connectorTurn ? xSide * connectorStart : xSide * connectorTurn;
      const horizontalMaxX = xSide * connectorStart > xSide * connectorTurn ? xSide * connectorStart : xSide * connectorTurn;
      const horizontalCenterX = xSide * (connectorStart + connectorTurn) / 2;
      addWallZ(northSouthZ - branch, horizontalMinX, horizontalMaxX, [], floorOptions);
      addWallZ(northSouthZ + branch, horizontalMinX, horizontalMaxX, [], floorOptions);
      addCorridorFloor(connectorLength, branch * 2, horizontalCenterX, northSouthZ);

      const eastWestX = xSide * junction;
      const verticalMinZ = zSide * connectorStart < zSide * junction ? zSide * connectorStart : zSide * junction;
      const verticalMaxZ = zSide * connectorStart > zSide * junction ? zSide * connectorStart : zSide * junction;
      const verticalCenterZ = zSide * (connectorStart + junction) / 2;
      const verticalInnerX = eastWestX - xSide * branch;
      const verticalOuterX = eastWestX + xSide * branch;
      addWallX(verticalInnerX, verticalMinZ, verticalMaxZ, [{ center: northSouthZ, width: branch * 2 }], floorOptions);
      addWallX(verticalOuterX, verticalMinZ, verticalMaxZ, [], floorOptions);
      addCorridorFloor(branch * 2, junction - connectorStart, eastWestX, verticalCenterZ);
    }
  }

  // Trimmed, doorless portals make the external junctions read as connected branches at a glance.
  for (const x of [ROOM.minX, ROOM.maxX]) addDoorFrame({ axis: 'x', centerX: x, centerZ: 0, openingWidth: half * 2, floor: 0 });
  addDoorFrame({ axis: 'z', centerX: 0, centerZ: ROOM.minZ, openingWidth: half * 2, floor: 0 });
  for (const side of [-1, 1]) {
    const junction = side * EXTERIOR_JUNCTION;
    addDoorFrame({ axis: 'x', centerX: -half, centerZ: junction, openingWidth: branch * 2, floor: 0 });
    addDoorFrame({ axis: 'x', centerX: half, centerZ: junction, openingWidth: branch * 2, floor: 0 });
    addDoorFrame({ axis: 'z', centerX: junction, centerZ: -half, openingWidth: branch * 2, floor: 0 });
    addDoorFrame({ axis: 'z', centerX: junction, centerZ: half, openingWidth: branch * 2, floor: 0 });
  }
  for (const xSide of [-1, 1]) {
    for (const zSide of [-1, 1]) {
      addDoorFrame({ axis: 'x', centerX: xSide * end, centerZ: zSide * junction, openingWidth: branch * 2, floor: 0 });
      addDoorFrame({ axis: 'z', centerX: xSide * junction, centerZ: zSide * end, openingWidth: branch * 2, floor: 0 });
    }
  }

  const path = new THREE.Mesh(new THREE.PlaneGeometry(1.65, 7.6), new THREE.MeshStandardMaterial({ color: 0x60695a, roughness: 1 }));
  path.rotation.x = -Math.PI / 2;
  path.position.set(0, -0.02, 14);
  scene.add(path);
}

function buildHouse() {
  setMaterialTextures();
  const outside = new THREE.Mesh(new THREE.PlaneGeometry(120, 120), materials.ground);
  outside.rotation.x = -Math.PI / 2;
  outside.position.set(0, -0.13, 1.5);
  scene.add(outside);

  const lowerFloor = new THREE.Mesh(new THREE.PlaneGeometry(ROOM.maxX - ROOM.minX, ROOM.maxZ - ROOM.minZ), materials.floor);
  lowerFloor.rotation.x = -Math.PI / 2;
  lowerFloor.position.y = -0.045;
  scene.add(lowerFloor);

  buildFloorLayout(0);
  buildExteriorCorridors();
  buildUpperFloor();
  for (const def of getDoorDefinitions()) addDoorFrame(def);
  buildWallDecor();

  // Warm, soft pools of light rather than a maze of point lights.
  addCeilingLamp(-8, 2.86, 0, 0xffdca6, 1.05, 8.5, false, 0);
  addCeilingLamp(0, 2.86, 8, 0xffd7a0, 1.0, 8, false, 0);
  addCeilingLamp(-3.1, 2.86, -3.2, 0xffe0b5, 0.9, 6.5, false, 0);
  addCeilingLamp(3.2, 2.86, 3.2, 0xffddb0, 0.9, 6.5, false, 0);

}

function buildUpperFloor() {
  const hole = STAIR_HOLE;
  const edge = ROOM.maxX - 0.14;
  materials.upperFloor = materials.floor.clone();
  materials.upperFloor.side = THREE.DoubleSide;
  materials.ceiling.side = THREE.DoubleSide;
  const addFloorPanel = (x1, x2, z1, z2) => {
    if (x2 <= x1 || z2 <= z1) return;
    const panel = new THREE.Mesh(new THREE.PlaneGeometry(x2 - x1, z2 - z1), materials.upperFloor);
    panel.rotation.x = -Math.PI / 2;
    panel.position.set((x1 + x2) / 2, UPPER_FLOOR_Y, (z1 + z2) / 2);
    scene.add(panel);
  };

  // A measured stairwell sits wholly inside the northeast room; no floor or wall panel crosses the flight.
  addFloorPanel(-edge, hole.minX, ROOM.minZ + 0.14, ROOM.maxZ - 0.14);
  addFloorPanel(hole.maxX, edge, ROOM.minZ + 0.14, ROOM.maxZ - 0.14);
  addFloorPanel(hole.minX, hole.maxX, ROOM.minZ + 0.14, hole.minZ);
  addFloorPanel(hole.minX, hole.maxX, hole.maxZ, ROOM.maxZ - 0.14);

  // Close the lower rooms but preserve the same clear well through both floors.
  const addCeilingPanel = (x1, x2, z1, z2) => {
    if (x2 <= x1 || z2 <= z1) return;
    const panel = new THREE.Mesh(new THREE.PlaneGeometry(x2 - x1, z2 - z1), materials.ceiling);
    panel.rotation.x = -Math.PI / 2;
    panel.position.set((x1 + x2) / 2, UPPER_FLOOR_Y - 0.035, (z1 + z2) / 2);
    scene.add(panel);
  };
  addCeilingPanel(-edge, hole.minX, ROOM.minZ + 0.14, ROOM.maxZ - 0.14);
  addCeilingPanel(hole.maxX, edge, ROOM.minZ + 0.14, ROOM.maxZ - 0.14);
  addCeilingPanel(hole.minX, hole.maxX, ROOM.minZ + 0.14, hole.minZ);
  addCeilingPanel(hole.minX, hole.maxX, hole.maxZ, ROOM.maxZ - 0.14);

  buildFloorLayout(1);

  // Twelve open-riser treads now rise east, matching the rotated stairwell opening.
  const count = 12, treadDepth = 0.23, riser = UPPER_FLOOR_Y / count;
  const bottomX = STAIR_BOTTOM.x, stairZ = STAIR_BOTTOM.z;
  for (let i = 0; i < count; i++) {
    const topY = (i + 1) * riser;
    const stepX = bottomX + (i + 0.5) * treadDepth;
    const tread = addMeshBox(treadDepth, 0.08, 1.16, stepX, topY - 0.04, stairZ, materials.wood, { collider: false });
    tread.name = `stair-tread-${i + 1}`;
    const riserX = bottomX + i * treadDepth + 0.035;
    addMeshBox(0.07, riser, 1.16, riserX, topY - riser / 2, stairZ, materials.trim, { collider: false });
  }
  // A compact landing at the east end joins the top step to the upstairs floor.
  addMeshBox(0.6, 0.12, 1.5, STAIR_TOP.x, UPPER_FLOOR_Y - 0.04, STAIR_TOP.z, materials.wood, { collider: false });
  const railStartX = bottomX - 0.1;
  const railEndX = STAIR_TOP.x + 0.25;
  for (const railZ of [stairZ - 0.67, stairZ + 0.67]) {
    const start = new THREE.Vector3(railStartX, 0.24, railZ);
    const end = new THREE.Vector3(railEndX, UPPER_FLOOR_Y + 0.48, railZ);
    const direction = end.clone().sub(start);
    const rail = new THREE.Mesh(new THREE.BoxGeometry(0.065, direction.length(), 0.065), materials.trim);
    rail.position.copy(start).add(end).multiplyScalar(0.5);
    rail.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.normalize());
    scene.add(rail);
    for (let i = 0; i <= 6; i++) {
      const t = i / 6;
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.58, 0.05), materials.trim);
      post.position.set(railStartX + t * (railEndX - railStartX), 0.34 + t * UPPER_FLOOR_Y, railZ);
      scene.add(post);
    }
  }

  const roof = new THREE.Mesh(new THREE.PlaneGeometry(ROOM.maxX - ROOM.minX, ROOM.maxZ - ROOM.minZ), materials.ceiling);
  roof.rotation.x = -Math.PI / 2;
  roof.position.y = UPPER_FLOOR_Y + ROOM.height;
  scene.add(roof);
  addCeilingLamp(-8, UPPER_FLOOR_Y + 2.86, 0, 0xffddb0, 0.95, 8.5, false, 1);
  addCeilingLamp(0, UPPER_FLOOR_Y + 2.86, -8, 0xffddb0, 0.95, 8.5, false, 1);
}

function addCeilingLamp(x, y, z, color, intensity, distance, flicker, floor = 0) {
  const fixture = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.16, 0.1, 8), materials.metal);
  fixture.position.set(x, y + 0.02, z);
  fixture.castShadow = false;
  scene.add(fixture);
  const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.065, 8, 6), materials.bulb);
  bulb.position.set(x, y - 0.07, z);
  scene.add(bulb);
  const lightsOnFloor = houseLights.filter((light) => light.userData.floor === floor).length;
  if (lightsOnFloor < (mobileDevice ? 2 : 3)) {
    const light = new THREE.PointLight(color, intensity, distance, 2);
    light.position.set(x, y - 0.12, z);
    light.userData.baseIntensity = intensity;
    light.userData.flicker = false;
    light.userData.floor = floor;
    light.castShadow = false;
    scene.add(light);
    houseLights.push(light);
  }
}

function buildWallDecor() {
  wallPaintings = [];
  const palettes = [
    { frame: 0x493522, bg: 0x4f4542, a: 0xc6a77a, b: 0x252a28, type: 'portrait' },
    { frame: 0x6c5538, bg: 0x52636a, a: 0xe2c785, b: 0x34483c, type: 'landscape' },
    { frame: 0x352a24, bg: 0x75554a, a: 0xc9815f, b: 0x4d3330, type: 'abstract' },
    { frame: 0x57442d, bg: 0x918064, a: 0x6b4b37, b: 0xc2a367, type: 'still-life' },
    { frame: 0x382c2b, bg: 0x53604d, a: 0xc5c0a4, b: 0x303b35, type: 'portrait' },
    { frame: 0x725c3a, bg: 0x58666d, a: 0xd68a68, b: 0x394443, type: 'landscape' },
    { frame: 0x493326, bg: 0x806a54, a: 0x47543e, b: 0xb0a179, type: 'still-life' },
    { frame: 0x4d3a36, bg: 0x5e484f, a: 0xc39b73, b: 0x342d36, type: 'abstract' },
  ];
  const addShape = (group, geometry, color, x, y, z, scaleX = 1, scaleY = 1) => {
    const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color, roughness: 0.92, side: THREE.DoubleSide }));
    mesh.position.set(x, y, z);
    mesh.scale.set(scaleX, scaleY, 1);
    mesh.userData.wallPaintingArt = true;
    group.add(mesh);
    return mesh;
  };
  const addPainting = (x, y, z, rotationY, variant) => {
    const preset = palettes[variant % palettes.length];
    const group = new THREE.Group();
    group.position.set(x, y, z);
    group.rotation.y = rotationY;
    group.userData.wallPainting = true;
    group.userData.paintingType = preset.type;
    const frameMat = new THREE.MeshStandardMaterial({ color: preset.frame, roughness: 0.78 });
    const canvasMat = new THREE.MeshStandardMaterial({ color: preset.bg, roughness: 1, side: THREE.DoubleSide });
    const frame = new THREE.Mesh(new THREE.BoxGeometry(0.76, 0.96, 0.08), frameMat);
    const canvas = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.82, 0.018), canvasMat);
    canvas.position.z = 0.052;
    group.add(frame, canvas);

    if (preset.type === 'portrait') {
      addShape(group, new THREE.ConeGeometry(0.22, 0.36, 5), preset.b, 0, -0.22, 0.078, 1.35, 1);
      addShape(group, new THREE.SphereGeometry(0.13, 8, 6), preset.a, 0, 0.11, 0.09, 0.86, 1.05);
      addShape(group, new THREE.SphereGeometry(0.15, 8, 6), preset.b, 0, 0.2, 0.074, 0.95, 0.55);
    } else if (preset.type === 'landscape') {
      addShape(group, new THREE.CircleGeometry(0.095, 8), preset.a, 0.16, 0.18, 0.077);
      addShape(group, new THREE.CircleGeometry(0.25, 3), preset.b, -0.12, -0.19, 0.08, 1.2, 0.82);
      addShape(group, new THREE.CircleGeometry(0.2, 3), preset.a, 0.18, -0.22, 0.084, 1.15, 0.9);
    } else if (preset.type === 'still-life') {
      addShape(group, new THREE.ConeGeometry(0.15, 0.34, 6), preset.b, 0, -0.19, 0.08, 1.1, 1);
      addShape(group, new THREE.CircleGeometry(0.11, 8), preset.a, -0.13, 0.08, 0.09, 0.9, 1.05);
      addShape(group, new THREE.CircleGeometry(0.105, 8), preset.b, 0.13, 0.12, 0.092, 0.9, 0.95);
    } else {
      addShape(group, new THREE.BoxGeometry(0.16, 0.54, 0.012), preset.a, -0.17, 0, 0.082, 1, 1);
      addShape(group, new THREE.BoxGeometry(0.15, 0.36, 0.012), preset.b, 0.04, -0.08, 0.087, 1, 1);
      addShape(group, new THREE.CircleGeometry(0.105, 7), preset.a, 0.18, 0.19, 0.09);
    }
    group.updateWorldMatrix(true, true);
    const bounds = new THREE.Box3().setFromObject(group);
    const overlaps = wallPaintings.some((existing) => {
      existing.updateWorldMatrix(true, true);
      return bounds.intersectsBox(new THREE.Box3().setFromObject(existing));
    });
    if (overlaps) {
      console.warn('Картина не добавлена: место пересекается с другой картиной.', { x, y, z, rotationY });
      return null;
    }
    scene.add(group);
    wallPaintings.push(group);
    return group;
  };

  const floorHeights = [1.98, UPPER_FLOOR_Y + 1.98];
  for (let floor = 0; floor < floorHeights.length; floor++) {
    const y = floorHeights[floor];
    const placements = [
      [-1.64, -4.75, -Math.PI / 2], [-1.36, 4.75, Math.PI / 2],
      [1.64, -4.75, Math.PI / 2], [1.36, 4.75, -Math.PI / 2],
    ];
    for (const [x, z, rotation] of placements) addPainting(x, y, z, rotation, floor * 4 + wallPaintings.length % 8);

    const horizontal = [
      [-4.75, -1.64, Math.PI], [-4.75, -1.36, 0], [4.75, 1.64, 0], [4.75, 1.36, Math.PI],
    ];
    for (const [x, z, rotation] of horizontal) addPainting(x, y, z, rotation, floor * 5 + wallPaintings.length % 8);

    // Exit-hall art plus side-wall canvases make the paintings visible along the main approach routes.
    addPainting(-3.8, y, 9.84, Math.PI, floor * 6 + 1);
    addPainting(3.8, y, 9.84, Math.PI, floor * 7 + 3);
    addPainting(-9.84, y, 4.2, Math.PI / 2, floor * 3 + 2);
    addPainting(9.84, y, -4.2, -Math.PI / 2, floor * 5 + 6);
  }
}

function createPlayerAvatar(uid, color = PLAYER_COLORS[0], withEyes = true) {
  const root = new THREE.Group();
  root.name = `online-player-${uid}`;
  const bodyMaterial = new THREE.MeshStandardMaterial({ color, roughness: 0.78, metalness: 0.02 });
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.31, 1.08, 5, 10), bodyMaterial);
  body.position.y = 0.85;
  body.castShadow = false;
  root.add(body);
  // У местного игрока (у того, у кого активна камера) глаз нет — они были видны
  // только для других; у чужих аватаров глаза остаются.
  if (withEyes) {
    const eyeGroup = new THREE.Group();
    eyeGroup.position.y = 1.52;
    const white = new THREE.MeshStandardMaterial({ color: 0xf7f5ea, roughness: 0.35 });
    const pupilMaterial = new THREE.MeshStandardMaterial({ color: 0x171a17, roughness: 0.32 });
    for (const x of [-0.115, 0.115]) {
      const eye = new THREE.Mesh(new THREE.SphereGeometry(0.075, 10, 8), white);
      eye.position.set(x, 0, -0.285);
      eyeGroup.add(eye);
      const pupil = new THREE.Mesh(new THREE.SphereGeometry(0.033, 8, 6), pupilMaterial);
      pupil.position.set(x, -0.005, -0.35);
      eyeGroup.add(pupil);
    }
    const eyeShineMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff });
    for (const x of [-0.125, 0.105]) {
      const shine = new THREE.Mesh(new THREE.SphereGeometry(0.012, 6, 4), eyeShineMaterial);
      shine.position.set(x, 0.025, -0.377);
      eyeGroup.add(shine);
    }
    root.add(eyeGroup);
    root.userData.eyeGroup = eyeGroup;
  }
  root.userData.playerId = uid;
  root.userData.target = { x: 0, z: 0, y: 0, yaw: 0, pitch: 0 };
  scene.add(root);
  return root;
}

let onlineStatusTimer = 0;

function showOnlineError(message) {
  if (!dom.onlineStatus) return;
  dom.onlineStatus.textContent = `ОНЛАЙН НЕДОСТУПЕН — ${message}`;
  dom.onlineStatus.classList.add('error');
  dom.onlineStatus.classList.remove('hidden');
  clearTimeout(onlineStatusTimer);
  onlineStatusTimer = setTimeout(() => {
    dom.onlineStatus.classList.add('hidden');
    dom.onlineStatus.classList.remove('error');
  }, 15000);
}

function receiveOnlineError(message) {
  console.error('Онлайн:', message);
  showOnlineError(message);
}

function receiveOnlinePlayers(players) {
  if (!game.online) return;
  const active = new Set();
  for (const [uid, data] of Object.entries(players || {})) {
    if (uid === game.online.uid || !data || typeof data !== 'object') continue;
    active.add(uid);
    let remote = game.remotePlayers.get(uid);
    if (!remote) {
      const colorIndex = PLAYER_COLORS.findIndex((value) => value === Number.parseInt(String(data.color || '').replace('#', '0x')));
      const color = /^#[0-9a-f]{6}$/i.test(data.color || '') ? Number.parseInt(data.color.slice(1), 16) : PLAYER_COLORS[colorIndex >= 0 ? colorIndex : game.remotePlayers.size % PLAYER_COLORS.length];
      const root = createPlayerAvatar(uid, color);
      remote = { root, target: root.userData.target };
      game.remotePlayers.set(uid, remote);
    }
    remote.target.x = Number.isFinite(data.x) ? data.x : remote.target.x;
    remote.target.z = Number.isFinite(data.z) ? data.z : remote.target.z;
    remote.target.y = Number.isFinite(data.floorY) ? data.floorY : (data.floor ? UPPER_FLOOR_Y : 0);
    remote.target.yaw = Number.isFinite(data.yaw) ? data.yaw : remote.target.yaw;
    remote.target.pitch = Number.isFinite(data.pitch) ? data.pitch : remote.target.pitch;
    remote.target.floor = data.floor === 1 ? 1 : 0;
    remote.target.crouched = Boolean(data.crouched);
    remote.target.alive = data.alive !== false;
  }
  for (const [uid, remote] of game.remotePlayers) {
    if (!active.has(uid)) { scene.remove(remote.root); game.remotePlayers.delete(uid); }
  }
  if (dom.onlineStatus && game.online) {
    clearTimeout(onlineStatusTimer);
    // Считаем только живых (не пойманных) игроков.
    const alive = [...game.remotePlayers.values()].filter((remote) => remote.target.alive !== false).length + (game.observer ? 0 : 1);
    dom.onlineStatus.textContent = `ОНЛАЙН · ${Math.min(4, alive)}/4`;
    dom.onlineStatus.classList.remove('hidden', 'error');
  }
}

function receiveOnlineWorld(world) {
  game.pendingRemoteWorld = world;
  if (game.online && world) applySharedWorld(world);
}

function receiveOnlineHost(hostId) {
  if (!hostId) return;
  if (!game.online) { game.pendingHostId = hostId; return; }
  const wasHost = game.online.hostId === game.online.uid;
  game.online.hostId = hostId;
  if (!wasHost && hostId === game.online.uid && game.started) publishWorldSnapshot();
}

function applySharedWorld(world) {
  if (!world || !game.online) return;
  if (world.doors) {
    for (const door of doors) {
      const state = world.doors[door.id];
      if (!state) continue;
      if (typeof state.isOpen === 'boolean') door.isOpen = state.isOpen;
      if (typeof state.locked === 'boolean') door.locked = state.locked;
    }
  }
  if (world.containers) {
    for (const container of searchContainers) {
      const state = world.containers[container.id];
      if (!state) continue;
      if (typeof state.searched === 'boolean') container.searched = state.searched;
      if (state.rewardId === 'key' || state.rewardId === null) container.rewardId = state.rewardId;
    }
  }
  if (world.keyFound && !game.inventory.has('key')) {
    game.inventory.add('key');
    const key = items.find((item) => item.id === 'key');
    if (key) key.collected = true;
    const exit = doors.find((door) => door.exit);
    if (exit) exit.locked = false;
    advanceObjective('ОТКРОЙ ВЫХОД');
  }
  if (Object.prototype.hasOwnProperty.call(world, 'traps')) synchronizeTraps(world.traps || []);
  if (world.granny) game.remoteGrannyState = world.granny;
}

function publishWorldSnapshot() {
  if (!game.online?.publishWorld) return;
  const world = {
    doors: Object.fromEntries(doors.map((door) => [door.id, { isOpen: door.isOpen, locked: door.locked }])),
    containers: Object.fromEntries(searchContainers.map((container) => [container.id, { searched: container.searched, rewardId: container.rewardId }])),
    keyFound: game.inventory.has('key'),
    traps: serializeTraps(),
    granny: granny ? { x: granny.root.position.x, z: granny.root.position.z, floor: granny.floor, yaw: granny.root.rotation.y, state: game.ai.state } : null,
  };
  game.online.publishWorld(world).catch((error) => console.debug('Firebase world snapshot:', error));
}

function syncDoorState(door) {
  if (!game.online?.publishWorld || !door) return;
  game.online.publishWorld({ [`doors/${door.id}`]: { isOpen: door.isOpen, locked: door.locked } })
    .catch((error) => console.debug('Firebase door update:', error));
}

function syncContainerState(container) {
  if (!game.online?.publishWorld || !container) return;
  game.online.publishWorld({ [`containers/${container.id}`]: { searched: container.searched, rewardId: container.rewardId } })
    .catch((error) => console.debug('Firebase container update:', error));
}

function updateRemoteGranny(dt) {
  if (!granny) return;
  const target = game.remoteGrannyState;
  if (!target) { granny.mixer?.update(dt); return; }
  granny.root.position.x = THREE.MathUtils.damp(granny.root.position.x, target.x, 7, dt);
  granny.root.position.z = THREE.MathUtils.damp(granny.root.position.z, target.z, 7, dt);
  granny.root.position.y = THREE.MathUtils.damp(granny.root.position.y, target.floor ? UPPER_FLOOR_Y : 0, 7, dt);
  granny.root.rotation.y = dampAngle(granny.root.rotation.y, target.yaw || 0, 6, dt);
  granny.floor = target.floor || 0;
  game.ai.floor = granny.floor;
  game.ai.state = target.state || 'patrol';
  if (granny.walkAction) {
    granny.walkAction.setEffectiveTimeScale(game.ai.state === 'chase' ? 1.05 : 0.72);
    if (game.ai.state === 'attack' && granny.attackAction && !game.ai.attackPlayed) {
      granny.walkAction.fadeOut(0.12);
      granny.attackAction.reset().fadeIn(0.12).play();
      game.ai.attackPlayed = true;
    } else if (!granny.walkAction.isRunning()) granny.walkAction.play();
  }
  granny.mixer?.update(dt);
  const near = game.player.floor === granny.floor && Math.hypot(game.player.x - granny.root.position.x, game.player.z - granny.root.position.z) < 1.7;
  if (target.state === 'attack' && near && !game.deathSequence && !game.finished && !game.observer) beginJumpscare();
}

function updateRemotePlayers(dt) {
  for (const remote of game.remotePlayers.values()) {
    const root = remote.root, target = remote.target;
    root.position.x = THREE.MathUtils.damp(root.position.x, target.x, 9, dt);
    root.position.z = THREE.MathUtils.damp(root.position.z, target.z, 9, dt);
    root.position.y = THREE.MathUtils.damp(root.position.y, target.y, 8, dt);
    root.rotation.y = dampAngle(root.rotation.y, target.yaw, 8, dt);
    if (root.userData.eyeGroup) root.userData.eyeGroup.rotation.x = THREE.MathUtils.damp(root.userData.eyeGroup.rotation.x, target.pitch, 8, dt);
  }
  const local = game.localAvatar;
  // У пойманного игрока авата́р остаётся стоять на месте, как тело; движение прекращено.
  if (local && !game.observer) {
    local.position.set(game.player.x, game.player.floorY, game.player.z);
    local.rotation.y = game.cameraYaw;
    if (local.userData.eyeGroup) local.userData.eyeGroup.rotation.x = game.cameraPitch;
  }
}

function publishOnlinePlayer(dt) {
  if (!game.online?.publish || !game.started) return;
  game.onlineSyncTimer -= dt;
  // Пойманный игрок больше не слает свою позицию (только раз «пойман» при входе в наблюдение),
  // но хост продолжает публиковать бабку — иначе симуляция остановится для всех.
  if (game.observer) {
    if (game.online.hostId === game.online.uid && granny && game.online.publishWorld) {
      game.online.publishWorld({ granny: { x: granny.root.position.x, z: granny.root.position.z, floor: granny.floor, yaw: granny.root.rotation.y, state: game.ai.state } })
        .catch((error) => console.debug('Firebase Granny update:', error));
    }
    return;
  }
  if (game.onlineSyncTimer > 0) return;
  game.onlineSyncTimer = 0.1;
  game.online.publish({
    x: game.player.x, z: game.player.z, floor: game.player.floor,
    floorY: game.player.floorY, yaw: game.cameraYaw, pitch: game.cameraPitch,
    crouched: game.player.crouched, color: game.online.profile.color, displayName: game.online.profile.displayName,
    alive: true,
  }).catch((error) => console.debug('Firebase presence update:', error));
  if (game.online.hostId === game.online.uid && granny && game.online.publishWorld) {
    game.online.publishWorld({ granny: { x: granny.root.position.x, z: granny.root.position.z, floor: granny.floor, yaw: granny.root.rotation.y, state: game.ai.state } })
      .catch((error) => console.debug('Firebase Granny update:', error));
  }
}

function buildDust() {
  const count = mobileDevice ? 24 : 48;
  const positions = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    positions[i * 3] = THREE.MathUtils.randFloat(-10.5, 10.5);
    positions[i * 3 + 1] = THREE.MathUtils.randFloat(0.4, 2.9);
    positions[i * 3 + 2] = THREE.MathUtils.randFloat(-10.5, 10.5);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const material = new THREE.PointsMaterial({ color: 0xb9b29d, size: 0.018, transparent: true, opacity: 0.27, depthWrite: false, sizeAttenuation: true });
  const dust = new THREE.Points(geometry, material);
  dust.name = 'dust-in-the-air';
  scene.add(dust);
  game.dust = dust;
}

function getDoorDefinitions() {
  const hallHalf = 2.0;
  const width = 1.3;
  const oneFloor = [
    ...[-1, 1].flatMap((side) => [-7.9, 7.9].map((z, index) => ({
      id: `${side < 0 ? 'west' : 'east'}-room-${index + 1}`,
      axis: 'x', centerX: side * hallHalf, centerZ: z,
      hingeX: side * hallHalf, hingeZ: z + (side < 0 ? width : -width) / 2,
      baseYaw: side < 0 ? Math.PI / 2 : -Math.PI / 2, openAngle: -Math.PI / 2,
      openingWidth: width, leafWidth: 1.16,
    }))),
    ...[-1, 1].flatMap((side) => [-7.9, 7.9].map((x, index) => ({
      id: `${side < 0 ? 'north' : 'south'}-room-${index + 1}`,
      axis: 'z', centerX: x, centerZ: side * hallHalf,
      hingeX: x - width / 2, hingeZ: side * hallHalf,
      baseYaw: 0, openAngle: side < 0 ? -Math.PI / 2 : Math.PI / 2,
      openingWidth: width, leafWidth: 1.16,
    }))),
  ];
  const floors = [0, 1].flatMap((floor) => oneFloor.map((def) => ({
    ...def, id: `${def.id}-${floor + 1}`, floor, initialOpen: false,
  })));
  floors.push({ id: 'front-exit', label: 'ВЫХОД', axis: 'z', centerX: 0, centerZ: 10, hingeX: -0.56, hingeZ: 10, baseYaw: 0, openAngle: -Math.PI / 2, openingWidth: 1.22, leafWidth: 1.12, floor: 0, locked: true, exit: true, initialOpen: false });
  return floors;
}

function createProceduralDoorLeaf(width = 0.92) {
  const group = new THREE.Group();
  const height = ROOM.doorHeight - 0.06;
  const panel = new THREE.Mesh(new THREE.BoxGeometry(width, height, 0.075), materials.door);
  panel.position.set(width / 2, height / 2, 0);
  group.add(panel);
  const handle = new THREE.Mesh(new THREE.SphereGeometry(0.035, 6, 5), materials.handle);
  handle.position.set(width - 0.1, 1.02, 0.07);
  group.add(handle);
  return group;
}

function createDoors() {
  const templates = new Map();
  for (const def of getDoorDefinitions()) {
    const pivot = new THREE.Group();
    const floorY = def.floor ? UPPER_FLOOR_Y : 0;
    pivot.position.set(def.hingeX, floorY, def.hingeZ);
    scene.add(pivot);
    if (!templates.has(def.leafWidth)) templates.set(def.leafWidth, createProceduralDoorLeaf(def.leafWidth));
    const leaf = templates.get(def.leafWidth).clone(true);
    pivot.add(leaf);
    const door = {
      ...def, pivot, leaf, angle: def.initialOpen ? def.openAngle : 0, isOpen: !!def.initialOpen,
      locked: !!def.locked, center: new THREE.Vector3(def.centerX, floorY + ROOM.doorHeight / 2, def.centerZ), audioAnchor: null,
    };
    pivot.rotation.y = def.baseYaw + door.angle;
    doors.push(door);
  }
}

function normalizeProp(root) {
  root.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(root);
  root.position.x -= (box.min.x + box.max.x) / 2;
  root.position.z -= (box.min.z + box.max.z) / 2;
  root.position.y -= box.min.y;
  root.traverse((object) => {
    if (!object.isMesh) return;
    object.castShadow = false;
    object.receiveShadow = false;
    const soften = (material) => {
      const m = material.clone();
      if (m.color) m.color.multiplyScalar(0.96);
      if (m.roughness !== undefined) m.roughness = Math.max(m.roughness, 0.72);
      return m;
    };
    object.material = Array.isArray(object.material) ? object.material.map(soften) : soften(object.material);
  });
  return root;
}

async function loadProps() {
  const results = await Promise.all(PROP_NAMES.map(async (name) => {
    try {
      const gltf = await gltfLoader.loadAsync(`./assets/models/props/${name}.glb`);
      props.set(name, normalizeProp(gltf.scene));
      return true;
    } catch (error) {
      console.warn(`Проп ${name} не загрузился:`, error);
      return false;
    }
  }));
  propsReady = results.some(Boolean);
}

async function loadTrapModels() {
  const entries = [
    ['closed', ASSET.trapClosed],
    ['open', ASSET.trapOpen],
  ];
  await Promise.all(entries.map(async ([pose, url]) => {
    try {
      const gltf = await gltfLoader.loadAsync(url);
      trapModels.set(pose, normalizeProp(gltf.scene));
    } catch (error) {
      console.warn(`Капкан (${pose}) не загрузился:`, error);
    }
  }));
}

function placeProp(name, x, y, z, yaw = 0, scale = 2, collide = false, floor = 0) {
  const base = props.get(name);
  if (!base) return null;
  const wrap = new THREE.Group();
  const model = base.clone(true);
  wrap.add(model);
  wrap.position.set(x, y, z);
  wrap.rotation.y = yaw;
  wrap.scale.setScalar(scale);
  wrap.traverse((object) => { if (object.isMesh) { object.castShadow = false; object.receiveShadow = false; } });
  scene.add(wrap);
  wrap.updateMatrixWorld(true);
  if (collide) {
    const box = new THREE.Box3().setFromObject(wrap);
    worldColliders.push({ minX: box.min.x, maxX: box.max.x, minZ: box.min.z, maxZ: box.max.z, type: 'furniture', floor, mesh: wrap });
  }
  return wrap;
}

const BEAR_TRAP_SCALE = 0.18;

function updateTrapVisual(trap) {
  if (!trap?.root) return;
  trap.root.clear();
  const model = trapModels.get(trap.armed ? 'open' : 'closed');
  if (!model) return;
  const visual = model.clone(true);
  visual.scale.setScalar(BEAR_TRAP_SCALE);
  visual.traverse((object) => { if (object.isMesh) { object.castShadow = false; object.receiveShadow = false; } });
  trap.root.add(visual);
  trap.visual = visual;
}

function createTrap(state) {
  if (!state || !Number.isFinite(state.x) || !Number.isFinite(state.z)) return null;
  const trap = {
    id: String(state.id || `trap-${Date.now().toString(36)}`),
    x: state.x, z: state.z, floor: state.floor === 1 ? 1 : 0,
    yaw: Number.isFinite(state.yaw) ? state.yaw : 0,
    armed: state.armed !== false,
    expireTimer: state.armed === false ? 3.5 : 0,
    root: new THREE.Group(), visual: null,
  };
  trap.root.name = `bear-trap-${trap.id}`;
  trap.root.position.set(trap.x, trap.floor ? UPPER_FLOOR_Y : 0, trap.z);
  trap.root.rotation.y = trap.yaw;
  trap.root.userData.trapId = trap.id;
  scene.add(trap.root);
  updateTrapVisual(trap);
  return trap;
}

function serializeTraps() {
  return game.traps.map(({ id, x, z, floor, yaw, armed }) => ({ id, x, z, floor, yaw, armed }));
}

function publishTrapSnapshot() {
  if (!game.online?.publishWorld) return;
  game.online.publishWorld({ traps: serializeTraps() }).catch((error) => console.debug('Firebase trap update:', error));
}

function synchronizeTraps(snapshot) {
  const entries = Array.isArray(snapshot) ? snapshot : Object.values(snapshot || {});
  const previous = new Map(game.traps.map((trap) => [trap.id, trap]));
  const next = [];
  for (const state of entries) {
    if (!state || typeof state !== 'object' || !state.id || !Number.isFinite(state.x) || !Number.isFinite(state.z)) continue;
    const id = String(state.id);
    const trap = previous.get(id) || createTrap(state);
    if (!trap) continue;
    previous.delete(id);
    trap.x = state.x; trap.z = state.z; trap.floor = state.floor === 1 ? 1 : 0;
    trap.yaw = Number.isFinite(state.yaw) ? state.yaw : trap.yaw;
    const armed = state.armed !== false;
    if (trap.armed !== armed) {
      trap.armed = armed;
      trap.expireTimer = armed ? 0 : 3.5;
      updateTrapVisual(trap);
    }
    trap.root.position.set(trap.x, trap.floor ? UPPER_FLOOR_Y : 0, trap.z);
    trap.root.rotation.y = trap.yaw;
    next.push(trap);
  }
  for (const trap of previous.values()) { scene.remove(trap.root); }
  game.traps = next;
}

function placeGrannyTrap() {
  if (!granny || !trapModels.has('open') || game.traps.filter((trap) => trap.armed).length >= 3) return false;
  const yaw = granny.root.rotation.y;
  const forwardX = Math.sin(yaw), forwardZ = Math.cos(yaw);
  const candidates = [
    { x: granny.root.position.x - forwardX * 0.95, z: granny.root.position.z - forwardZ * 0.95 },
    { x: granny.root.position.x + forwardX * 0.9, z: granny.root.position.z + forwardZ * 0.9 },
    { x: granny.root.position.x + 0.8, z: granny.root.position.z },
    { x: granny.root.position.x - 0.8, z: granny.root.position.z },
  ];
  const floor = game.ai.floor;
  const candidate = candidates.find((point) => {
    if (collidesAt(point.x, point.z, 0.36, true, floor)) return false;
    if (game.traps.some((trap) => trap.floor === floor && Math.hypot(trap.x - point.x, trap.z - point.z) < 1.05)) return false;
    if (game.player.floor === floor && Math.hypot(game.player.x - point.x, game.player.z - point.z) < 1.65) return false;
    return true;
  });
  if (!candidate) return false;
  const trap = createTrap({
    id: `trap-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    ...candidate, floor, yaw,
  });
  if (!trap) return false;
  game.traps.push(trap);
  publishTrapSnapshot();
  return true;
}

function updateTraps(dt) {
  for (let index = game.traps.length - 1; index >= 0; index--) {
    const trap = game.traps[index];
    if (!trap.armed) {
      trap.expireTimer -= dt;
      if (trap.expireTimer <= 0) {
        scene.remove(trap.root);
        game.traps.splice(index, 1);
        publishTrapSnapshot();
      }
      continue;
    }
    const player = game.player;
    if (player.floor !== trap.floor || Math.hypot(player.x - trap.x, player.z - trap.z) > 0.46) continue;
    trap.armed = false;
    trap.expireTimer = 3.5;
    updateTrapVisual(trap);
    player.trappedTimer = 2.25;
    player.vx = 0; player.vz = 0;
    player.stamina = Math.max(0, player.stamina - 14);
    game.trapNoticeTimer = 1.65;
    dom.trapNotice?.classList.remove('hidden');
    dom.damageFlash.classList.add('on');
    damageTimer = 0.28;
    emitNoise(3.1, 1.8, player.x, player.z, player.floor);
    publishTrapSnapshot();
  }
}

function furnishHouse() {
  searchContainers = [];

  // Ground floor: each piece stays inside a room, well clear of the cross-corridors and door swings.
  placeProp('bedDouble', -7.9, 0, -8.05, 0, 2.1, true, 0);
  addSearchContainer('sideTable', -4.2, 0, -8.2, 0, 2.15, 'ОБЫСКАТЬ ТУМБОЧКУ', 0);
  placeProp('loungeSofa', -7.9, 0, -4.75, Math.PI / 2, 2.0, true, 0);
  placeProp('loungeSofa', 7.9, 0, -8.15, -Math.PI / 2, 2.0, true, 0);
  placeProp('kitchenFridge', -8.4, 0, 9.0, 0, 1.85, true, 0);
  placeProp('kitchenSink', -5.4, 0, 9.0, 0, 1.9, true, 0);
  addSearchContainer('kitchenCabinet', -3.0, 0, 9.0, 0, 1.85, 'ОБЫСКАТЬ КУХОННЫЙ ШКАФ', 0);
  placeProp('bathroomSink', 7.8, 0, 3.8, Math.PI, 1.85, true, 0);
  addSearchContainer('cabinetBedDrawer', 7.8, 0, 8.05, Math.PI, 1.9, 'ОБЫСКАТЬ ЯЩИКИ', 0);

  // Upstairs receives a complete, lighter set too; the stair landing itself is kept empty.
  placeProp('bedDouble', -7.9, UPPER_FLOOR_Y, -8.05, 0, 1.95, true, 1);
  addSearchContainer('sideTable', -4.2, UPPER_FLOOR_Y, -8.2, 0, 2.0, 'ОБЫСКАТЬ ТУМБОЧКУ · 2 ЭТАЖ', 1);
  placeProp('loungeSofa', -7.8, UPPER_FLOOR_Y, -4.75, Math.PI / 2, 1.9, true, 1);
  addSearchContainer('cabinetBedDrawer', 7.8, UPPER_FLOOR_Y, -8.05, Math.PI, 1.9, 'ОБЫСКАТЬ КОМОД · 2 ЭТАЖ', 1);
  placeProp('kitchenFridge', -8.35, UPPER_FLOOR_Y, 9.0, 0, 1.75, true, 1);
  placeProp('kitchenSink', -5.45, UPPER_FLOOR_Y, 9.0, 0, 1.8, true, 1);
  addSearchContainer('kitchenCabinet', -3.0, UPPER_FLOOR_Y, 9.0, 0, 1.8, 'ОБЫСКАТЬ ШКАФ · 2 ЭТАЖ', 1);
  placeProp('bathroomSink', 7.9, UPPER_FLOOR_Y, 3.8, Math.PI, 1.8, true, 1);
  addSearchContainer('sideTable', 7.9, UPPER_FLOOR_Y, 8.0, Math.PI, 1.9, 'ОБЫСКАТЬ ЯЩИК · 2 ЭТАЖ', 1);

  assignSearchLoot();
  buildNavigationGrid();
}

function createItems() {
  items = [{ id: 'key', title: 'КЛЮЧ ОТ ВЫХОДА', label: 'КЛЮЧ', collected: false }];
}

function addSearchContainer(name, x, y, z, yaw, scale, label, floor = 0) {
  let root = placeProp(name, x, y, z, yaw, scale, true, floor);
  if (!root) {
    root = new THREE.Group();
    const width = 0.8, height = 0.72, depth = 0.48;
    const body = new THREE.Mesh(new THREE.BoxGeometry(width, height, depth), materials.wood);
    body.position.y = height / 2;
    const drawer = new THREE.Mesh(new THREE.BoxGeometry(width * 0.86, height * 0.3, 0.035), materials.door);
    drawer.position.set(0, height * 0.62, depth / 2 + 0.018);
    root.add(body, drawer);
    root.position.set(x, y, z);
    root.rotation.y = yaw;
    scene.add(root);
    worldColliders.push({ minX: x - width / 2, maxX: x + width / 2, minZ: z - depth / 2, maxZ: z + depth / 2, type: 'furniture', floor, mesh: root });
  }
  const container = { id: `drawer-${searchContainers.length + 1}`, label, root, position: new THREE.Vector3(x, y + 0.68, z), floor, searched: false, rewardId: null };
  searchContainers.push(container);
  return root;
}

function assignSearchLoot() {
  for (const container of searchContainers) container.rewardId = null;
  if (!searchContainers.length) return;
  const keyContainer = searchContainers[Math.floor(Math.random() * searchContainers.length)];
  keyContainer.rewardId = 'key';
}

function spawnGranny(source) {
  const root = new THREE.Group();
  const visual = source || createGrannyFallback();
  visual.position.set(0, 0, 0);
  visual.rotation.set(0, 0, 0);
  visual.scale.set(1, 1, 1);
  visual.updateMatrixWorld(true);

  let bounds = new THREE.Box3().setFromObject(visual);
  let size = bounds.getSize(new THREE.Vector3());
  if (size.z > size.y * 1.12 && size.z > size.x * 1.12) {
    visual.rotation.x = -Math.PI / 2;
    visual.updateMatrixWorld(true);
    bounds = new THREE.Box3().setFromObject(visual);
    size = bounds.getSize(new THREE.Vector3());
  } else if (size.x > size.y * 1.12 && size.x > size.z * 1.12) {
    visual.rotation.z = Math.PI / 2;
    visual.updateMatrixWorld(true);
    bounds = new THREE.Box3().setFromObject(visual);
    size = bounds.getSize(new THREE.Vector3());
  }

  const sourceHeight = Math.max(0.25, size.y);
  visual.scale.setScalar(2.0 / sourceHeight);
  visual.updateMatrixWorld(true);
  bounds = new THREE.Box3().setFromObject(visual);
  visual.position.set(-(bounds.min.x + bounds.max.x) / 2, -bounds.min.y, -(bounds.min.z + bounds.max.z) / 2);
  visual.traverse((object) => {
    object.visible = true;
    object.frustumCulled = false;
    if (!object.isMesh) return;
    object.castShadow = false;
    object.receiveShadow = false;
    const applyColor = (mat) => {
      const m = mat.clone();
      if (m.map) { m.map.colorSpace = THREE.SRGBColorSpace; m.map.needsUpdate = true; }
      if (m.color) m.color.multiplyScalar(1.12);
      if (m.emissive) { m.emissive.set(0x201811); m.emissiveIntensity = Math.max(m.emissiveIntensity || 0, 0.16); }
      if (m.roughness !== undefined) m.roughness = Math.max(m.roughness, 0.7);
      m.side = THREE.DoubleSide;
      m.transparent = false;
      m.opacity = 1;
      m.needsUpdate = true;
      return m;
    };
    object.material = Array.isArray(object.material) ? object.material.map(applyColor) : applyColor(object.material);
  });

  root.position.set(GRANNY_SPAWN_SPOTS[0].x, 0, GRANNY_SPAWN_SPOTS[0].z);
  root.rotation.y = Math.PI;
  root.visible = true;
  root.add(visual);
  scene.add(root);
  game.ai.waypoint = 0;
  game.ai.floor = 0;
  const mixer = new THREE.AnimationMixer(visual);
  const clips = visual.animations || source?.animations || [];
  const walkClip = clips.find((clip) => /walk|walking|zombie/i.test(clip.name)) || clips[0];
  const attackClip = clips.find((clip) => /attack|bite|lunge/i.test(clip.name));
  let walkAction = null, attackAction = null;
  if (walkClip) {
    walkAction = mixer.clipAction(walkClip);
    walkAction.setEffectiveTimeScale(0.54);
    walkAction.setEffectiveWeight(1);
    walkAction.play();
  }
  if (attackClip && attackClip !== walkClip) {
    attackAction = mixer.clipAction(attackClip);
    attackAction.setLoop(THREE.LoopOnce, 1);
    attackAction.clampWhenFinished = true;
  }
  granny = { root, visual, mixer, walkAction, attackAction, walkClip, attackClip, height: 2.0, floor: 0 };
  placeGrannyAtRandomSpawn();
  grannyReady = true;
  if (new URLSearchParams(location.search).has('qa')) {
    window.__gameQA = {
      snapshot: () => {
        const box = new THREE.Box3().setFromObject(granny.root);
        let meshes = 0, triangles = 0;
        scene.traverse((object) => {
          if (!object.isMesh) return;
          meshes++;
          triangles += (object.geometry.index?.count ?? object.geometry.attributes.position?.count ?? 0) / 3;
        });
        return {
          player: { x: game.player.x, z: game.player.z, floor: game.player.floor, floorY: game.player.floorY, stairTransition: game.player.stairTransition ? { elapsed: game.player.stairTransition.elapsed, duration: game.player.stairTransition.duration, fromFloor: game.player.stairTransition.fromFloor, toFloor: game.player.stairTransition.toFloor } : null },
          camera: { yaw: game.cameraYaw, pitch: game.cameraPitch, targetYaw: game.targetYaw, targetPitch: game.targetPitch, x: camera.position.x, y: camera.position.y, z: camera.position.z },
          granny: { x: granny.root.position.x, y: granny.root.position.y, z: granny.root.position.z, visible: granny.root.visible, minY: box.min.y, maxY: box.max.y, height: box.max.y - box.min.y },
          stairs: { bottom: { ...STAIR_BOTTOM }, top: { ...STAIR_TOP }, bottomApproach: { ...STAIR_BOTTOM_APPROACH }, topApproach: { ...STAIR_TOP_APPROACH }, hole: { ...STAIR_HOLE } },
          traps: game.traps.map((trap) => ({ id: trap.id, x: trap.x, z: trap.z, floor: trap.floor, armed: trap.armed, scale: BEAR_TRAP_SCALE, size: new THREE.Box3().setFromObject(trap.root).getSize(new THREE.Vector3()).toArray() })),
          ai: game.ai.state,
          aiPath: { length: game.ai.path.length, index: game.ai.pathIndex, target: game.ai.pathGoal, mode: game.ai.pathMode, next: game.ai.path[game.ai.pathIndex] || null, points: game.ai.path.map((point) => ({ ...point })), stuckTimer: game.ai.stuckTimer, moving: game.ai.moving },
          navigation: { step: NAV_STEP, version: navigationVersion, floors: navigationStats() },
          wallPaintings: wallPaintings.length,
          paintingPlacements: wallPaintings.map((painting) => ({ x: painting.position.x, y: painting.position.y, z: painting.position.z, yaw: painting.rotation.y, type: painting.userData.paintingType })),
          animation: {
            clips: (granny.visual.animations || []).map((clip) => ({ name: clip.name, duration: clip.duration, tracks: clip.tracks.length })),
            walkClip: granny.walkClip?.name || null,
            walkActionActive: granny.walkAction?.isRunning() || false,
            mixerTime: granny.mixer.time,
          },
          meshes, triangles,
          doors: doors.map((door) => ({
            id: door.id, floor: door.floor, axis: door.axis, open: door.isOpen, locked: door.locked,
            center: { x: door.centerX, z: door.centerZ }, hinge: { x: door.hingeX, z: door.hingeZ },
            openingWidth: door.openingWidth, leafWidth: door.leafWidth, angle: door.angle, openAngle: door.openAngle,
          })),
          containers: searchContainers.map((container) => ({ id: container.id, x: container.position.x, z: container.position.z, floor: container.floor, rewardId: container.rewardId, searched: container.searched })),
        };
      },
      moveTo: (x, z, floor = 0) => {
        game.player.x = x; game.player.z = z; game.player.vx = game.player.vz = game.player.moved = 0; game.player.floor = floor;
        game.keys.clear(); game.mobileMove = { x: 0, y: 0 };
        game.player.floorY = game.player.targetFloorY = floor ? UPPER_FLOOR_Y : 0;
        camera.position.set(x, game.player.floorY + game.player.height, z);
      },
      teleportGranny: (x, z, floor = 0) => {
        game.ai.floor = floor; granny.floor = floor;
        granny.root.position.set(x, floor ? UPPER_FLOOR_Y : 0, z);
        game.ai.path = []; game.ai.pathIndex = 0; game.ai.pathTimer = 0; game.ai.pathGoal = null; game.ai.pathMode = null;
      },
      inspect: (yaw = game.cameraYaw) => { game.targetYaw = game.cameraYaw = yaw; updateInteractable(); },
      interact: doInteract,
      triggerJumpscare: (duration = 3.4) => {
        beginJumpscare();
        if (game.deathSequence && Number.isFinite(duration)) game.deathSequence.duration = duration;
      },
      placeTrap: (x = game.player.x + 1, z = game.player.z, floor = game.player.floor, yaw = 0) => {
        const trap = createTrap({ id: `qa-trap-${Date.now()}`, x, z, floor, yaw, armed: true });
        if (trap) game.traps.push(trap);
        return trap?.id || null;
      },
      forceGrannyTrapCycle: () => { game.ai.state = 'patrol'; game.ai.trapTimer = 17.99; },
      spawnGrannyRandom: placeGrannyAtRandomSpawn,
      spawnDemoPlayers: () => {
        const points = [{ x: -0.75, z: -3.2, color: PLAYER_COLORS[1], yaw: 2.9 }, { x: 0.8, z: -4.8, color: PLAYER_COLORS[2], yaw: 3.0 }];
        points.forEach((point, index) => {
          const uid = `qa-player-${index + 1}`;
          let remote = game.remotePlayers.get(uid);
          if (!remote) {
            const root = createPlayerAvatar(uid, point.color);
            remote = { root, target: root.userData.target };
            game.remotePlayers.set(uid, remote);
          }
          Object.assign(remote.target, { x: point.x, z: point.z, y: 0, yaw: point.yaw, pitch: 0 });
        });
        return game.remotePlayers.size;
      },
      stairTransition: switchFloor,
      noiseAt: (level, duration, x = game.player.x, z = game.player.z, floor = game.player.floor) => emitNoise(level, duration, x, z, floor),
      canMove: (x, z, floor = 0, radius = 0.31) => !collidesAt(x, z, radius, false, floor),
      pathBetween: (x, z, targetX, targetZ, floor = 0) => findNavigationPath(x, z, targetX, targetZ, floor),
      navigationMap: (floor = 0) => {
        const grid = navigationGrids[floor];
        return grid ? Array.from({ length: NAV_CELLS }, (_, row) => Array.from({ length: NAV_CELLS }, (_, col) => grid[gridIndex(col, row)] ? '#' : '.').join('')) : [];
      },
      colliderBoxes: (floor = 0) => worldColliders.filter((box) => (box.floor ?? 0) === floor).map((box) => ({ minX: box.minX, maxX: box.maxX, minZ: box.minZ, maxZ: box.maxZ, type: box.type, name: box.mesh?.name || '' })),
      interactable: () => currentInteractable ? { type: currentInteractable.type, label: currentInteractable.label } : null,
      state: () => ({ started: game.started, paused: game.paused, finished: game.finished, connecting: game.connecting, online: game.online ? { roomId: game.online.roomId, uid: game.online.uid, hostId: game.online.hostId, remotePlayers: game.remotePlayers.size } : null, ai: game.ai.state, seesPlayer: game.ai.seesPlayer, aiFloor: game.ai.floor, aiPathLength: game.ai.path.length, aiPathIndex: game.ai.pathIndex, granny: granny ? { x: granny.root.position.x, z: granny.root.position.z, floor: granny.floor } : null, noise: { ...game.noise }, keys: [...game.keys], velocity: { x: game.player.vx, z: game.player.vz }, trappedTimer: game.player.trappedTimer, trapNoticeTimer: game.trapNoticeTimer, inventory: [...game.inventory], exitLocked: doors.find((d) => d.exit)?.locked, exitOpen: doors.find((d) => d.exit)?.isOpen }),
    };
  }
}


function placeGrannyAtRandomSpawn() {
  if (!granny) return null;
  const player = game.player;
  const safe = GRANNY_SPAWN_SPOTS.filter((spot) => spot.floor !== player.floor || Math.hypot(spot.x - player.x, spot.z - player.z) > 6.5);
  const choices = safe.length ? safe : GRANNY_SPAWN_SPOTS;
  const spot = choices[Math.floor(Math.random() * choices.length)];
  granny.root.position.set(spot.x, spot.floor ? UPPER_FLOOR_Y : 0, spot.z);
  granny.root.rotation.y = Math.PI;
  granny.floor = spot.floor;
  game.ai.floor = spot.floor;
  game.ai.state = 'patrol';
  game.ai.targetUid = null;
  game.ai.seesPlayer = false;
  game.ai.searchTimer = 0;
  game.ai.timeInState = 0;
  game.ai.path = []; game.ai.pathIndex = 0; game.ai.pathTimer = 0; game.ai.pathGoal = null; game.ai.pathMode = null;
  let nearest = 0, best = Infinity;
  patrolRoute.forEach((point, index) => {
    const d = Math.hypot(point.x - spot.x, point.z - spot.z);
    if (d < best) { best = d; nearest = index; }
  });
  game.ai.waypoint = nearest;
  return { ...spot };
}

function createGrannyFallback() {
  const group = new THREE.Group();
  const dress = new THREE.Mesh(new THREE.CapsuleGeometry(0.38, 0.9, 4, 8), new THREE.MeshStandardMaterial({ color: 0x514044, roughness: 0.94 }));
  dress.name = 'granny-fallback-dress';
  dress.position.y = 0.72;
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.3, 12, 10), new THREE.MeshStandardMaterial({ color: 0xb9b49d, roughness: 0.9 }));
  head.name = 'granny-fallback-head';
  head.position.y = 1.65;
  group.add(dress, head);
  return group;
}

function addPositionalAnchor(parent, position, refDistance = 1.8, maxDistance = 22, rolloff = 1.2) {
  const anchor = new THREE.PositionalAudio(listener);
  anchor.setRefDistance(refDistance);
  anchor.setMaxDistance(maxDistance);
  anchor.setRolloffFactor(rolloff);
  anchor.setDistanceModel('exponential');
  anchor.position.copy(position);
  parent.add(anchor);
  return anchor;
}

function createDoorAudioAnchors() {
  for (const door of doors) {
    door.audioAnchor = addPositionalAnchor(door.pivot, new THREE.Vector3(0.48, 1.05, 0), 1.5, 17, 1.3);
  }
}

function loadAudioBuffer(url) {
  return audioLoader.loadAsync(url).catch((error) => {
    console.warn('Звук не загрузился:', url, error);
    return null;
  });
}

async function loadAudioAssets() {
  const [ambience, door, footsteps] = await Promise.all([
    loadAudioBuffer(ASSET.ambience), loadAudioBuffer(ASSET.doorSound), loadAudioBuffer(ASSET.footsteps),
  ]);
  audioBuffers = { ambience, door, footsteps };
  if (ambience) {
    game.ambience = new THREE.Audio(listener);
    game.ambience.setBuffer(ambience);
    game.ambience.setLoop(true);
    game.ambience.setVolume(0.18);
  }
  playerAudioAnchor = addPositionalAnchor(scene, new THREE.Vector3(0, 1, 0), 0.35, 6, 1.2);
  createDoorAudioAnchors();
}

function playSpatialClip(anchor, buffer, options = {}) {
  if (!anchor || !buffer || !game.audioEnabled || !game.audioStarted) return;
  try {
    const context = listener.context;
    if (context.state !== 'running') return;
    const source = context.createBufferSource();
    const gain = context.createGain();
    const duration = Math.max(0.05, Math.min(options.duration ?? buffer.duration, buffer.duration));
    const maxOffset = Math.max(0, buffer.duration - duration - 0.02);
    const offset = Math.max(0, Math.min(maxOffset, options.offset ?? Math.random() * maxOffset));
    source.buffer = buffer;
    source.playbackRate.value = options.rate ?? 1;
    gain.gain.value = options.volume ?? 0.45;
    source.connect(gain);
    gain.connect(anchor.getOutput());
    source.onended = () => { source.disconnect(); gain.disconnect(); };
    source.start(context.currentTime, offset, Math.min(duration, buffer.duration - offset));
  } catch (error) {
    console.debug('Spatial audio:', error);
  }
}

function startAudio() {
  if (!listener || !game.audioEnabled) return;
  game.audioStarted = true;
  listener.context.resume().catch(() => {});
  if (game.ambience && !game.ambience.isPlaying) game.ambience.play();
}


function addDoorCollision(door, floor = 0) {
  if ((door.floor ?? 0) !== floor || door.isOpen) return null;
  const width = door.leafWidth ?? 0.92;
  const thickness = Math.max(0.11, ROOM.wall * 0.42);
  if (door.axis === 'z') {
    return { minX: door.centerX - width / 2, maxX: door.centerX + width / 2, minZ: door.centerZ - thickness / 2, maxZ: door.centerZ + thickness / 2, type: 'door', door, floor };
  }
  return { minX: door.centerX - thickness / 2, maxX: door.centerX + thickness / 2, minZ: door.centerZ - width / 2, maxZ: door.centerZ + width / 2, type: 'door', door, floor };
}

function isExteriorCorridor(x, z) {
  const half = EXTERIOR_CORRIDOR_HALF + 0.12;
  const branch = EXTERIOR_BRANCH_HALF + 0.12;
  const end = EXTERIOR_BRANCH_END;
  const junction = EXTERIOR_JUNCTION;
  const outer = EXTERIOR_ARM_END;
  if (Math.abs(x) <= half && Math.abs(z) >= ROOM.maxZ - 0.1 && Math.abs(z) <= outer + 0.1) return true;
  if (Math.abs(z) <= half && Math.abs(x) >= ROOM.maxX - 0.1 && Math.abs(x) <= outer + 0.1) return true;
  for (const side of [-1, 1]) {
    if (Math.abs(z - side * junction) <= branch && Math.abs(x) >= half - 0.1 && Math.abs(x) <= end + 0.1) return true;
    if (Math.abs(x - side * junction) <= branch && Math.abs(z) >= half - 0.1 && Math.abs(z) <= end + 0.1) return true;
  }
  for (const xSide of [-1, 1]) {
    for (const zSide of [-1, 1]) {
      if (Math.abs(z - zSide * junction) <= branch && Math.abs(x) >= end - 0.1 && Math.abs(x) <= junction + 0.1) return true;
      if (Math.abs(x - xSide * junction) <= branch && Math.abs(z) >= end - 0.1 && Math.abs(z) <= junction + 0.1) return true;
    }
  }
  return false;
}

function collidesAt(x, z, radius, forAI = false, floor = 0, ignoreDoors = false) {
  const minX = WORLD.minX + ROOM.wall / 2 + radius;
  const maxX = WORLD.maxX - ROOM.wall / 2 - radius;
  const minZ = WORLD.minZ + ROOM.wall / 2 + radius;
  const maxZ = WORLD.maxZ - ROOM.wall / 2 - radius;
  const exitDoor = doors.find((door) => door.exit && (door.floor ?? 0) === floor);
  const exitWidth = exitDoor?.openingWidth ?? ROOM.doorWidth;
  const inOpenExitLane = !!(exitDoor?.isOpen && Math.abs(x - exitDoor.centerX) < exitWidth / 2 - radius * 0.2 && z > exitDoor.centerZ - ROOM.wall - radius);
  if (x < minX || x > maxX || z < minZ || (z > maxZ && !inOpenExitLane)) return true;
  if (floor === 0 && (Math.abs(x) > ROOM.maxX || Math.abs(z) > ROOM.maxZ) && !isExteriorCorridor(x, z)) return true;
  if (floor === 1 && (Math.abs(x) > ROOM.maxX || Math.abs(z) > ROOM.maxZ)) return true;
  // The upstairs opening is physically blocked; floor changes happen at its safe landing.
  if (floor === 1 && x + radius > STAIR_HOLE.minX && x - radius < STAIR_HOLE.maxX && z + radius > STAIR_HOLE.minZ && z - radius < STAIR_HOLE.maxZ) return true;

  for (const box of worldColliders) {
    if ((box.floor ?? 0) !== floor) continue;
    if (x + radius > box.minX && x - radius < box.maxX && z + radius > box.minZ && z - radius < box.maxZ) return true;
  }
  if (!ignoreDoors) {
    for (const door of doors) {
      const box = addDoorCollision(door, floor);
      if (box && x + radius > box.minX && x - radius < box.maxX && z + radius > box.minZ && z - radius < box.maxZ) return true;
    }
  }
  return false;
}

function moveActor(actor, dx, dz, radius, forAI = false, floorOverride = null) {
  const floor = floorOverride ?? actor.floor ?? 0;
  const oldX = actor.x, oldZ = actor.z;
  const xCandidate = actor.x + dx;
  if (!collidesAt(xCandidate, actor.z, radius, forAI, floor)) actor.x = xCandidate;
  const zCandidate = actor.z + dz;
  if (!collidesAt(actor.x, zCandidate, radius, forAI, floor)) actor.z = zCandidate;
  return Math.hypot(actor.x - oldX, actor.z - oldZ);
}

class NavigationHeap {
  constructor() { this.nodes = []; }
  push(id, score) {
    const node = { id, score };
    this.nodes.push(node);
    let i = this.nodes.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.nodes[parent].score <= score) break;
      this.nodes[i] = this.nodes[parent];
      i = parent;
    }
    this.nodes[i] = node;
  }
  pop() {
    if (!this.nodes.length) return null;
    const first = this.nodes[0];
    const last = this.nodes.pop();
    if (this.nodes.length) {
      let i = 0;
      while (true) {
        const left = i * 2 + 1, right = left + 1;
        if (left >= this.nodes.length) break;
        const child = right < this.nodes.length && this.nodes[right].score < this.nodes[left].score ? right : left;
        if (this.nodes[child].score >= last.score) break;
        this.nodes[i] = this.nodes[child];
        i = child;
      }
      this.nodes[i] = last;
    }
    return first;
  }
}

function gridIndex(col, row) { return row * NAV_CELLS + col; }
function gridWorld(col, row) { return { x: NAV_MIN + col * NAV_STEP, z: NAV_MIN + row * NAV_STEP }; }
function gridCellAt(x, z) {
  const col = Math.round((x - NAV_MIN) / NAV_STEP);
  const row = Math.round((z - NAV_MIN) / NAV_STEP);
  if (col < 0 || row < 0 || col >= NAV_CELLS || row >= NAV_CELLS) return -1;
  return gridIndex(col, row);
}
function gridCoordinates(index) { return { col: index % NAV_CELLS, row: Math.floor(index / NAV_CELLS) }; }

function buildNavigationGrid() {
  const count = NAV_CELLS * NAV_CELLS;
  navigationGrids = [];
  for (let floor = 0; floor < 2; floor++) {
    const blocked = new Uint8Array(count);
    for (let row = 0; row < NAV_CELLS; row++) {
      for (let col = 0; col < NAV_CELLS; col++) {
        const point = gridWorld(col, row);
        blocked[gridIndex(col, row)] = collidesAt(point.x, point.z, 0.28, true, floor, true) ? 1 : 0;
      }
    }
    navigationGrids[floor] = blocked;
  }
  navigationVersion++;
}

function nearestWalkableCell(x, z, floor, maxRadius = 12) {
  const blocked = navigationGrids[floor];
  if (!blocked) return -1;
  const origin = gridCellAt(x, z);
  if (origin < 0) return -1;
  if (!blocked[origin]) return origin;
  const { col: startCol, row: startRow } = gridCoordinates(origin);
  for (let radius = 1; radius <= maxRadius; radius++) {
    let best = -1, bestDistance = Infinity;
    for (let row = Math.max(0, startRow - radius); row <= Math.min(NAV_CELLS - 1, startRow + radius); row++) {
      for (let col = Math.max(0, startCol - radius); col <= Math.min(NAV_CELLS - 1, startCol + radius); col++) {
        if (Math.max(Math.abs(col - startCol), Math.abs(row - startRow)) !== radius) continue;
        const index = gridIndex(col, row);
        if (blocked[index]) continue;
        const point = gridWorld(col, row);
        const distance = (point.x - x) ** 2 + (point.z - z) ** 2;
        if (distance < bestDistance) { best = index; bestDistance = distance; }
      }
    }
    if (best >= 0) return best;
  }
  return -1;
}

function findNavigationPath(startX, startZ, targetX, targetZ, floor) {
  const blocked = navigationGrids[floor];
  if (!blocked) return [];
  const start = nearestWalkableCell(startX, startZ, floor);
  const goal = nearestWalkableCell(targetX, targetZ, floor);
  if (start < 0 || goal < 0 || start === goal) return [];
  const total = NAV_CELLS * NAV_CELLS;
  const costs = new Float32Array(total); costs.fill(Infinity);
  const parents = new Int32Array(total); parents.fill(-1);
  const closed = new Uint8Array(total);
  const heap = new NavigationHeap();
  const goalCell = gridCoordinates(goal);
  const heuristic = (col, row) => {
    const dx = Math.abs(goalCell.col - col), dz = Math.abs(goalCell.row - row);
    return Math.max(dx, dz) + (Math.SQRT2 - 1) * Math.min(dx, dz);
  };
  const startCell = gridCoordinates(start);
  costs[start] = 0;
  heap.push(start, heuristic(startCell.col, startCell.row));
  const directions = [[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]];
  let found = false;
  while (heap.nodes.length) {
    const current = heap.pop().id;
    if (closed[current]) continue;
    if (current === goal) { found = true; break; }
    closed[current] = 1;
    const { col, row } = gridCoordinates(current);
    for (const [dc, dr] of directions) {
      const nc = col + dc, nr = row + dr;
      if (nc < 0 || nr < 0 || nc >= NAV_CELLS || nr >= NAV_CELLS) continue;
      const next = gridIndex(nc, nr);
      if (blocked[next] || closed[next]) continue;
      if (dc && dr && (blocked[gridIndex(col + dc, row)] || blocked[gridIndex(col, row + dr)])) continue;
      const cost = costs[current] + (dc && dr ? Math.SQRT2 : 1);
      if (cost >= costs[next]) continue;
      costs[next] = cost;
      parents[next] = current;
      heap.push(next, cost + heuristic(nc, nr));
    }
  }
  if (!found) return [];
  const route = [];
  for (let current = goal; current !== start; current = parents[current]) {
    if (current < 0) return [];
    const { col, row } = gridCoordinates(current);
    route.push(gridWorld(col, row));
  }
  route.reverse();
  return route;
}

function navigationStats() {
  return navigationGrids.map((grid) => ({
    floor: navigationGrids.indexOf(grid),
    cells: grid.length,
    walkable: grid.reduce((sum, blocked) => sum + (blocked ? 0 : 1), 0),
  }));
}

function segmentHitsBox(ax, az, bx, bz, box) {
  let tMin = 0, tMax = 1;
  const dx = bx - ax, dz = bz - az;
  for (const [origin, delta, min, max] of [[ax, dx, box.minX, box.maxX], [az, dz, box.minZ, box.maxZ]]) {
    if (Math.abs(delta) < 1e-7) {
      if (origin < min || origin > max) return false;
    } else {
      let t1 = (min - origin) / delta;
      let t2 = (max - origin) / delta;
      if (t1 > t2) [t1, t2] = [t2, t1];
      tMin = Math.max(tMin, t1);
      tMax = Math.min(tMax, t2);
      if (tMin > tMax) return false;
    }
  }
  return tMax > 0.04 && tMin < 0.98;
}

function hasLineOfSight(fromX, fromZ, toX, toZ, floor = 0) {
  for (const wall of wallColliders) {
    if ((wall.floor ?? 0) !== floor) continue;
    if (segmentHitsBox(fromX, fromZ, toX, toZ, wall)) return false;
  }
  for (const door of doors) {
    const box = addDoorCollision(door, floor);
    if (box && segmentHitsBox(fromX, fromZ, toX, toZ, box)) return false;
  }
  return true;
}

function findNearbyClosedDoor(x, z, maxDistance = 1.45, floor = 0) {
  let result = null, best = maxDistance;
  for (const door of doors) {
    if ((door.floor ?? 0) !== floor || door.locked || door.isOpen) continue;
    const distance = Math.hypot(door.centerX - x, door.centerZ - z);
    if (distance < best) { result = door; best = distance; }
  }
  return result;
}

function emitNoise(level, duration, x = game.player.x, z = game.player.z, floor = game.player.floor) {
  game.noise = { x, z, floor, timer: duration, level };
}

function toggleDoor(door, automatic = false) {
  if (!door || (door.locked && door.exit)) return;
  if (door.exit) {
    if (door.isOpen) return;
    door.isOpen = true;
    syncDoorState(door);
    emitNoise(2.5, 2.4, game.player.x, game.player.z, game.player.floor);
    playSpatialClip(door.audioAnchor, audioBuffers.door, { duration: 1.8, offset: 0.6, volume: 0.55 });
    return;
  }

  door.isOpen = !door.isOpen;
  syncDoorState(door);
  if (!automatic) emitNoise(1.8, 1.4, game.player.x, game.player.z, game.player.floor);
  playSpatialClip(door.audioAnchor, audioBuffers.door, { duration: automatic ? 1.2 : 1.8, offset: 0.4, volume: automatic ? 0.25 : 0.4 });
}

function updateDoors(dt) {
  for (const door of doors) {
    const target = door.isOpen ? door.openAngle : 0;
    door.angle = THREE.MathUtils.damp(door.angle, target, 5.6, dt);
    door.pivot.rotation.y = door.baseYaw + door.angle;
  }
}

function updateInteractable() {
  if (!game.started || game.paused || game.finished || game.player.stairTransition) {
    dom.interactPrompt.classList.add('hidden');
    dom.crosshair.classList.remove('active');
    currentInteractable = null;
    return;
  }
  const p = game.player;
  const forwardX = -Math.sin(game.cameraYaw), forwardZ = -Math.cos(game.cameraYaw);
  let best = null, bestScore = Infinity;
  const consider = (type, ref, label, x, z, radius, minDot, bias = 0) => {
    const dx = x - p.x, dz = z - p.z;
    const dist = Math.hypot(dx, dz);
    if (dist > radius || dist < 0.001) return;
    const dot = (dx / dist) * forwardX + (dz / dist) * forwardZ;
    if (dot < minDot) return;
    const score = dist - dot * 0.28 + bias;
    if (score < bestScore) { best = { type, ref, label }; bestScore = score; }
  };

  for (const container of searchContainers) {
    if (container.floor !== p.floor || container.searched) continue;
    consider('container', container, container.label, container.position.x, container.position.z, 2.65, 0.26);
  }
  for (const door of doors) {
    if ((door.floor ?? 0) !== p.floor) continue;
    const label = door.exit
      ? (door.locked ? 'ВЫХОД ЗАПЕРТ' : (door.isOpen ? 'ПРОЙТИ НАРУЖУ' : 'ОТКРЫТЬ ВЫХОД'))
      : (door.isOpen ? 'ЗАКРЫТЬ ДВЕРЬ' : 'ОТКРЫТЬ ДВЕРЬ');
    consider('door', door, label, door.centerX, door.centerZ, 2.7, 0.24, 0.08);
  }
  const stairs = p.floor === 0 ? STAIR_BOTTOM_APPROACH : STAIR_TOP_APPROACH;
  consider('stairs', stairs, p.floor === 0 ? 'ПОДНЯТЬСЯ НА 2 ЭТАЖ' : 'СПУСТИТЬСЯ НА 1 ЭТАЖ', stairs.x, stairs.z, 2.35, 0.18, 0.02);

  currentInteractable = best;
  if (best) {
    dom.interactLabel.textContent = best.label;
    dom.interactPrompt.classList.remove('hidden');
    dom.crosshair.classList.add('active');
    dom.mobileInteractButton?.classList.add('ready');
  } else {
    dom.interactPrompt.classList.add('hidden');
    dom.crosshair.classList.remove('active');
    dom.mobileInteractButton?.classList.remove('ready');
  }
}

function advanceObjective(nextText) {
  if (objectiveCompleted) return;
  objectiveCompleted = true;
  const oldText = dom.objectiveText.textContent;
  dom.objectiveCurrent.classList.add('completing');
  window.setTimeout(() => {
    const completed = document.createElement('span');
    completed.className = 'completed-task';
    completed.textContent = oldText;
    dom.objectiveHistory.replaceChildren(completed);
    dom.objectiveText.textContent = nextText;
    dom.objectiveCurrent.classList.remove('completing');
    dom.objectiveCurrent.classList.add('entering');
    window.setTimeout(() => dom.objectiveCurrent.classList.remove('entering'), 520);
  }, 380);
}

function collectItem(item) {
  if (!item || item.collected) return;
  item.collected = true;
  game.inventory.add(item.id);
  if (item.id === 'key') {
    advanceObjective('ОТКРОЙ ВЫХОД');
    const exit = doors.find((door) => door.exit);
    if (exit) { exit.locked = false; syncDoorState(exit); }
    game.online?.publishWorld?.({ keyFound: true }).catch((error) => console.debug('Firebase key update:', error));
  }
  emitNoise(0.3, 0.35);
}

function switchFloor() {
  const p = game.player;
  if (p.stairTransition) return;
  const toFloor = p.floor === 0 ? 1 : 0;
  const target = toFloor === 1 ? STAIR_TOP : STAIR_BOTTOM;
  const dx = target.x - p.x, dz = target.z - p.z;
  const travelYaw = Math.atan2(-dx, -dz);
  p.stairTransition = {
    elapsed: 0, startedAt: performance.now(), duration: 2.65, fromFloor: p.floor, toFloor,
    start: { x: p.x, z: p.z, y: p.floorY },
    end: { x: target.x, z: target.z, y: toFloor ? UPPER_FLOOR_Y : 0 },
    travelYaw, lookDown: toFloor === 0 ? -0.46 : -0.24,
  };
  p.vx = 0; p.vz = 0; p.moved = 0;
  game.keys.clear(); game.mobileMove = { x: 0, y: 0 }; game.mobileSprint = false;
  currentInteractable = null;
  game.targetYaw = travelYaw;
  game.targetPitch = p.stairTransition.lookDown;
}

function updateStairTransition(dt) {
  const p = game.player, stair = p.stairTransition;
  if (!stair) return false;
  stair.elapsed = Math.min(stair.duration, (performance.now() - stair.startedAt) / 1000);
  const t = stair.elapsed / stair.duration;
  const eased = t * t * (3 - 2 * t);
  const stepBob = Math.sin(stair.elapsed * 9.5) * 0.012 * (t < 0.96 ? 1 : 0);
  p.x = THREE.MathUtils.lerp(stair.start.x, stair.end.x, eased);
  p.z = THREE.MathUtils.lerp(stair.start.z, stair.end.z, eased);
  p.floorY = THREE.MathUtils.lerp(stair.start.y, stair.end.y, eased) + stepBob;
  p.height = THREE.MathUtils.damp(p.height, p.crouched ? 1.12 : 1.68, 8, dt);
  game.cameraYaw = dampAngle(game.cameraYaw, stair.travelYaw, 4.2, dt);
  game.cameraPitch = THREE.MathUtils.damp(game.cameraPitch, stair.lookDown, 3.8, dt);
  camera.position.set(p.x, p.floorY + p.height + stepBob, p.z);
  camera.rotation.set(game.cameraPitch, game.cameraYaw, 0, 'YXZ');
  game.onlineSyncTimer = Math.min(game.onlineSyncTimer, 0.08);
  if (t >= 1) {
    p.x = stair.end.x; p.z = stair.end.z; p.floorY = stair.end.y; p.targetFloorY = stair.end.y; p.floor = stair.toFloor;
    p.stairTransition = null;
    game.targetYaw = stair.toFloor === 1 ? Math.PI : 0;
    game.targetPitch = 0;
    currentInteractable = null;
    updateInteractable();
  }
  return true;
}

function doInteract() {
  if (!currentInteractable || !game.started || game.paused || game.finished) return;
  if (currentInteractable.type === 'container') {
    const container = currentInteractable.ref;
    if (container.searched) return;
    container.searched = true;
    const item = items.find((entry) => entry.id === container.rewardId && !entry.collected);
    if (item) collectItem(item);
    syncContainerState(container);
    emitNoise(0.4, 0.5);
  } else if (currentInteractable.type === 'stairs') {
    switchFloor();
    return;
  } else if (currentInteractable.type === 'door') {
    toggleDoor(currentInteractable.ref, false);
  }
  currentInteractable = null;
  updateInteractable();
}

function updatePlayer(dt) {
  const p = game.player;
  if (updateStairTransition(dt)) return;
  if (game.observer) return; // Пойманный игрок смотрит за остальными — он движется только как статичное тело.
  p.trappedTimer = Math.max(0, p.trappedTimer - dt);
  let inputX = 0, inputY = 0;
  if (game.keys.has('KeyA') || game.keys.has('ArrowLeft')) inputX -= 1;
  if (game.keys.has('KeyD') || game.keys.has('ArrowRight')) inputX += 1;
  if (game.keys.has('KeyW') || game.keys.has('ArrowUp')) inputY += 1;
  if (game.keys.has('KeyS') || game.keys.has('ArrowDown')) inputY -= 1;
  inputX += game.mobileMove.x;
  inputY += game.mobileMove.y;
  const length = Math.hypot(inputX, inputY);
  if (length > 1) { inputX /= length; inputY /= length; }

  const wantsRun = (game.keys.has('ShiftLeft') || game.keys.has('ShiftRight') || game.mobileSprint) && !p.crouched && length > 0.1 && p.stamina > 0.5;
  const speed = (p.crouched ? 1.55 : (wantsRun ? 5.2 : 3.25)) * (p.trappedTimer > 0 ? 0.22 : 1);
  const forwardX = -Math.sin(game.cameraYaw), forwardZ = -Math.cos(game.cameraYaw);
  const rightX = Math.cos(game.cameraYaw), rightZ = -Math.sin(game.cameraYaw);
  let targetX = (rightX * inputX + forwardX * inputY) * speed;
  let targetZ = (rightZ * inputX + forwardZ * inputY) * speed;
  const smooth = 1 - Math.exp(-dt * (length > 0.08 ? 11 : 8));
  p.vx += (targetX - p.vx) * smooth;
  p.vz += (targetZ - p.vz) * smooth;
  const oldX = p.x, oldZ = p.z;
  p.moved = moveActor(p, p.vx * dt, p.vz * dt, 0.31, false);
  if (Math.abs(p.x - oldX) < 0.0001 && Math.abs(p.z - oldZ) < 0.0001 && length > 0.1) {
    p.vx *= 0.5; p.vz *= 0.5;
  }

  if (wantsRun && p.moved > 0.001) p.stamina = Math.max(0, p.stamina - dt * 19);
  else p.stamina = Math.min(100, p.stamina + dt * (p.crouched ? 14 : 24));

  const moving = p.moved > 0.003;
  if (moving) {
    p.bob += dt * (wantsRun ? 15.5 : (p.crouched ? 6.2 : 10.2));
    const interval = p.crouched ? 0.78 : (wantsRun ? 0.34 : 0.55);
    p.stepTimer -= dt;
    if (p.stepTimer <= 0) {
      const volume = p.crouched ? 0.14 : (wantsRun ? 0.48 : 0.32);
      playSpatialClip(playerAudioAnchor, audioBuffers.footsteps, { offset: p.stepOffset, duration: 0.32, volume, rate: wantsRun ? 1.08 : 0.92 });
      p.stepOffset = (p.stepOffset + 0.48) % Math.max(0.5, (audioBuffers.footsteps?.duration || 15) - 0.4);
      p.stepTimer = interval;
      emitNoise(p.crouched ? 0 : (wantsRun ? 3.2 : 1.0), p.crouched ? 0.25 : (wantsRun ? 1.8 : 0.75), p.x, p.z, p.floor);
    }
  } else {
    p.stepTimer = Math.min(p.stepTimer, 0.12);
    p.vx *= Math.exp(-dt * 5); p.vz *= Math.exp(-dt * 5);
  }

  if (game.noise.timer > 0) game.noise.timer = Math.max(0, game.noise.timer - dt);
  const targetHeight = p.crouched ? 1.12 : 1.68;
  p.height = THREE.MathUtils.damp(p.height, targetHeight, 11, dt);
  p.floorY = THREE.MathUtils.damp(p.floorY, p.targetFloorY, 7, dt);
  const bobY = moving ? Math.sin(p.bob) * (wantsRun ? 0.035 : (p.crouched ? 0.008 : 0.018)) : 0;
  const strafeLean = THREE.MathUtils.clamp(inputX, -1, 1) * (moving ? -0.014 : 0);
  camera.position.set(p.x, p.floorY + p.height + bobY, p.z);
  game.cameraYaw = THREE.MathUtils.damp(game.cameraYaw, game.targetYaw, 16, dt);
  game.cameraPitch = THREE.MathUtils.damp(game.cameraPitch, game.targetPitch, 16, dt);
  camera.rotation.set(game.cameraPitch, game.cameraYaw, strafeLean, 'YXZ');
  const desiredFov = wantsRun ? 77 : (p.crouched ? 68 : 71);
  camera.fov = THREE.MathUtils.damp(camera.fov, desiredFov, 4.5, dt);
  camera.updateProjectionMatrix();
  playerAudioAnchor?.position.set(p.x, p.floorY + (p.crouched ? 0.75 : 1.0), p.z);

  dom.staminaFill.style.width = `${p.stamina}%`;
  dom.staminaFill.classList.toggle('low', p.stamina < 24);
}

function transitionGrannyFloor(nextFloor) {
  const ai = game.ai;
  const spot = nextFloor === 1 ? STAIR_TOP : STAIR_BOTTOM;
  ai.floor = nextFloor;
  granny.floor = nextFloor;
  granny.root.position.set(spot.x, nextFloor ? UPPER_FLOOR_Y : 0, spot.z);
  ai.seesPlayer = false;
  ai.searchTimer = 0;
  ai.timeInState = 0;
  ai.path = []; ai.pathIndex = 0; ai.pathTimer = 0; ai.pathGoal = null; ai.pathMode = null;
}

function beginJumpscare(asObserver = false) {
  if (game.deathSequence || game.finished || !granny) return;
  // В мультиплеере пойманный игрок не «умирает» — он становится наблюдателем:
  // камера переходит к первому лицу другого игрока, бабка продолжает преследовать
  // оставшихся (и не вешается, потому что симуляция не остановилась).
  if (game.online) {
    enterObserverMode();
    return;
  }
  const forward = new THREE.Vector3();
  camera.getWorldDirection(forward);
  const horizontal = new THREE.Vector3(forward.x, 0, forward.z).normalize();
  if (horizontal.lengthSq() < 0.001) horizontal.set(0, 0, -1);
  const player = game.player;
  const floorY = player.floor ? UPPER_FLOOR_Y : 0;
  const startDistance = 4.8, endDistance = 2.8;
  const start = { x: player.x + horizontal.x * startDistance, z: player.z + horizontal.z * startDistance };
  const end = { x: player.x + horizontal.x * endDistance, z: player.z + horizontal.z * endDistance };
  granny.walkAction?.stop();
  granny.attackAction?.stop();
  granny.root.position.set(start.x, floorY, start.z);
  granny.root.rotation.y = Math.atan2(player.x - start.x, player.z - start.z);
  granny.floor = player.floor; game.ai.floor = player.floor;
  granny.visual.traverse((object) => { if (object.isMesh) object.visible = true; });
  game.deathSequence = {
    elapsed: 0, startedAt: performance.now(), duration: 3.4, start, end, floorY,
    startScale: granny.root.scale.x || 1,
  };
  game.paused = true;
  dom.hud.classList.add('hidden');
  dom.mobileControls.classList.add('hidden');
  dom.jumpscareScreen.classList.remove('hidden');
  dom.jumpscareScreen.classList.add('active');
  dom.jumpscareScreen.setAttribute('aria-hidden', 'false');
  if (document.pointerLockElement) document.exitPointerLock?.();
}

function updateJumpscare() {
  const scare = game.deathSequence;
  if (!scare || !granny) return;
  scare.elapsed = Math.min(scare.duration, (performance.now() - scare.startedAt) / 1000);
  const t = scare.elapsed / scare.duration;
  const eased = 1 - Math.pow(1 - t, 3);
  granny.root.position.x = THREE.MathUtils.lerp(scare.start.x, scare.end.x, eased);
  granny.root.position.z = THREE.MathUtils.lerp(scare.start.z, scare.end.z, eased);
  granny.root.position.y = scare.floorY;
  granny.root.scale.setScalar(scare.startScale * (1 + 0.1 * eased));
  granny.root.rotation.y = Math.atan2(game.player.x - granny.root.position.x, game.player.z - granny.root.position.z);
  if (scare.elapsed >= scare.duration) {
    game.deathSequence = null;
    game.finished = true;
    game.paused = true;
    dom.jumpscareScreen.classList.remove('active');
    dom.jumpscareScreen.classList.add('hidden');
    dom.jumpscareScreen.setAttribute('aria-hidden', 'true');
    dom.death.classList.remove('hidden');
  }
}

// --- Режим наблюдателя (мультиплеер): пойманный игрок смотрит за остальными ---

function showObserverStatus(message = 'НАБЛЮДЕНИЕ') {
  if (!dom.observerStatus) return;
  dom.observerStatus.textContent = message;
  dom.observerStatus.classList.remove('hidden');
}

function hideObserverStatus() {
  dom.observerStatus?.classList.add('hidden');
}

function enterObserverMode() {
  game.observer = true;
  game.watchingUid = null;
  // Игра не ставится на паузу: симуляция бабки (на хосте) продолжается,
  // и она не вешается после ловли одного игрока.
  game.paused = false;
  if (document.pointerLockElement) document.exitPointerLock?.();
  game.mouseDrag = false;
  // Сообщаем остальным, что этот игрок пойман — его больше не преследует бабка.
  if (game.online?.publish) game.online.publish({ caught: true, alive: false }).catch(() => {});
  showObserverStatus('НАБЛЮДЕНИЕ · Смотрите за остальными');
}

// Кого смотреть: ближайший живой (не пойманный) другой игрок.
function pickWatchedPlayer() {
  if (!game.remotePlayers.size) return null;
  let best = null, bestDistance = Infinity;
  const ox = game.player.x, oz = game.player.z;
  for (const [uid, remote] of game.remotePlayers) {
    if (remote.target.alive === false) continue;
    const d = Math.hypot(remote.target.x - ox, remote.target.z - oz);
    if (d < bestDistance) { bestDistance = d; best = remote; }
  }
  return best;
}

function updateObserverCamera(dt) {
  const watched = pickWatchedPlayer();
  if (!watched) {
    // Никого живым не осталось — для наблюдателя игра окончена (погибель, не победа).
    game.observer = false;
    hideObserverStatus();
    game.finished = true;
    game.paused = true;
    if (document.pointerLockElement) document.exitPointerLock?.();
    dom.death.classList.remove('hidden');
    return;
  }
  game.watchingUid = watched.root.userData.playerId;
  const t = watched.target;
  const height = t.crouched ? 1.12 : 1.68;
  const floorY = Number.isFinite(t.floorY) ? t.floorY : (t.floor ? UPPER_FLOOR_Y : 0);
  camera.position.set(
    THREE.MathUtils.damp(camera.position.x, t.x, 8, dt),
    THREE.MathUtils.damp(camera.position.y, floorY + height + 0.02, 8, dt),
    THREE.MathUtils.damp(camera.position.z, t.z, 8, dt),
  );
  camera.rotation.set(
    THREE.MathUtils.damp(camera.rotation.x, Number.isFinite(t.pitch) ? t.pitch : 0, 8, dt),
    THREE.MathUtils.damp(camera.rotation.y, Number.isFinite(t.yaw) ? t.yaw : 0, 8, dt),
    0,
    'YXZ',
  );
}

function updateGranny(dt) {
  if (!granny || !grannyReady) return;
  const ai = game.ai;
  const gx = granny.root.position.x, gz = granny.root.position.z;
  // Пойманный (наблюдатель) игрок не участвует в охоте; пойманные чужие — тоже.
  const candidates = [];
  if (!game.observer) candidates.push({ ...game.player, uid: game.online?.uid || 'local' });
  if (game.online && game.online.hostId === game.online.uid) {
    for (const [uid, remote] of game.remotePlayers) {
      if (remote.target.alive === false) continue;
      candidates.push({ ...remote.target, uid, crouched: remote.target.crouched });
    }
  }
  if (!candidates.length) return;
  const distanceToGranny = (candidate) => Math.hypot(candidate.x - gx, candidate.z - gz, candidate.floor === ai.floor ? 0 : UPPER_FLOOR_Y);
  const nearest = candidates.reduce((best, candidate) => distanceToGranny(candidate) < distanceToGranny(best) ? candidate : best, candidates[0]);
  let p = candidates.find((candidate) => candidate.uid === ai.targetUid) || nearest;
  ai.losTimer -= dt;
  if (ai.losTimer <= 0) {
    const facingX = Math.sin(granny.root.rotation.y);
    const facingZ = Math.cos(granny.root.rotation.y);
    const visiblePlayers = candidates.filter((candidate) => {
      if (candidate.floor !== ai.floor) return false;
      const vx = candidate.x - gx, vz = candidate.z - gz;
      const distance = Math.hypot(vx, vz);
      const range = candidate.crouched ? 4.6 : 8.6;
      const facingDot = distance > 0.001 ? (vx * facingX + vz * facingZ) / distance : 1;
      return distance < range && facingDot > -0.12 && hasLineOfSight(gx, gz, candidate.x, candidate.z, ai.floor);
    }).sort((a, b) => distanceToGranny(a) - distanceToGranny(b));
    ai.seesPlayer = visiblePlayers.length > 0;
    if (ai.seesPlayer) {
      p = visiblePlayers[0];
      ai.targetUid = p.uid;
      ai.lastSeen = { x: p.x, z: p.z, floor: p.floor, uid: p.uid };
    } else if (ai.targetUid) {
      p = candidates.find((candidate) => candidate.uid === ai.targetUid) || nearest;
    } else p = nearest;
    ai.losTimer = 0.18;
  }
  const dx = p.x - gx, dz = p.z - gz;
  const distance = Math.hypot(dx, dz);
  const sameFloor = ai.floor === p.floor;

  const verticalNoiseGap = game.noise.floor === ai.floor ? 0 : UPPER_FLOOR_Y;
  const noiseDistance = Math.hypot(game.noise.x - gx, game.noise.z - gz, verticalNoiseGap);
  const hearsNoise = game.noise.timer > 0 && game.noise.level >= 0.8 && noiseDistance < (game.noise.level > 2.5 ? 12.5 : 7.2);
  const heardNow = { x: game.noise.x, z: game.noise.z, floor: game.noise.floor };

  // Sight starts a chase. Sound only attracts her to investigate and search the heard location.
  if (ai.seesPlayer && ai.state !== 'attack') {
    if (ai.state !== 'chase') {
      ai.timeInState = 0;
      ai.pathTimer = 0;
      ai.pathMode = null;
    }
    ai.state = 'chase';
    ai.searchTimer = 0;
  } else if (ai.state === 'chase') {
    if (!sameFloor) ai.searchTimer = 0;
    else {
      ai.searchTimer += dt;
      if (ai.searchTimer > 3.3) {
        ai.state = hearsNoise ? 'investigate' : 'search';
        ai.searchOrigin = hearsNoise ? heardNow : (ai.lastSeen || { x: gx, z: gz, floor: ai.floor });
        ai.searchIndex = 0;
        ai.timeInState = 0;
        ai.searchTimer = 0;
        ai.pathTimer = 0;
      }
    }
  } else if (hearsNoise && ai.state !== 'attack') {
    const changedHeardPoint = !ai.lastHeard || Math.hypot(ai.lastHeard.x - heardNow.x, ai.lastHeard.z - heardNow.z) > 0.55 || ai.lastHeard.floor !== heardNow.floor;
    if (ai.state !== 'investigate') {
      ai.state = 'investigate';
      ai.timeInState = 0;
      ai.searchOrigin = heardNow;
      ai.pathTimer = 0;
    }
    if (changedHeardPoint) ai.lastHeard = heardNow;
  } else if (ai.state === 'investigate' && ai.timeInState > 5.5) {
    ai.state = 'search';
    ai.searchOrigin = ai.lastHeard || ai.searchOrigin;
    ai.searchIndex = 0;
    ai.timeInState = 0;
    ai.pathTimer = 0;
  } else if (ai.state === 'search' && ai.timeInState > 1.25) {
    ai.searchIndex++;
    ai.timeInState = 0;
    ai.pathTimer = 0;
    if (ai.searchIndex >= 5) {
      ai.state = 'patrol';
      ai.searchOrigin = null;
      ai.searchIndex = 0;
    }
  }

  ai.timeInState += dt;
  let target = null, speed = 0.95, floorTransition = null;
  if (ai.state === 'chase') {
    if (sameFloor) { target = { x: p.x, z: p.z }; speed = 2.55; }
    else {
      target = ai.floor === 0 ? STAIR_BOTTOM : STAIR_TOP;
      floorTransition = p.floor;
      speed = 1.35;
    }
  } else if (ai.state === 'investigate') {
    const heard = ai.lastHeard || ai.searchOrigin || heardNow;
    if (heard.floor === ai.floor) {
      target = heard;
      speed = 1.16;
      if (Math.hypot(target.x - gx, target.z - gz) < 0.72) {
        ai.state = 'search';
        ai.searchOrigin = { ...heard };
        ai.searchIndex = 0;
        ai.timeInState = 0;
        ai.pathTimer = 0;
      }
    } else {
      target = ai.floor === 0 ? STAIR_BOTTOM : STAIR_TOP;
      floorTransition = heard.floor;
      speed = 1.12;
    }
  } else if (ai.state === 'search') {
    const origin = ai.searchOrigin || ai.lastSeen || { x: gx, z: gz, floor: ai.floor };
    const offsets = [[0,0],[0,-0.85],[0.85,0],[0,0.85],[-0.85,0]];
    if (origin.floor !== ai.floor) {
      target = ai.floor === 0 ? STAIR_BOTTOM : STAIR_TOP;
      floorTransition = origin.floor;
    } else {
      const [ox, oz] = offsets[ai.searchIndex] || offsets[0];
      target = { x: origin.x + ox, z: origin.z + oz };
    }
    speed = 0.8;
  } else if (ai.state === 'patrol') {
    target = patrolRoute[ai.waypoint];
    speed = 0.98;
    if (Math.hypot(target.x - gx, target.z - gz) < 0.62) {
      ai.waypoint = (ai.waypoint + 1) % patrolRoute.length;
      target = patrolRoute[ai.waypoint];
      ai.pathTimer = 0;
    }
  }

  ai.moving = false;
  if (target && ai.state !== 'attack') {
    const targetDistance = Math.hypot(target.x - granny.root.position.x, target.z - granny.root.position.z);
    if (floorTransition !== null && targetDistance < 0.82) {
      transitionGrannyFloor(floorTransition);
    } else {
      ai.pathTimer -= dt;
      const goalShifted = !ai.pathGoal || Math.hypot(ai.pathGoal.x - target.x, ai.pathGoal.z - target.z) > 0.82;
      const pathExhaustedAwayFromGoal = ai.path.length > 0 && ai.pathIndex >= ai.path.length && targetDistance > 0.58;
      if (goalShifted || ai.pathMode !== ai.state || ai.pathFloor !== ai.floor || ai.pathTimer <= 0 || pathExhaustedAwayFromGoal) {
        ai.path = findNavigationPath(granny.root.position.x, granny.root.position.z, target.x, target.z, ai.floor);
        ai.pathIndex = 0;
        ai.pathGoal = { x: target.x, z: target.z };
        ai.pathFloor = ai.floor;
        ai.pathMode = ai.state;
        ai.pathTimer = ai.state === 'chase' ? 0.26 : 0.48;
      }
      while (ai.pathIndex < ai.path.length && Math.hypot(ai.path[ai.pathIndex].x - granny.root.position.x, ai.path[ai.pathIndex].z - granny.root.position.z) < 0.24) ai.pathIndex++;
      const waypoint = ai.path[ai.pathIndex];
      if (waypoint) {
        const approachDoor = findNearbyClosedDoor(granny.root.position.x, granny.root.position.z, 1.2, ai.floor);
        if (approachDoor && Math.hypot(waypoint.x - approachDoor.centerX, waypoint.z - approachDoor.centerZ) < 0.82 && Math.hypot(approachDoor.centerX - granny.root.position.x, approachDoor.centerZ - granny.root.position.z) < 1.05) {
          toggleDoor(approachDoor, true);
          ai.stuckTimer = 0;
          ai.pathTimer = 0;
        }
        const vx = waypoint.x - granny.root.position.x;
        const vz = waypoint.z - granny.root.position.z;
        const waypointDistance = Math.hypot(vx, vz);
        if (waypointDistance > 0.04) {
          const dirX = vx / waypointDistance, dirZ = vz / waypointDistance;
          const desiredYaw = Math.atan2(dirX, dirZ);
          granny.root.rotation.y = dampAngle(granny.root.rotation.y, desiredYaw, 5.2, dt);
          const moved = moveActor(granny.root.position, dirX * speed * dt, dirZ * speed * dt, 0.3, true, ai.floor);
          ai.moving = moved > 0.002;
          if (!ai.moving) {
            ai.stuckTimer += dt;
            const nearbyDoor = findNearbyClosedDoor(granny.root.position.x, granny.root.position.z, 1.55, ai.floor);
            if (nearbyDoor && Math.hypot(nearbyDoor.centerX - granny.root.position.x, nearbyDoor.centerZ - granny.root.position.z) < 1.35 && ai.stuckTimer > 0.04) {
              toggleDoor(nearbyDoor, true);
              ai.stuckTimer = 0;
              ai.pathTimer = 0;
            } else if (ai.stuckTimer > 0.9) {
              ai.pathTimer = 0;
              ai.stuckTimer = 0;
            }
          } else ai.stuckTimer = Math.max(0, ai.stuckTimer - dt * 1.5);
        }
      }
    }
  }

  const actualDistance = sameFloor ? Math.hypot(p.x - granny.root.position.x, p.z - granny.root.position.z) : Infinity;
  if (sameFloor && ai.state === 'chase' && ai.seesPlayer && !p.crouched && actualDistance < 0.78) {
    ai.state = 'attack';
    ai.timeInState = 0;
    ai.attackPlayed = false;
    dom.damageFlash.classList.add('on');
    damageTimer = 0.4;
  }
  if (ai.state === 'attack' && ai.timeInState > 0.82 && !game.deathSequence && !game.observer && (!game.online || p.uid === 'local' || p.uid === game.online.uid)) beginJumpscare();

  if (granny.walkAction) {
    if (ai.state === 'attack') {
      if (granny.attackAction && !ai.attackPlayed) {
        granny.walkAction.fadeOut(0.12);
        granny.attackAction.reset().fadeIn(0.12).play();
        ai.attackPlayed = true;
      }
    } else {
      ai.attackPlayed = false;
      const animationRate = ai.state === 'chase' ? 1.05 : (ai.state === 'investigate' ? 0.84 : (ai.moving ? 0.72 : 0.22));
      granny.walkAction.setEffectiveTimeScale(animationRate);
      if (!granny.walkAction.isRunning()) {
        granny.walkAction.enabled = true;
        granny.walkAction.play();
      }
      if (granny.walkAction.getEffectiveWeight() < 0.9) granny.walkAction.fadeIn(0.18);
    }
  }
  granny.root.position.y = ai.floor ? UPPER_FLOOR_Y : 0;
  if (ai.state === 'patrol' || ai.state === 'investigate') {
    ai.trapTimer += dt;
    if (ai.trapTimer >= 18) ai.trapTimer = placeGrannyTrap() ? 0 : 12;
  }
  granny.mixer?.update(dt);
}

function dampAngle(current, target, lambda, dt) {
  let delta = THREE.MathUtils.euclideanModulo(target - current + Math.PI, Math.PI * 2) - Math.PI;
  return current + delta * (1 - Math.exp(-lambda * dt));
}

function updateDecor(dt) {
  const t = clock.elapsedTime;
  if (game.dust) game.dust.rotation.y = Math.sin(t * 0.08) * 0.035;
  for (const light of houseLights) {
    const base = light.userData.baseIntensity ?? 0.5;
    if (light.userData.flicker) {
      const phase = light.userData.phase || 0;
      const flicker = 0.93 + 0.055 * Math.sin(t * 7.4 + phase) + 0.035 * Math.sin(t * 17.7 + phase * 2.1);
      light.intensity = base * flicker;
    }
  }
}

function updateHUD(dt) {
  if (damageTimer > 0) {
    damageTimer -= dt;
    if (damageTimer <= 0 && !game.finished) dom.damageFlash.classList.remove('on');
  }
  if (game.trapNoticeTimer > 0) {
    game.trapNoticeTimer = Math.max(0, game.trapNoticeTimer - dt);
    if (game.trapNoticeTimer === 0) dom.trapNotice?.classList.add('hidden');
  }
}

function finishGame() {
  if (game.finished) return;
  game.finished = true;
  game.paused = true;
  dom.win.classList.remove('hidden');
  if (document.pointerLockElement) document.exitPointerLock?.();
}

function updateSoundMood(dt) {
  if (!game.ambience || !game.audioStarted || !game.audioEnabled) return;
  if (granny) {
    const floorGap = game.player.floor === granny.floor ? 0 : UPPER_FLOOR_Y;
    const d = Math.hypot(game.player.x - granny.root.position.x, game.player.z - granny.root.position.z, floorGap);
    const target = 0.11 + THREE.MathUtils.clamp((10 - d) / 10, 0, 1) * 0.08;
    game.ambience.setVolume(THREE.MathUtils.damp(game.ambience.getVolume(), target, 2, dt));
  }
}

function updateGame(dt) {
  updatePlayer(dt);
  updateTraps(dt);
  updateRemotePlayers(dt);
  if (game.observer) updateObserverCamera(dt);
  publishOnlinePlayer(dt);
  updateDoors(dt);
  const exitDoor = doors.find((door) => door.exit);
  if (exitDoor?.isOpen && game.player.floor === 0 && Math.abs(game.player.x - exitDoor.centerX) < exitDoor.openingWidth * 0.32 && game.player.z > exitDoor.centerZ + 0.55) {
    finishGame();
    updateHUD(dt);
    return;
  }
  if (!game.online || game.online.hostId === game.online.uid) updateGranny(dt);
  else updateRemoteGranny(dt);
  updateDecor(dt);
  updateInteractable();
  updateHUD(dt);
  updateSoundMood(dt);
}

function updateMenuCamera(dt) {
  if (!camera) return;
  if (!menuOrbit.initialized) {
    camera.position.copy(MENU_ORBIT_POINTS[0]);
    camera.lookAt(0, 1.6, 0);
    menuOrbit.initialized = true;
  }
  if (menuOrbit.hold > 0) {
    menuOrbit.hold = Math.max(0, menuOrbit.hold - dt);
    camera.lookAt(0, 1.7, 0);
    return;
  }
  const duration = 4.15;
  menuOrbit.t = Math.min(1, menuOrbit.t + dt / duration);
  const t = menuOrbit.t;
  const ease = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  const from = MENU_ORBIT_POINTS[menuOrbit.segment];
  const to = MENU_ORBIT_POINTS[(menuOrbit.segment + 1) % MENU_ORBIT_POINTS.length];
  camera.position.copy(from).lerp(to, ease);
  camera.lookAt(0, 1.7, 0);
  if (t >= 1) {
    menuOrbit.segment = (menuOrbit.segment + 1) % MENU_ORBIT_POINTS.length;
    menuOrbit.t = 0;
    menuOrbit.hold = 0.72;
  }
}

function updateMenuScene(dt) {
  updateDoors(dt);
  updateDecor(dt);
  updateMenuCamera(dt);
  if (granny?.mixer) granny.mixer.update(dt * 0.6);
  menuNoiseAnimation += dt;
  if (!game.started && granny) {
    granny.root.rotation.y = dampAngle(granny.root.rotation.y, Math.sin(menuNoiseAnimation * 0.16) * 0.22 + Math.PI, 0.5, dt);
  }
}

function renderLoop() {
  requestAnimationFrame(renderLoop);
  const dt = Math.min(clock.getDelta(), MAX_DELTA);
  if (game.deathSequence) updateJumpscare(dt);
  else if (game.started && !game.paused && !game.finished) updateGame(dt);
  else if (!game.started) updateMenuScene(dt);
  renderer.render(scene, camera);
}

function toggleCrouch() {
  game.player.crouched = !game.player.crouched;
  if (dom.mobileCrouchButton) dom.mobileCrouchButton.classList.toggle('active', game.player.crouched);
}

function showPause() {
  if (!game.started || game.finished) return;
  game.paused = true;
  dom.pause.classList.remove('hidden');
  if (document.pointerLockElement) document.exitPointerLock?.();
}

function resumeGame() {
  if (game.finished) return;
  game.paused = false;
  dom.pause.classList.add('hidden');
  startAudio();
  // У наблюдателя камера ведёт себя автоматически — pointer lock не нужен.
  if (shouldUsePointerLock() && !game.observer) {
    try { dom.canvas.requestPointerLock?.(); } catch { /* Safari и прочие неподдерживающие браузеры — вращение мыши */ }
  }
}

const ONLINE_CONNECT_TIMEOUT_MS = 9000;

function withTimeout(promise, ms, onTimeout) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const error = new Error('Firebase connect timed out');
      error.userMessage = onTimeout;
      reject(error);
    }, ms);
    promise.then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
  });
}

async function startGame() {
  if (game.started || game.connecting) return;
  game.connecting = true;
  const buttonLabel = dom.startButton.querySelector('span');
  const originalLabel = buttonLabel?.textContent || 'ИГРАТЬ';
  if (isFirebaseConfigured() && buttonLabel) {
    buttonLabel.textContent = 'ПОДКЛЮЧАЕМСЯ';
    dom.startButton.disabled = true;
  }

  let connection = null;
  let onlineError = null;
  if (isFirebaseConfigured()) {
    try {
      connection = await withTimeout(
        connectToQuickGame({ displayName: 'Игрок' }, receiveOnlinePlayers, receiveOnlineWorld, receiveOnlineHost, receiveOnlineError),
        ONLINE_CONNECT_TIMEOUT_MS,
        'Сервер не отвечает (тайм-аут 9 с). Проверьте интернет и блокировщики.',
      );
    } catch (error) {
      onlineError = error?.userMessage || error?.message || 'Не удалось подключиться к мультиплееру.';
      console.error('Онлайн недоступен; запускаем одиночную игру:', error);
    }
  }

  game.connecting = false;
  if (buttonLabel) buttonLabel.textContent = originalLabel;
  dom.startButton.disabled = false;
  game.online = connection?.connected ? connection : null;
  if (game.online) {
    if (game.pendingHostId) game.online.hostId = game.pendingHostId;
    applySharedWorld(game.pendingRemoteWorld || game.online.world || {});
    game.pendingHostId = null;
  }
  const slot = game.online ? game.online.slot % PLAYER_SPAWN_POINTS.length : 0;
  const spawn = PLAYER_SPAWN_POINTS[slot];
  Object.assign(game.player, { x: spawn.x, z: spawn.z, vx: 0, vz: 0, floor: 0, floorY: 0, targetFloorY: 0, height: 1.68, crouched: false, stamina: 100, stairTransition: null });
  game.cameraYaw = game.targetYaw = 0;
  game.cameraPitch = game.targetPitch = 0;
  game.finished = false;
  game.paused = false;
  game.observer = false;
  game.watchingUid = null;
  hideObserverStatus();
  placeGrannyAtRandomSpawn();
  camera.position.set(game.player.x, game.player.height, game.player.z);
  camera.rotation.set(0, 0, 0, 'YXZ');

  if (game.online) {
    const colorHex = Number.parseInt(game.online.profile.color.slice(1), 16);
    game.localAvatar = createPlayerAvatar(game.online.uid, Number.isFinite(colorHex) ? colorHex : PLAYER_COLORS[slot], false);
    receiveOnlinePlayers(game.online.players || {});
    game.online.publish({ x: game.player.x, z: game.player.z, floor: 0, floorY: 0, yaw: 0, pitch: 0, crouched: false }).catch(() => {});
  } else {
    dom.onlineStatus?.classList.add('hidden');
  }

  game.started = true;
  if (game.online && game.online.hostId === game.online.uid) publishWorldSnapshot();
  dom.start.classList.add('hidden');
  dom.hud.classList.remove('hidden');
  if (onlineError && !game.online) showOnlineError(onlineError);
  if (mobileDevice) {
    dom.mobileControls.classList.remove('hidden');
    requestLandscapeOrientation();
    updateMobileOrientation();
  }
  startAudio();
  if (shouldUsePointerLock()) {
    try { dom.canvas.requestPointerLock?.(); } catch { /* браузер не поддерживает pointer lock — вращение мыши */ }
  }
}

function restartGame() {
  window.location.reload();
}

function onKeyDown(event) {
  if (['KeyW','KeyA','KeyS','KeyD','ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Space'].includes(event.code)) event.preventDefault();
  if (event.code === 'Escape') {
    if (!game.started) return;
    if (game.paused) resumeGame(); else showPause();
    return;
  }
  if (event.code === 'KeyE' && !event.repeat) { doInteract(); return; }
  if ((event.code === 'KeyC' || event.code === 'ControlLeft') && !event.repeat) { toggleCrouch(); return; }
  game.keys.add(event.code);
}

function onKeyUp(event) { game.keys.delete(event.code); }

function onMouseMove(event) {
  if (document.pointerLockElement === dom.canvas) {
    game.targetYaw -= event.movementX * 0.00235;
    game.targetPitch -= event.movementY * 0.00195;
    game.targetPitch = THREE.MathUtils.clamp(game.targetPitch, -1.33, 1.2);
    return;
  }
  if (game.mouseDrag && !mobileDevice) {
    const dx = event.clientX - game.lastMouseX;
    const dy = event.clientY - game.lastMouseY;
    game.lastMouseX = event.clientX;
    game.lastMouseY = event.clientY;
    game.targetYaw -= dx * 0.004;
    game.targetPitch -= dy * 0.0034;
    game.targetPitch = THREE.MathUtils.clamp(game.targetPitch, -1.33, 1.2);
  }
}

function setupMouseLook() {
  dom.canvas.addEventListener('pointerdown', (event) => {
    if (mobileDevice || event.button !== 0 || !game.started || game.paused) return;
    if (document.pointerLockElement !== dom.canvas) {
      game.mouseDrag = true;
      game.lastMouseX = event.clientX;
      game.lastMouseY = event.clientY;
      dom.canvas.setPointerCapture?.(event.pointerId);
      if (shouldUsePointerLock()) {
        try { dom.canvas.requestPointerLock?.(); } catch { /* вращение мыши */ }
      }
    }
  });
  window.addEventListener('pointerup', () => { game.mouseDrag = false; });
  window.addEventListener('pointercancel', () => { game.mouseDrag = false; });
  window.addEventListener('pointermove', onMouseMove);
  // Safari и браузеры без поддержки: pointer lock отклоняется — падаем на drag-look.
  document.addEventListener('pointerlockerror', () => {
    game.pointerLockUnsupported = true;
    console.info('Pointer lock не поддерживается/отклонён — вращение камеры мышем.');
  });
  document.addEventListener('pointerlockchange', () => {
    if (!document.pointerLockElement && game.started && !game.paused && !game.finished && !mobileDevice) {
      game.mouseDrag = false;
    }
  });
}

function setupJoystick(element) {
  if (!element) return;
  const knob = element.querySelector('.stick-knob');
  let pointerId = null, centerX = 0, centerY = 0;
  const reset = () => {
    pointerId = null;
    element.classList.remove('active');
    if (knob) knob.style.transform = 'translate(-50%,-50%)';
    game.mobileMove = { x: 0, y: 0 };
  };
  const updateMove = (x, y) => {
    const rect = element.getBoundingClientRect();
    const max = rect.width * 0.29;
    let dx = x - centerX, dy = y - centerY;
    const mag = Math.hypot(dx, dy);
    if (mag > max) { dx *= max / mag; dy *= max / mag; }
    game.mobileMove.x = dx / max;
    game.mobileMove.y = -dy / max;
    if (knob) knob.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
  };
  element.addEventListener('pointerdown', (event) => {
    if (!mobileDevice || !game.started || game.paused || game.finished) return;
    event.preventDefault();
    pointerId = event.pointerId;
    element.setPointerCapture?.(pointerId);
    element.classList.add('active');
    const rect = element.getBoundingClientRect();
    centerX = rect.left + rect.width / 2;
    centerY = rect.top + rect.height / 2;
    updateMove(event.clientX, event.clientY);
  });
  element.addEventListener('pointermove', (event) => {
    if (pointerId !== event.pointerId || !game.started || game.paused) return;
    event.preventDefault();
    updateMove(event.clientX, event.clientY);
  });
  element.addEventListener('pointerup', (event) => { if (pointerId === event.pointerId) reset(); });
  element.addEventListener('pointercancel', (event) => { if (pointerId === event.pointerId) reset(); });
  element.addEventListener('lostpointercapture', reset);
}

function setupTouchLook(surface) {
  if (!surface) return;
  let pointerId = null, lastX = 0, lastY = 0;
  const reset = () => { pointerId = null; };
  surface.addEventListener('pointerdown', (event) => {
    if (!mobileDevice || !game.started || game.paused || game.finished) return;
    event.preventDefault();
    pointerId = event.pointerId;
    lastX = event.clientX; lastY = event.clientY;
    surface.setPointerCapture?.(pointerId);
  });
  surface.addEventListener('pointermove', (event) => {
    if (pointerId !== event.pointerId || !game.started || game.paused || game.finished) return;
    event.preventDefault();
    const dx = event.clientX - lastX, dy = event.clientY - lastY;
    game.targetYaw -= dx * 0.0068;
    game.targetPitch -= dy * 0.0052;
    game.targetPitch = THREE.MathUtils.clamp(game.targetPitch, -1.28, 1.17);
    lastX = event.clientX; lastY = event.clientY;
  });
  surface.addEventListener('pointerup', (event) => { if (pointerId === event.pointerId) reset(); });
  surface.addEventListener('pointercancel', (event) => { if (pointerId === event.pointerId) reset(); });
  surface.addEventListener('lostpointercapture', reset);
}

function updateMobileOrientation() {
  if (!mobileDevice) return;
  const portrait = window.innerHeight > window.innerWidth;
  dom.mobileControls.classList.toggle('portrait', portrait);
  dom.mobileControls.classList.toggle('landscape', !portrait);
  dom.rotateNotice?.classList.toggle('hidden', !game.started || !portrait);
}

function requestLandscapeOrientation() {
  if (!mobileDevice || window.innerWidth >= window.innerHeight) return;
  try {
    const request = screen.orientation?.lock?.('landscape');
    request?.catch?.(() => {});
  } catch { /* Some mobile browsers only allow orientation lock in fullscreen. */ }
}

function setupMobileControls() {
  if (!mobileDevice) return;
  dom.mobileControls.classList.add('mobile-device');
  setupJoystick(dom.moveStick);
  setupTouchLook(dom.lookSurface);
  updateMobileOrientation();
  window.addEventListener('resize', updateMobileOrientation);
  dom.mobileInteractButton.addEventListener('pointerdown', (event) => { event.preventDefault(); doInteract(); });
  dom.mobileCrouchButton.addEventListener('pointerdown', (event) => { event.preventDefault(); toggleCrouch(); });
  const run = (value) => { game.mobileSprint = value; dom.mobileRunButton.classList.toggle('active', value); };
  dom.mobileRunButton.addEventListener('pointerdown', (event) => { event.preventDefault(); run(true); dom.mobileRunButton.setPointerCapture?.(event.pointerId); });
  dom.mobileRunButton.addEventListener('pointerup', () => run(false));
  dom.mobileRunButton.addEventListener('pointercancel', () => run(false));
  dom.mobileRunButton.addEventListener('lostpointercapture', () => run(false));
}

function setupUI() {
  dom.startButton.addEventListener('click', startGame);
  dom.resumeButton.addEventListener('click', resumeGame);
  dom.pauseButton.addEventListener('click', showPause);
  dom.restartButton.addEventListener('click', restartGame);
  dom.retryButton.addEventListener('click', restartGame);
  dom.playAgainButton.addEventListener('click', restartGame);
  window.addEventListener('keydown', onKeyDown, { passive: false });
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', () => { game.keys.clear(); game.mobileSprint = false; game.mobileMove = { x: 0, y: 0 }; });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && game.started && !game.paused && !game.finished) showPause();
  });
  setupMouseLook();
  setupMobileControls();
  window.addEventListener('resize', onResize);
}

function onResize() {
  if (!renderer || !camera) return;
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, mobileDevice ? 1 : 1.25));
  renderer.setSize(window.innerWidth, window.innerHeight, false);
}

async function loadGrannyModel() {
  const preferred = mobileDevice ? ASSET.grannyLow : ASSET.grannyHigh;
  const fallback = mobileDevice ? ASSET.grannyHigh : ASSET.grannyLow;
  try {
    return await fbxLoader.loadAsync(preferred);
  } catch (preferredError) {
    console.warn('Основная модель Granny не загрузилась; пробуем резервную версию.', preferredError);
    return await fbxLoader.loadAsync(fallback);
  }
}

async function init() {
  document.body.classList.toggle('touch-device', mobileDevice);
  try {
    setLoadProgress(6, 'Запускаем рендерер…');
    setupRenderer();
    setLoadProgress(15, 'Загружаем найденные текстуры…');
    await loadTextures();
    buildHouse();
    setLoadProgress(31, 'Расставляем комнаты и проёмы…');

    createDoors();
    createItems();
    const propPromise = loadProps();
    const trapPromise = loadTrapModels();
    const grannyPromise = loadGrannyModel().catch((error) => { console.warn('Granny FBX fallback:', error); return null; });
    const audioPromise = loadAudioAssets().catch((error) => { console.warn('Audio preload:', error); return null; });
    setLoadProgress(55, 'Загружаем хозяйку дома…');
    const grannyAsset = await grannyPromise;
    spawnGranny(grannyAsset);
    setLoadProgress(72, 'Расставляем немного мебели…');
    await Promise.all([propPromise, trapPromise]);
    furnishHouse();
    await audioPromise;
    setLoadProgress(100, 'Готово.');
    setupUI();
    setTimeout(() => {
      dom.loading.classList.add('done');
      dom.start.classList.remove('hidden');
    }, 380);
    clock.start();
    renderLoop();
  } catch (error) {
    console.error(error);
    showError('Не удалось загрузить сцену. Откройте проект через npm run dev и убедитесь, что браузер поддерживает WebGL 2.');
  }
}

init();
