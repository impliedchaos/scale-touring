// Fake volumetric headlight beams: an additive cone per headlight, brightest at the lamp, fading along the beam and
// toward its silhouette (so it never shows a hard edge), with its own fog. Strength comes from the weather (thick in
// fog, a faint haze on a clear night, nothing by day) times how open the lights are (the 86's pop-ups).
// Also exposes the beams in world space so rain can sparkle where it falls through them (weather.js).
import * as THREE from 'three';

const vertexShader = /* glsl */ `
  uniform float len;
  uniform vec3 carPos, carUp;
  varying float vT;
  varying float vH;
  varying float vFacing;
  varying float vDepth;
  void main() {
    vT = clamp(-position.y / len, 0.0, 1.0);               // 0 at the lamp, 1 at the far end
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vec3 n = normalize(normalMatrix * normal);
    vFacing = abs(dot(n, normalize(-mv.xyz)));             // 1 = looking straight through the cone wall
    vDepth = -mv.z;
    vH = dot((modelMatrix * vec4(position, 1.0)).xyz - carPos, carUp); // height above the road under the car
    gl_Position = projectionMatrix * mv;
  }`;

const fragmentShader = /* glsl */ `
  uniform vec3 color;
  uniform float strength;
  uniform float fogDensity;
  varying float vT;
  varying float vFacing;
  varying float vDepth;
  varying float vH;
  void main() {
    // (clamped: with antialiasing the GPU can evaluate just outside the triangle, where vT is a hair past 1, and
    // pow() of a negative is NaN, which draws as dotted arcs at the cone's far end and lines along its edges)
    float along = pow(max(1.0 - vT, 0.0), 2.4) * smoothstep(0.0, 0.006, vT);  // brightest at the lamp, gone by the end
    float edge = pow(clamp(vFacing, 0.0, 1.0), 3.0);                           // soft silhouette
    float fog = exp(-fogDensity * fogDensity * vDepth * vDepth);
    // fade out just above the road: the cone dips into it, and a hard cut-off there draws bright/dark arches
    float ground = smoothstep(0.0, 0.5, vH);
    gl_FragColor = vec4(color * strength * along * edge * fog * ground, 1.0);
    // Tuned by eye straight onto the screen. Drawn into a linear target instead (post-processing, e.g. the fly-by's
    // tilt-shift), the final pass sRGB-encodes everything, which would make the beams far too bright: undo that here.
    gl_FragColor = max(gl_FragColor, 0.0);
    if (linearToOutputTexel(vec4(0.5)).r < 0.51) gl_FragColor = sRGBTransferEOTF(gl_FragColor);
  }`;

const glowVertex = /* glsl */ `
  varying vec2 vUv;
  varying float vFacing;
  varying float vDepth;
  void main() {
    vUv = uv;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vFacing = max(dot(normalize(normalMatrix * normal), normalize(-mv.xyz)), 0.0); // 1 = looking into the lamp
    vDepth = -mv.z;
    gl_Position = projectionMatrix * mv;
  }`;

const glowFragment = /* glsl */ `
  uniform vec3 color;
  uniform float strength;
  uniform float fogDensity;
  varying vec2 vUv;
  varying float vFacing;
  varying float vDepth;
  void main() {
    float d2 = dot(vUv - 0.5, vUv - 0.5) * 4.0;                   // 0 at the centre, 1 at the edge
    float glow = (exp(-d2 * 40.0) + 0.3 * exp(-d2 * 7.0)) * smoothstep(1.0, 0.6, d2);
    float fog = exp(-fogDensity * fogDensity * vDepth * vDepth * 0.5);
    gl_FragColor = vec4(color * strength * glow * pow(vFacing, 1.5) * fog, 1.0);
    gl_FragColor = max(gl_FragColor, 0.0);
    if (linearToOutputTexel(vec4(0.5)).r < 0.51) gl_FragColor = sRGBTransferEOTF(gl_FragColor); // see the beam shader
  }`;

/** An open, flared tube along -y from the lamp: a disc of radius r at the origin, widening to an ellipse `wide` × `tall`
 *  (half-axes, m) at `length`. Once the beam is aimed down the road, local x is across and local z is up. */
function beamGeometry(r, length, wide, tall) {
  const geo = new THREE.CylinderGeometry(1, 1, length, 32, 8, true).translate(0, -length / 2, 0);
  const p = geo.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const t = -p.getY(i) / length;
    p.setX(i, p.getX(i) * (r + (wide - r) * t));
    p.setZ(i, p.getZ(i) * (r + (tall - r) * t));
  }
  geo.computeVertexNormals();
  return geo;
}

export class Beams {
  /**
   * parent: the car's root. lamps: [{ pos, target, r }] in the parent's space (the headlight spots; r: lamp radius, m).
   * strength: how visible the air is (0 = no beams). length (m) of the visible beam, and its half-angle (rad) across
   * (`angle`) and up/down (`tall`): a flat fan, not a round cone. Each beam follows its lamp's aim (car.js: straight
   * ahead, dipped a little).
   */
  constructor(parent, lamps, { strength = 0.1, length = 26, angle = 0.26, tall = 0.15, color = 0xfff0d0 } = {}) {
    this.parent = parent;
    this.strength = strength;
    this.open = 1;
    this.length = length;
    this.cosAngle = Math.cos(angle); // (rain sparkle treats it as round)
    this.material = new THREE.ShaderMaterial({
      uniforms: { color: { value: new THREE.Color(color) }, strength: { value: 0 }, fogDensity: { value: 0 }, len: { value: length },
        carPos: { value: new THREE.Vector3() }, carUp: { value: new THREE.Vector3(0, 1, 0) } },
      vertexShader, fragmentShader,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    });
    // the lamp itself, seen from in front: a soft glow on its face, so the beam visibly comes out of it
    this.glowMaterial = new THREE.ShaderMaterial({
      uniforms: { color: { value: new THREE.Color(color) }, strength: { value: 0 }, fogDensity: { value: 0 } },
      vertexShader: glowVertex, fragmentShader: glowFragment,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    this.lamps = lamps.map(({ pos, target, r = 0.08 }) => {
      const dir = target.clone().sub(pos).normalize();
      const mesh = new THREE.Mesh(beamGeometry(r, length, Math.tan(angle) * length, Math.tan(tall) * length), this.material);
      mesh.position.copy(pos);
      mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, -1, 0), dir);
      mesh.renderOrder = 3;
      mesh.frustumCulled = false;
      const size = THREE.MathUtils.clamp(r * 8, 0.5, 0.9);
      const glow = new THREE.Mesh(new THREE.PlaneGeometry(size, size), this.glowMaterial);
      glow.position.copy(pos).addScaledVector(dir, 0.03);
      glow.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir); // faces down the beam: unseen from behind
      glow.renderOrder = 4;
      parent.add(mesh, glow);
      return { mesh, glow, pos: pos.clone(), dir, wpos: new THREE.Vector3(), wdir: new THREE.Vector3() };
    });
    this.set(1);
  }

  /** open: 0..1 (pop-ups / lights on) */
  set(open) {
    this.open = open;
    const k = this.strength * open * open;
    this.material.uniforms.strength.value = k;
    // the glow is the lamp, not the air: there on any night, a bit bigger and brighter in thick air
    const g = (0.55 + this.strength * 2.5) * open * open;
    this.glowMaterial.uniforms.strength.value = g;
    for (const l of this.lamps) { l.mesh.visible = k > 0.002; l.glow.visible = g > 0.01; }
  }

  /** before rendering (after the car is posed): fog to match the scene, and where the road is */
  update(fog) {
    const u = this.material.uniforms, m = this.parent.matrix;
    u.fogDensity.value = this.glowMaterial.uniforms.fogDensity.value = fog?.density ?? 0;
    u.carPos.value.setFromMatrixPosition(m);
    u.carUp.value.setFromMatrixColumn(m, 1).normalize();
  }

  /** world-space lamps for rain sparkle: [{ pos, dir }] plus length, cosAngle, level */
  world() {
    const m = this.parent.matrix;
    for (const l of this.lamps) {
      l.wpos.copy(l.pos).applyMatrix4(m);
      l.wdir.copy(l.dir).transformDirection(m);
    }
    return this.lamps;
  }

  get level() { return this.strength * this.open * this.open; }
}

/** How visible headlight beams are in each weather (0 = none). */
export function beamStrength(weather, day) {
  if (day) return 0;
  if (weather.fog) return 0.2;
  if (weather.rain) return 0.12;
  if (weather.wet) return 0.045;
  return 0.03;
}
