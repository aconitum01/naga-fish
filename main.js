import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { clone as skeletonClone } from 'three/addons/utils/SkeletonUtils.js';

// ----- Config -----
const FISH_COUNT = 35;
const TANK = { x: 70, y: 32, z: 34 };
const FISH_TARGET_LENGTH = 3.0;

// Tweakable orientation. lookAt() aims pivot's local -Z at velocity; this rotation
// is applied to the inner model so its head ends up pointing -Z (and the dorsal
// fin ends up at +Y). Empirically for this FBX: head at -Z, but +Y is the belly,
// so we flip 180° around Z (the head-tail axis) to put the back on top.
const FISH_FORWARD_FIX = new THREE.Euler(0, 0, Math.PI);

// ----- Renderer / Scene -----
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0a3050);
// Light fog so distant fish fade gently — keep density low or you blank the scene.
scene.fog = new THREE.Fog(0x0a3050, 80, 220);

const camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.1, 500);
camera.position.set(55, 18, 70);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.minDistance = 15;
controls.maxDistance = 200;
controls.target.set(0, 0, 0);

// ----- Lights -----
scene.add(new THREE.HemisphereLight(0x88c8ff, 0x224466, 0.7));

const sun = new THREE.DirectionalLight(0xffffff, 1.1);
sun.position.set(20, 60, 30);
scene.add(sun);

const ambient = new THREE.AmbientLight(0x4488bb, 0.4);
scene.add(ambient);

// ----- Aquarium -----
const tankGroup = new THREE.Group();
scene.add(tankGroup);

// Glass: simple translucent box (no transmission to avoid texture-unit blowup)
const glassMat = new THREE.MeshBasicMaterial({
  color: 0x88ccee,
  transparent: true,
  opacity: 0.08,
  side: THREE.BackSide, // render only inside, so we can see through
  depthWrite: false,
});
const glass = new THREE.Mesh(new THREE.BoxGeometry(TANK.x, TANK.y, TANK.z), glassMat);
tankGroup.add(glass);

// frame edges
const frame = new THREE.LineSegments(
  new THREE.EdgesGeometry(new THREE.BoxGeometry(TANK.x, TANK.y, TANK.z)),
  new THREE.LineBasicMaterial({ color: 0x88ddff, transparent: true, opacity: 0.5 })
);
tankGroup.add(frame);

// sand floor with some bumps
const sandGeo = new THREE.PlaneGeometry(TANK.x - 0.4, TANK.z - 0.4, 60, 30);
const sp = sandGeo.attributes.position;
for (let i = 0; i < sp.count; i++) {
  sp.setZ(i, (Math.sin(sp.getX(i) * 0.4) + Math.cos(sp.getY(i) * 0.5)) * 0.15);
}
sandGeo.computeVertexNormals();
const sand = new THREE.Mesh(
  sandGeo,
  new THREE.MeshLambertMaterial({ color: 0xe5d3a3 })
);
sand.rotation.x = -Math.PI / 2;
sand.position.y = -TANK.y / 2 + 0.02;
sand.receiveShadow = true;
tankGroup.add(sand);

// rocks
const rockMat = new THREE.MeshLambertMaterial({ color: 0x6a7884 });
for (let i = 0; i < 7; i++) {
  const r = 1.2 + Math.random() * 2.2;
  const rock = new THREE.Mesh(new THREE.DodecahedronGeometry(r, 0), rockMat);
  rock.position.set(
    (Math.random() - 0.5) * (TANK.x - 10),
    -TANK.y / 2 + r * 0.55,
    (Math.random() - 0.5) * (TANK.z - 10)
  );
  rock.rotation.set(Math.random() * 3, Math.random() * 3, Math.random() * 3);
  rock.castShadow = true;
  rock.receiveShadow = true;
  tankGroup.add(rock);
}

// seaweed
const seaweeds = [];
for (let i = 0; i < 14; i++) {
  const h = 5 + Math.random() * 9;
  const geo = new THREE.CylinderGeometry(0.05, 0.18, h, 6, 5, true);
  geo.translate(0, h / 2, 0); // pivot at base
  const mat = new THREE.MeshLambertMaterial({
    color: new THREE.Color().setHSL(0.32 + Math.random() * 0.05, 0.7, 0.28),
    side: THREE.DoubleSide,
  });
  const sw = new THREE.Mesh(geo, mat);
  sw.position.set(
    (Math.random() - 0.5) * (TANK.x - 4),
    -TANK.y / 2,
    (Math.random() - 0.5) * (TANK.z - 4)
  );
  sw.userData.phase = Math.random() * Math.PI * 2;
  sw.userData.amp = 0.12 + Math.random() * 0.1;
  sw.castShadow = true;
  tankGroup.add(sw);
  seaweeds.push(sw);
}

// rising bubbles
const bubbleMat = new THREE.MeshBasicMaterial({
  color: 0xffffff, transparent: true, opacity: 0.6,
});
const bubbles = [];
for (let i = 0; i < 40; i++) {
  const b = new THREE.Mesh(new THREE.SphereGeometry(0.08 + Math.random() * 0.18, 8, 6), bubbleMat);
  b.userData.speed = 4 + Math.random() * 4;
  b.userData.x = (Math.random() - 0.5) * (TANK.x - 6);
  b.userData.z = (Math.random() - 0.5) * (TANK.z - 6);
  b.userData.wobble = Math.random() * Math.PI * 2;
  b.position.set(b.userData.x, -TANK.y / 2 + Math.random() * TANK.y, b.userData.z);
  tankGroup.add(b);
  bubbles.push(b);
}

// ----- Boids -----
const boids = [];
const mixers = [];

class Boid {
  constructor(pivot, bones, mixer) {
    this.pivot = pivot;
    this.bones = bones; // { tailFront, tailBack, finL, finR }
    this.mixer = mixer;

    this.position = this.pivot.position;
    this.position.set(
      (Math.random() - 0.5) * TANK.x * 0.7,
      (Math.random() - 0.5) * TANK.y * 0.6,
      (Math.random() - 0.5) * TANK.z * 0.7
    );
    this.velocity = new THREE.Vector3(
      Math.random() - 0.5,
      (Math.random() - 0.5) * 0.25,
      Math.random() - 0.5
    ).normalize().multiplyScalar(8);
    this.acceleration = new THREE.Vector3();

    this.maxSpeed = 10 + Math.random() * 4;
    this.maxForce = 5;
    this.phase = Math.random() * Math.PI * 2;

    this._sep = new THREE.Vector3();
    this._ali = new THREE.Vector3();
    this._coh = new THREE.Vector3();
    this._diff = new THREE.Vector3();
    this._look = new THREE.Vector3();
  }

  flock(others) {
    const sepR = 3.2;
    const perceptionR = 9;
    const sep = this._sep.set(0, 0, 0);
    const ali = this._ali.set(0, 0, 0);
    const coh = this._coh.set(0, 0, 0);
    let sepN = 0, aliN = 0, cohN = 0;

    for (let i = 0; i < others.length; i++) {
      const o = others[i];
      if (o === this) continue;
      const d = this.position.distanceTo(o.position);
      if (d > 0 && d < perceptionR) {
        if (d < sepR) {
          this._diff.subVectors(this.position, o.position).divideScalar(d * d);
          sep.add(this._diff);
          sepN++;
        }
        ali.add(o.velocity);
        aliN++;
        coh.add(o.position);
        cohN++;
      }
    }

    const a = this.acceleration;
    if (sepN > 0) {
      sep.divideScalar(sepN).setLength(this.maxSpeed).sub(this.velocity).clampLength(0, this.maxForce);
      a.addScaledVector(sep, 1.6);
    }
    if (aliN > 0) {
      ali.divideScalar(aliN).setLength(this.maxSpeed).sub(this.velocity).clampLength(0, this.maxForce);
      a.addScaledVector(ali, 1.0);
    }
    if (cohN > 0) {
      coh.divideScalar(cohN).sub(this.position).setLength(this.maxSpeed).sub(this.velocity).clampLength(0, this.maxForce);
      a.addScaledVector(coh, 0.9);
    }
  }

  bounds() {
    const margin = 4.5;
    const turn = 14;
    const a = this.acceleration;
    const hx = TANK.x / 2 - margin;
    const hy = TANK.y / 2 - margin;
    const hz = TANK.z / 2 - margin;
    if (this.position.x >  hx) a.x -= turn * (this.position.x -  hx) / margin;
    if (this.position.x < -hx) a.x += turn * (-hx - this.position.x) / margin;
    if (this.position.y >  hy) a.y -= turn * (this.position.y -  hy) / margin;
    if (this.position.y < -hy) a.y += turn * (-hy - this.position.y) / margin;
    if (this.position.z >  hz) a.z -= turn * (this.position.z -  hz) / margin;
    if (this.position.z < -hz) a.z += turn * (-hz - this.position.z) / margin;
  }

  update(dt, time) {
    this.velocity.addScaledVector(this.acceleration, dt);
    if (this.velocity.length() > this.maxSpeed) this.velocity.setLength(this.maxSpeed);
    if (this.velocity.length() < 2) this.velocity.setLength(2);
    this.position.addScaledVector(this.velocity, dt);
    this.acceleration.set(0, 0, 0);

    this._look.copy(this.position).add(this.velocity);
    this.pivot.lookAt(this._look);

    if (this.mixer) {
      // Faster fish wiggle faster.
      const sp = this.velocity.length() / this.maxSpeed;
      this.mixer.update(dt * (0.7 + sp * 1.3));
    } else {
      // Procedural fallback: wag bones around their local Z (spine perpendicular).
      const speed = this.velocity.length();
      const swimRate = 6 + 4 * (speed / this.maxSpeed);
      const wag = Math.sin(time * swimRate + this.phase);
      if (this.bones.tailFront) this.bones.tailFront.rotation.z = wag * 0.25;
      if (this.bones.tailBack)  this.bones.tailBack.rotation.z  = wag * 0.45;
      const finFlap = Math.sin(time * swimRate * 1.5 + this.phase) * 0.2;
      if (this.bones.finL) this.bones.finL.rotation.x = finFlap;
      if (this.bones.finR) this.bones.finR.rotation.x = -finFlap;
    }
  }
}

// ----- Load fish -----
const loader = new FBXLoader();
loader.load(
  './260502sakana.fbx',
  (object) => {
    // FBX from Blender often includes leftover Camera/Light nodes — strip them.
    const toRemove = [];
    object.traverse((c) => {
      if (c.isCamera || (c.isLight && !c.isAmbientLight)) toRemove.push(c);
    });
    toRemove.forEach((c) => c.parent && c.parent.remove(c));

    // Replace fish materials with simple Lambert (avoids texture-unit overflow
    // some FBX materials cause and gives us full control over color).
    let baseColor = new THREE.Color(0xc8d8e8);
    object.traverse((c) => {
      if (c.isMesh || c.isSkinnedMesh) {
        const m = Array.isArray(c.material) ? c.material[0] : c.material;
        if (m && m.color) baseColor.copy(m.color);
        c.material = new THREE.MeshLambertMaterial({ color: baseColor.clone() });
        c.frustumCulled = false; // bones can move verts outside the rest bbox
      }
    });

    const clips = object.animations || [];
    console.log(`[fish] animation clips: ${clips.length}`, clips.map((c) => c.name));

    // Bbox in the FBX root's coordinate space — use this for centering/scaling.
    const box = new THREE.Box3().setFromObject(object);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z);
    const scale = FISH_TARGET_LENGTH / maxDim;
    console.log(`[fish] bbox ${size.x.toFixed(1)}x${size.y.toFixed(1)}x${size.z.toFixed(1)}, scale ${scale.toFixed(4)}`);

    // Tropical fish palette — vibrant, varied hues. Each fish picks one.
    const FISH_PALETTE = [
      0xff6b3d, // coral orange
      0xffd23f, // yellow
      0x3ec1d3, // cyan
      0x4e8cff, // blue
      0xff5d8f, // pink
      0x9b5de5, // purple
      0x6ee36a, // lime
      0xff3b3b, // red
      0xffa552, // amber
      0x00d4aa, // teal
    ];

    for (let i = 0; i < FISH_COUNT; i++) {
      // SkeletonUtils.clone duplicates skeleton + skinned mesh with proper bone wiring.
      const root = skeletonClone(object);

      // Pick a palette color, plus a small per-fish hue/lightness jitter so
      // fish that share a hue don't look identical.
      const fishColor = new THREE.Color(FISH_PALETTE[Math.floor(Math.random() * FISH_PALETTE.length)]);
      const hsl = { h: 0, s: 0, l: 0 };
      fishColor.getHSL(hsl);
      fishColor.setHSL(
        (hsl.h + (Math.random() - 0.5) * 0.04 + 1) % 1,
        hsl.s,
        Math.max(0.3, Math.min(0.75, hsl.l + (Math.random() - 0.5) * 0.15))
      );

      root.traverse((c) => {
        if ((c.isMesh || c.isSkinnedMesh) && c.material) {
          c.material = c.material.clone();
          if (c.material.color) c.material.color.copy(fishColor);
        }
      });

      // Locate bones we'll wag procedurally.
      const bones = {};
      root.traverse((c) => {
        if (c.isBone) {
          if (c.name === 'TailFront') bones.tailFront = c;
          else if (c.name === 'TailBack') bones.tailBack = c;
          else if (c.name === 'FinL') bones.finL = c;
          else if (c.name === 'FinR') bones.finR = c;
        }
      });

      // Hierarchy:
      //   pivot (lookAt aligns -Z to velocity)
      //     orient (FISH_FORWARD_FIX rotation)
      //       wrapper (recenter + uniform scale)
      //         root (FBX hierarchy with SkinnedMesh & bones)
      const wrapper = new THREE.Group();
      wrapper.scale.setScalar(scale * (0.85 + Math.random() * 0.4));
      wrapper.position.copy(center).multiplyScalar(-scale);
      wrapper.add(root);

      const orient = new THREE.Group();
      orient.rotation.copy(FISH_FORWARD_FIX);
      orient.add(wrapper);

      const pivot = new THREE.Group();
      pivot.add(orient);
      tankGroup.add(pivot);

      // AnimationMixer — play first clip if present, otherwise we'll use procedural wag.
      let mixer = null;
      if (clips.length > 0) {
        mixer = new THREE.AnimationMixer(root);
        const action = mixer.clipAction(clips[0]);
        action.timeScale = 0.8 + Math.random() * 0.5;
        action.time = Math.random() * (clips[0].duration || 1);
        action.play();
      }

      const boid = new Boid(pivot, bones, mixer);
      boids.push(boid);
      if (mixer) mixers.push(mixer);
    }

    document.getElementById('loading').classList.add('hidden');
  },
  (xhr) => {
    if (xhr.lengthComputable) {
      const pct = ((xhr.loaded / xhr.total) * 100).toFixed(0);
      document.getElementById('loading').textContent = `Loading fish model... ${pct}%`;
    }
  },
  (err) => {
    console.error('FBX load error:', err);
    document.getElementById('loading').textContent = 'Failed to load fish model.';
  }
);

// ----- Resize -----
addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

// ----- Loop -----
const clock = new THREE.Clock();
function animate() {
  const dt = Math.min(clock.getDelta(), 0.05);
  const t = clock.elapsedTime;

  for (let i = 0; i < boids.length; i++) boids[i].flock(boids);
  for (let i = 0; i < boids.length; i++) {
    boids[i].bounds();
    boids[i].update(dt, t);
  }

  for (const sw of seaweeds) {
    sw.rotation.x = Math.sin(t * 1.4 + sw.userData.phase) * sw.userData.amp;
    sw.rotation.z = Math.cos(t * 1.1 + sw.userData.phase) * sw.userData.amp * 0.8;
  }

  for (const b of bubbles) {
    b.position.y += b.userData.speed * dt;
    b.userData.wobble += dt * 3;
    b.position.x = b.userData.x + Math.sin(b.userData.wobble) * 0.4;
    b.position.z = b.userData.z + Math.cos(b.userData.wobble * 0.7) * 0.4;
    if (b.position.y > TANK.y / 2 - 0.5) {
      b.position.y = -TANK.y / 2 + 0.5;
      b.userData.x = (Math.random() - 0.5) * (TANK.x - 6);
      b.userData.z = (Math.random() - 0.5) * (TANK.z - 6);
    }
  }

  controls.update();
  renderer.render(scene, camera);
  requestAnimationFrame(animate);
}
animate();
