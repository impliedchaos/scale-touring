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
const D_BAND = 0.04, D_RAMP = 0.4; // depth mode: no blur within 4% of the subject's distance, full by 44% off
const SAT = 0.28;    // extra saturation at full strength
const CONTRAST = 0.08;

// One direction of a 9-tap gaussian whose width depends on distance from the band. Run twice (across, then down).
const blurShader = (last) => ({
  uniforms: {
    tDiffuse: { value: null },
    dir: { value: new THREE.Vector2() },   // one pixel along the blur direction, in uv
    focus: { value: 0.5 },                 // uv y of the band's centre (screen-position mode)
    tDepth: { value: null },               // the scene's depth, drawn with the colour
    focusZ: { value: 100 },                // view-space distance of the subject, metres
    depthMix: { value: 1 },                // 1 = blur by depth, 0 = by screen height (the old look)
    near: { value: 0.3 }, far: { value: 6000 },
    amount: { value: 0 },                  // tap spacing in pixels at full blur (0 = off)
    sat: { value: 0 }, contrast: { value: 0 },
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform vec2 dir;
    uniform sampler2D tDepth;
    uniform float focus, amount, sat, contrast, focusZ, depthMix, near, far;
    varying vec2 vUv;
    #include <packing>
    // clamped like the screen would, so lamps and glints brighter than white don't bleed into halos when blurred,
    // and any NaN a shader let slip (the screen shows those as black) counts as black instead of smearing into arcs
    // (a bool mix selects; a float one would multiply the NaN by 0 and keep it)
    vec4 T(vec2 p) { vec4 c = texture2D(tDiffuse, p); return clamp(mix(c, vec4(0.0), isnan(c)), 0.0, 1.0); }
    void main() {
      float kScreen = smoothstep(${BAND.toFixed(3)}, ${(BAND + RAMP).toFixed(3)}, abs(vUv.y - focus));
      // by depth: blur grows with how far this pixel's distance is from the subject's, in proportion (a thin lens:
      // |1/z - 1/focusZ| scaled by focusZ), so things twice as far or half as near are equally out of focus
      float z = -perspectiveDepthToViewZ(texture2D(tDepth, vUv).x, near, far);
      float kDepth = smoothstep(${D_BAND.toFixed(3)}, ${D_RAMP.toFixed(3)}, abs(1.0 - focusZ / z));
      float k = mix(kScreen, kDepth, depthMix);
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
  /** `byDepth` false = the old look: blur by screen height only. */
  constructor(renderer, scene, camera, { byDepth = true } = {}) {
    this.byDepth = byDepth;
    this.renderer = renderer; this.camera = camera;
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    // The scene is drawn into its own multisampled target (or we'd lose the antialiasing the renderer gives us when drawing
    // straight to the screen) that keeps its depth in a texture. It's separate from the composer's buffers because the
    // second blur pass writes to the buffer the first one read, so depth stored there would be sampled while being drawn to.
    this.scene = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType, samples: 4 });
    this.scene.depthTexture = new THREE.DepthTexture(size.x, size.y);
    this.composer = new EffectComposer(renderer, new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType }));
    this.across = new ShaderPass(blurShader(false), 'none'); // reads the scene target directly, not the composer's buffer
    this.down = new ShaderPass(blurShader(true));
    const draw = new RenderPass(scene, camera);
    const drawIt = draw.render.bind(draw);
    draw.render = (r, w, read, ...rest) => drawIt(r, w, this.scene, ...rest);
    draw.needsSwap = false;
    this.composer.addPass(draw);
    this.composer.addPass(this.across);
    this.composer.addPass(this.down);
    this.composer.addPass(new OutputPass()); // tone mapping + sRGB, as the renderer does on its own
    this.focus = 0.5; this.focusZ = 100; this.strength = 0; this.first = true;
    this._v = new THREE.Vector3();
    this.resize();
    addEventListener('resize', () => this.resize());
  }

  resize() {
    this.composer.setPixelRatio(this.renderer.getPixelRatio());
    this.composer.setSize(innerWidth, innerHeight);
    const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    this.scene.setSize(size.x, size.y);
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
    this.camera.updateMatrixWorld();
    const zf = Math.max(-this._v.copy(focus).applyMatrix4(this.camera.matrixWorldInverse).z, 1);
    this.focusZ += (zf - this.focusZ) * e;
    for (const pass of [this.across, this.down]) {
      const u = pass.uniforms;
      u.tDepth.value = this.scene.depthTexture;
      u.focus.value = this.focus;
      u.focusZ.value = this.focusZ;
      u.depthMix.value = this.byDepth ? 1 : 0;
      u.near.value = this.camera.near; u.far.value = this.camera.far;
      u.amount.value = BLUR * this.px * this.strength;
      u.sat.value = SAT * this.strength;
      u.contrast.value = CONTRAST * this.strength;
    }
    this.across.uniforms.tDiffuse.value = this.scene.texture;
    this.composer.render(dt);
  }
}
