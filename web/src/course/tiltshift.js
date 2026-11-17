// Tilt-shift "miniature" look for the drone views: a horizontal band of the screen stays sharp, everything above and
// below it blurs more the further it is from the band, and the colours get a toy-like push. The band sits on whatever
// the camera is looking at (projected to the screen each frame), and the whole effect fades with `strength`
// (the fly-by ties it to how high the drone is: tilt-shift at road level just looks out of focus).
import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';

const BAND = 0.07;   // half height of the sharp band, as a fraction of the screen
const RAMP = 0.32;   // ...then the blur grows to full over this much more
const BLUR = 3.2;    // full blur: spacing between the 9 taps, in pixels at 1080p (scaled to the screen)
const SAT = 0.28;    // extra saturation at full strength
const CONTRAST = 0.08;

// One direction of a 9-tap gaussian whose width depends on distance from the band. Run twice (across, then down).
const blurShader = (last) => ({
  uniforms: {
    tDiffuse: { value: null },
    dir: { value: new THREE.Vector2() },   // one pixel along the blur direction, in uv
    focus: { value: 0.5 },                 // uv y of the band's centre
    amount: { value: 0 },                  // tap spacing in pixels at full blur (0 = off)
    sat: { value: 0 }, contrast: { value: 0 },
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform vec2 dir;
    uniform float focus, amount, sat, contrast;
    varying vec2 vUv;
    // clamped like the screen would, so lamps and glints brighter than white don't bleed into halos when blurred,
    // and any NaN a shader let slip (the screen shows those as black) counts as black instead of smearing into arcs
    // (a bool mix selects; a float one would multiply the NaN by 0 and keep it)
    vec4 T(vec2 p) { vec4 c = texture2D(tDiffuse, p); return clamp(mix(c, vec4(0.0), isnan(c)), 0.0, 1.0); }
    void main() {
      float k = smoothstep(${BAND.toFixed(3)}, ${(BAND + RAMP).toFixed(3)}, abs(vUv.y - focus));
      vec2 d = dir * amount * k * k;
      vec4 c = T(vUv) * 0.1633;
      c += (T(vUv - d) + T(vUv + d)) * 0.1531;
      c += (T(vUv - 2.0 * d) + T(vUv + 2.0 * d)) * 0.12245;
      c += (T(vUv - 3.0 * d) + T(vUv + 3.0 * d)) * 0.0918;
      c += (T(vUv - 4.0 * d) + T(vUv + 4.0 * d)) * 0.051;
      ${last ? `
      float l = dot(c.rgb, vec3(0.2126, 0.7152, 0.0722));
      c.rgb = max(mix(vec3(l), c.rgb, 1.0 + sat), 0.0);
      c.rgb = pow(c.rgb, vec3(1.0 + contrast));   // a touch more contrast (darks deepen, brights hold)` : ''}
      gl_FragColor = c;
    }`,
});

export class TiltShift {
  constructor(renderer, scene, camera) {
    this.renderer = renderer; this.camera = camera;
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    // multisampled, or we'd lose the antialiasing the renderer gives us when drawing straight to the screen
    const target = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType, samples: 4 });
    this.composer = new EffectComposer(renderer, target);
    this.across = new ShaderPass(blurShader(false));
    this.down = new ShaderPass(blurShader(true));
    this.composer.addPass(new RenderPass(scene, camera));
    this.composer.addPass(this.across);
    this.composer.addPass(this.down);
    this.composer.addPass(new OutputPass()); // tone mapping + sRGB, as the renderer does on its own
    this.focus = 0.5; this.strength = 0; this.first = true;
    this._v = new THREE.Vector3();
    this.resize();
    addEventListener('resize', () => this.resize());
  }

  resize() {
    this.composer.setPixelRatio(this.renderer.getPixelRatio());
    this.composer.setSize(innerWidth, innerHeight);
    const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    this.px = size.y / 1080; // blur in screen proportion, whatever the resolution
    this.across.uniforms.dir.value.set(1 / size.x, 0);
    this.down.uniforms.dir.value.set(0, 1 / size.y);
  }

  /** Draw the frame: sharp around world point `focus`, effect at `strength` 0..1. */
  render(focus, strength, dt) {
    const v = this._v.copy(focus).project(this.camera);
    const y = THREE.MathUtils.clamp(v.z < 1 ? (v.y + 1) / 2 : 0.5, 0.1, 0.9);
    const e = this.first ? 1 : Math.min(1, dt * 3); // eased, so the band doesn't twitch with the camera
    this.focus += (y - this.focus) * e;
    this.strength += (strength - this.strength) * e;
    this.first = false;
    for (const pass of [this.across, this.down]) {
      const u = pass.uniforms;
      u.focus.value = this.focus;
      u.amount.value = BLUR * this.px * this.strength;
      u.sat.value = SAT * this.strength;
      u.contrast.value = CONTRAST * this.strength;
    }
    this.composer.render(dt);
  }
}
