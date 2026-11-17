// Tire smoke and skid marks.
import * as THREE from 'three';

// Defaults are tire smoke; override for other particles (see SPARKS).
const SMOKE = { size0: [0.7, 1.2], grow: 5.5, life: [1.6, 2.8], lift: [0.6, 1.8], spread: 2.5, alpha: 0.35,
                drag: 1.6, gravity: 0, inherit: 0.12, jitter: 0.3, rise: 0.25, additive: false };
export const SPARKS = { size0: [0.08, 0.16], grow: 0, life: [0.25, 0.5], lift: [1, 3], spread: 7, alpha: 1,
                        drag: 0.6, gravity: 9, inherit: 0.9, jitter: 0.05, rise: 0, additive: true };

export class Smoke {
  constructor(scene, { max = 900, color = 0x8a909c, ...opts } = {}) {
    this.max = max;
    this.o = { ...SMOKE, ...opts };
    this.parts = [];
    const geo = new THREE.BufferGeometry();
    this.pos = new Float32Array(max * 3);
    this.size = new Float32Array(max);
    this.alpha = new Float32Array(max);
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    geo.setAttribute('size', new THREE.BufferAttribute(this.size, 1));
    geo.setAttribute('alpha', new THREE.BufferAttribute(this.alpha, 1));
    this.material = new THREE.ShaderMaterial({
      uniforms: { color: { value: new THREE.Color(color) }, scale: { value: 500 }, fogDensity: { value: 0 } },
      vertexShader: /* glsl */ `
        attribute float size; attribute float alpha;
        uniform float scale; uniform float fogDensity;
        varying float vAlpha;
        void main() {
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mv;
          float d = -mv.z;
          gl_PointSize = size * scale / max(d, 0.1);
          vAlpha = alpha * exp(-fogDensity * fogDensity * d * d);
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 color; varying float vAlpha;
        void main() {
          float r = length(gl_PointCoord - 0.5);
          if (r > 0.5) discard;
          gl_FragColor = vec4(color, smoothstep(0.5, 0.0, r) * vAlpha);
        }`,
      transparent: true,
      depthWrite: false,
      blending: this.o.additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    this.points = new THREE.Points(geo, this.material);
    this.points.frustumCulled = false;
    scene.add(this.points);
  }

  emit(p, vel, strength = 1) {
    if (this.parts.length >= this.max) this.parts.shift();
    const o = this.o, r = () => Math.random() - 0.5, rng = ([a, b]) => a + Math.random() * (b - a);
    this.parts.push({
      p: p.clone().add(new THREE.Vector3(r() * o.jitter, o.rise, r() * o.jitter)),
      v: vel.clone().multiplyScalar(o.inherit).add(new THREE.Vector3(r() * o.spread, rng(o.lift), r() * o.spread)),
      age: 0, life: rng(o.life), s0: rng(o.size0), a: o.alpha * strength,
    });
  }

  update(dt, camera, renderer, fog) {
    let n = 0;
    this.parts = this.parts.filter((q) => (q.age += dt) < q.life);
    for (const q of this.parts) {
      q.v.multiplyScalar(Math.exp(-dt * this.o.drag));
      q.v.y -= this.o.gravity * dt;
      q.p.addScaledVector(q.v, dt);
      const t = q.age / q.life;
      this.pos.set([q.p.x, q.p.y, q.p.z], n * 3);
      this.size[n] = q.s0 + t * this.o.grow;
      this.alpha[n] = q.a * Math.min(1, t * 10) * (1 - t) ** 1.5;
      n++;
    }
    const geo = this.points.geometry;
    geo.setDrawRange(0, n);
    this.points.visible = n > 0; // drawing zero points still costs a draw call (and a GL warning)
    for (const k of ['position', 'size', 'alpha']) geo.attributes[k].needsUpdate = true;
    const h = renderer.domElement.height;
    this.material.uniforms.scale.value = h / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));
    this.material.uniforms.fogDensity.value = fog?.density ?? 0;
  }
}

export class SkidMarks {
  constructor(scene, { maxSegments = 6000, width = 0.22 } = {}) {
    this.max = maxSegments;
    this.width = width;
    this.pos = new Float32Array(maxSegments * 18);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    geo.setDrawRange(0, 0);
    this.mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
      color: 0x0c0c0e, transparent: true, opacity: 0.55, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, side: THREE.DoubleSide,
    }));
    this.mesh.frustumCulled = false;
    this.mesh.visible = false; // until the first mark
    scene.add(this.mesh);
    this.next = 0;
    this.count = 0;
    this.last = new Map();
  }

  /** Extend the mark for track `id` (e.g. a wheel) to point p; call lift(id) when the tire stops sliding. */
  add(id, p) {
    const last = this.last.get(id);
    this.last.set(id, p.clone());
    if (!last) return;
    const dx = p.x - last.x, dz = p.z - last.z, len = Math.hypot(dx, dz);
    if (len < 1e-3 || len > 5) return;
    const rx = (-dz / len) * this.width / 2, rz = (dx / len) * this.width / 2;
    const y0 = last.y + 0.02, y1 = p.y + 0.02;
    this.pos.set([
      last.x - rx, y0, last.z - rz, last.x + rx, y0, last.z + rz, p.x - rx, y1, p.z - rz,
      last.x + rx, y0, last.z + rz, p.x + rx, y1, p.z + rz, p.x - rx, y1, p.z - rz,
    ], this.next * 18);
    this.next = (this.next + 1) % this.max;
    this.count = Math.min(this.count + 1, this.max);
    this.mesh.geometry.setDrawRange(0, this.count * 6);
    this.mesh.visible = this.count > 0;
    this.mesh.geometry.attributes.position.needsUpdate = true;
  }

  lift(id) { this.last.delete(id); }
}
