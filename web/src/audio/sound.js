// All game audio: mixer, synthesized voices (engines, screech, grind, wind), one-shots, music.
// Everything is generated live with Web Audio; no sample files (music aside).
//
//   master ── compressor ── speakers
//     ├─ sfx bus ── engine (86), screech, grind, wind, fx (one-shots)
//     │             rival panner (3D) ── rival engine, rival screech, blow-off valve
//     └─ music bus ── duck ── <audio> element
import { EngineCore, ENGINE_PARAM_NAMES } from './engine-core.js';

const clamp = (x, a, b) => Math.min(b, Math.max(a, x));

// ---------------------------------------------------------------- engine voice

export async function installEngineWorklet(ctx) {
  if (!ctx.audioWorklet || typeof AudioWorkletNode === 'undefined') return false; // insecure context, old browser
  const defaults = new EngineCore(48000).p;
  const src = `
    const EngineCore = ${EngineCore.toString()};
    class GmaEngine extends AudioWorkletProcessor {
      static get parameterDescriptors() {
        return ${JSON.stringify(ENGINE_PARAM_NAMES.map((name) => ({ name, defaultValue: defaults[name], automationRate: 'k-rate' })))};
      }
      constructor(opts) { super(); this.core = new EngineCore(sampleRate, opts.processorOptions && opts.processorOptions.pattern); }
      process(inputs, outputs, params) {
        const out = outputs[0][0];
        if (!out) return true;
        for (const k in params) this.core.p[k] = params[k][0];
        this.core.process(out);
        return true;
      }
    }
    registerProcessor('gma-engine', GmaEngine);`;
  try {
    const url = URL.createObjectURL(new Blob([src], { type: 'application/javascript' }));
    // never let audio init hang on a worklet that won't load: fall back after 3 s
    const timeout = new Promise((_, no) => setTimeout(() => no(new Error('addModule timed out')), 3000));
    await Promise.race([ctx.audioWorklet.addModule(url), timeout]);
    return true;
  } catch (e) {
    console.warn('engine worklet unavailable, using ScriptProcessor fallback', e);
    return false;
  }
}

function softClipCurve(drive) {
  const n = 1024, c = new Float32Array(n), norm = Math.tanh(drive);
  for (let i = 0; i < n; i++) { const x = (i / (n - 1)) * 2 - 1; c[i] = Math.tanh(drive * x) / norm; }
  return c;
}

function loopNoise(ctx, noise) {
  const s = ctx.createBufferSource();
  s.buffer = noise;
  s.loop = true;
  s.start(0, Math.random() * noise.duration);
  return s;
}

const filter = (ctx, type, f, q = 1) => { const b = ctx.createBiquadFilter(); b.type = type; b.frequency.value = f; b.Q.value = q; return b; };
const gain = (ctx, g = 1) => { const n = ctx.createGain(); n.gain.value = g; return n; };

export class EngineVoice {
  constructor(ctx, dest, noise, { worklet, firings = 2, pattern, turbo = false } = {}) {
    this.ctx = ctx;
    if (worklet) {
      this.node = new AudioWorkletNode(ctx, 'gma-engine', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [1], processorOptions: { pattern } });
    } else {
      this.core = new EngineCore(ctx.sampleRate, pattern);
      this.node = ctx.createScriptProcessor(1024, 1, 1);
      this.node.onaudioprocess = (e) => this.core.process(e.outputBuffer.getChannelData(0));
    }
    this.set('firingsPerRev', firings);
    this.shaper = ctx.createWaveShaper();
    this.shaper.oversample = '2x';
    this.lp = filter(ctx, 'lowpass', 1500, 0.9);
    this.body = filter(ctx, 'peaking', 120, 1);
    this.out = gain(ctx, 0);
    this.node.connect(this.shaper).connect(this.lp).connect(this.body).connect(this.out).connect(dest);
    // intake roar
    this.intakeBp = filter(ctx, 'bandpass', 900, 1.2);
    this.intakeGain = gain(ctx, 0);
    loopNoise(ctx, noise).connect(this.intakeBp).connect(this.intakeGain).connect(this.out);
    // turbo whistle
    if (turbo) {
      this.turbo = ctx.createOscillator();
      this.turbo.type = 'sine';
      this.turboGain = gain(ctx, 0);
      this.turbo.connect(this.turboGain).connect(this.out);
      this.turbo.start();
      this.spool = 0;
    }
    this.e = null;
    this.level = 1;
  }

  set(name, v) {
    if (this.core) this.core.p[name] = v;
    else this.node.parameters.get(name).value = v;
  }

  setTimbre(e) {
    this.e = e;
    for (const k of ['decay', 'resonance', 'resTrack', 'rough', 'jitter', 'noise', 'uneven', 'pops']) if (k in e) this.set(k, e[k]);
    if (this._grit !== e.grit) { this._grit = e.grit; this.shaper.curve = softClipCurve(e.grit); }
    this.body.gain.value = e.body ?? 0;
  }

  /** level: extra multiplier (e.g. 0 to silence the rival before the race). */
  update(rpm, load, dt, level = 1) {
    const e = this.e, t = this.ctx.currentTime;
    this.set('rpm', rpm);
    this.set('load', load);
    this.lp.frequency.setTargetAtTime(clamp(e.tone + load * e.toneOpen + rpm * 0.25, 80, 16000), t, 0.03);
    this.intakeBp.frequency.setTargetAtTime(500 + rpm * 0.18, t, 0.05);
    this.intakeGain.gain.setTargetAtTime((e.intake ?? 0) * load * Math.min(rpm / 7000, 1.2), t, 0.05);
    this.out.gain.setTargetAtTime(e.volume * level, t, level === 0 ? 0.35 : 0.05); // slow fade when it dies
    if (this.turbo) {
      this.spool += (load * Math.min(rpm / 6500, 1) - this.spool) * Math.min(1, dt * (load > this.spool ? 1.5 : 4)); // lag
      this.turbo.frequency.setTargetAtTime(1800 + this.spool * 3600, t, 0.05);
      this.turboGain.gain.setTargetAtTime((e.turbo ?? 0) * this.spool, t, 0.05);
    }
  }
}

// ---------------------------------------------------------------- continuous effects

class Screech {
  constructor(ctx, dest, noise) {
    this.ctx = ctx;
    const src = loopNoise(ctx, noise);
    this.bp1 = filter(ctx, 'bandpass', 1300, 18);
    this.bp2 = filter(ctx, 'bandpass', 1900, 18);
    this.tone = gain(ctx, 4);
    this.scrub = gain(ctx, 0.25);
    this.out = gain(ctx, 0);
    src.connect(this.bp1).connect(this.tone);
    src.connect(this.bp2).connect(this.tone);
    src.connect(filter(ctx, 'lowpass', 700, 0.7)).connect(this.scrub);
    this.tone.connect(this.out);
    this.scrub.connect(this.out);
    this.out.connect(dest);
    this.wob = 0; this.wobV = 0;
  }
  update(amount, s, dt) {
    const t = this.ctx.currentTime;
    this.wobV += (Math.random() * 2 - 1) * dt * 40;      // random-walk pitch wobble
    this.wobV *= Math.exp(-dt * 6);
    this.wob = (this.wob + this.wobV * dt) * Math.exp(-dt * 2);
    const f = s.pitch * (1 + s.wobble * Math.tanh(this.wob * 3)) * (0.9 + 0.2 * amount);
    this.bp1.frequency.setTargetAtTime(f, t, 0.02);
    this.bp2.frequency.setTargetAtTime(f * 1.47, t, 0.02);
    this.bp1.Q.value = this.bp2.Q.value = s.q;
    this.tone.gain.value = Math.sqrt(s.q) * 1.2;        // narrow bandpass of noise is quiet: make up the level
    this.scrub.gain.value = s.scrub;
    this.out.gain.setTargetAtTime(s.volume * amount, t, 0.04);
  }
}

class Grind {
  constructor(ctx, dest, noise) {
    this.ctx = ctx;
    const src = loopNoise(ctx, noise);
    this.bps = [1, 1.62, 2.43].map((m) => { const b = filter(ctx, 'bandpass', 2100 * m, 25); b.mult = m; return b; });
    this.ring = gain(ctx, 3);
    this.rumble = gain(ctx, 0.5);
    this.am = gain(ctx, 1);
    this.out = gain(ctx, 0);
    for (const b of this.bps) src.connect(b).connect(this.ring);
    src.connect(filter(ctx, 'lowpass', 260, 0.8)).connect(this.rumble);
    this.ring.connect(this.am);
    this.rumble.connect(this.am);
    this.am.connect(this.out).connect(dest);
  }
  update(amount, s, pitchMul = 1) {
    const t = this.ctx.currentTime;
    for (const b of this.bps) { b.frequency.setTargetAtTime(s.pitch * pitchMul * b.mult, t, 0.03); b.Q.value = s.ring; }
    this.ring.gain.value = Math.sqrt(s.ring) * 0.9;
    this.rumble.gain.value = s.rumble;
    this.am.gain.setTargetAtTime(1 - s.crackle * Math.random() * 0.85, t, 0.005); // crunchy amplitude chatter
    this.out.gain.setTargetAtTime(s.volume * amount, t, 0.03);
  }
}

class Wind {
  constructor(ctx, dest, noise) {
    this.ctx = ctx;
    this.lp = filter(ctx, 'lowpass', 300, 0.5);
    this.out = gain(ctx, 0);
    loopNoise(ctx, noise).connect(this.lp).connect(this.out).connect(dest);
  }
  update(speed01, air, s) {
    const t = this.ctx.currentTime;
    this.lp.frequency.setTargetAtTime(250 + 2200 * speed01 + (air ? 800 : 0), t, 0.1);
    this.out.gain.setTargetAtTime(s.volume * speed01 * speed01 * (air ? 1.6 : 1), t, 0.1);
  }
}

/** Weather bed: rain hiss + patter, and tire hiss on a wet road that rises with speed. */
class Weather {
  constructor(ctx, dest, noise) {
    this.ctx = ctx;
    this.hiss = gain(ctx, 0); this.patter = gain(ctx, 0); this.tires = gain(ctx, 0);
    loopNoise(ctx, noise).connect(filter(ctx, 'highpass', 2600, 0.5)).connect(filter(ctx, 'lowpass', 9000, 0.5)).connect(this.hiss).connect(dest);
    loopNoise(ctx, noise).connect(filter(ctx, 'bandpass', 700, 0.6)).connect(this.patter).connect(dest);
    this.tireBp = filter(ctx, 'bandpass', 1800, 0.9);
    loopNoise(ctx, noise).connect(this.tireBp).connect(this.tires).connect(dest);
  }
  update(rain, wet, speed01) {
    const t = this.ctx.currentTime;
    this.hiss.gain.setTargetAtTime(rain * 0.09, t, 0.3);
    this.patter.gain.setTargetAtTime(rain * 0.05 * (0.8 + 0.4 * Math.random()), t, 0.08);
    this.tireBp.frequency.setTargetAtTime(1200 + 2400 * speed01, t, 0.1);
    this.tires.gain.setTargetAtTime(wet * speed01 * 0.16, t, 0.1);
  }
}

// ---------------------------------------------------------------- music

class Music {
  constructor(ctx, dest, onTrack) {
    this.el = new Audio();
    this.el.preload = 'auto';
    ctx.createMediaElementSource(this.el).connect(dest);
    this.list = [];
    this.i = -1;
    this.onTrack = onTrack;
    this.announced = -1;
    this.el.addEventListener('ended', () => this.next());
    this.el.addEventListener('playing', () => {            // announce each track once, when it really starts
      if (this.announced !== this.i) { this.announced = this.i; this.onTrack?.(this.list[this.i]); }
    });
    this.loaded = fetch('music/playlist.json').then((r) => (r.ok ? r.json() : [])).catch(() => [])
      .then((list) => { this.list = Array.isArray(list) ? list : []; });
  }
  get playing() { return !this.el.paused; }
  /** Start (or retry, if autoplay blocked an earlier attempt). Resolves true if music is playing.
   *  `first`: file to open with (else random); the playlist continues in order from there. */
  async start(first) {
    await this.loaded;
    if (!this.list.length) return false;
    if (this.i < 0) {
      const want = this.list.findIndex((t) => t.file === first);
      this.load(want >= 0 ? want : Math.floor(Math.random() * this.list.length));
    }
    if (this.el.paused) { try { await this.el.play(); } catch { return false; } }
    return true;
  }
  pause() { this.el.pause(); }
  load(i) {
    this.i = i;
    this.el.src = `music/${this.list[i].file}`;
  }
  next() {
    if (!this.list.length) return;
    this.load((this.i + 1) % this.list.length);
    this.el.play().catch(() => {});
  }
}

// ---------------------------------------------------------------- the whole thing

const RIVAL_ENGINES = {
  ae86: { firings: 2, pattern: [1, 0.8, 0.94, 0.74] },
  r32: { firings: 3, pattern: [1, 0.92, 0.97, 0.9, 0.95, 0.88], turbo: true },
  gtr: { firings: 3, pattern: [1, 0.93, 0.96, 0.9, 0.97, 0.9], turbo: true },
  supra: { firings: 3, pattern: [1, 0.9, 0.97, 0.88, 0.95, 0.9], turbo: true },
  celica6: { firings: 2, pattern: [1, 0.85, 0.95, 0.8], turbo: true },
  celica7: { firings: 2, pattern: [1, 0.88, 0.96, 0.84], turbo: false },
  rx7: { firings: 2, pattern: [1, 0.97], turbo: true }, // two rotors, one firing each per shaft turn: even, buzzy brap

};

export class Sound {
  constructor(params, { onTrack } = {}) {
    this.weather = { rain: 0, wet: 0 }; // set by the race: 0..1 each
    this._hush = { paused: false, title: false }; // reasons the sfx bus is silent
    this.p = params;
    this.onTrack = onTrack;
    this.ctx = null;
    this.ready = false;
    this.test = null;        // panel auditions
    this.hold = {};          // panel hold-buttons: { screech, grind }
  }

  /** Must be called from a user gesture the first time (browser autoplay rules). */
  init(rivalId = 'r32') {
    if (this._init) return this._init;
    return (this._init = (async () => {
      const ctx = (this.ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' }));
      const worklet = await installEngineWorklet(ctx);
      this.worklet = worklet;
      const nb = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
      const d = nb.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      this.noise = nb;

      this.comp = ctx.createDynamicsCompressor();
      this.comp.threshold.value = -12; this.comp.knee.value = 8; this.comp.ratio.value = 4;
      this.master = gain(ctx, 0.8);
      this.master.connect(this.comp).connect(ctx.destination);
      this.sfx = gain(ctx, 0.9);
      this.sfx.connect(this.master);
      this.musicBus = gain(ctx, 0.55);
      this.duckNode = gain(ctx, 1);
      this.musicBus.connect(this.duckNode).connect(this.master);
      this.fx = gain(ctx, 0.8);
      this.fx.connect(this.sfx);

      this.engine = new EngineVoice(ctx, this.sfx, nb, { worklet, firings: 2, pattern: [1, 0.8, 0.94, 0.74] });
      this.rivalPan = ctx.createPanner();
      Object.assign(this.rivalPan, { panningModel: 'equalpower', distanceModel: 'inverse', refDistance: 8, rolloffFactor: 1, maxDistance: 2000 });
      this.rivalPan.connect(this.sfx);
      const rc = RIVAL_ENGINES[rivalId] || RIVAL_ENGINES.r32;
      this.rivalTurbo = rc.turbo;
      this.rivalEngine = new EngineVoice(ctx, this.rivalPan, nb, { worklet, ...rc });
      this.screech = new Screech(ctx, this.sfx, nb);
      this.rivalScreech = new Screech(ctx, this.rivalPan, nb);
      this.grind = new Grind(ctx, this.sfx, nb);
      this.wind = new Wind(ctx, this.sfx, nb);
      this.weatherVoice = new Weather(ctx, this.sfx, nb);
      this.music = new Music(ctx, this.musicBus, this.onTrack);
      this.lastDist = null;
      this.bovCool = 0;
      this.prevRivalLoad = 0;
      this.applyParams();
      this.ready = true;
    })());
  }

  resume() { if (this.ctx && this.ctx.state !== 'running') this.ctx.resume(); }

  /** Pause menu: fade out engines/tyres/wind (they'd hold their last note otherwise); music keeps playing. */
  set paused(on) { this._hush.paused = on; this._fadeSfx(); }
  /** Title screen: only the music (the synthesized engines, wind etc. stay silent until the race starts). */
  set titleQuiet(on) { this._hush.title = on; this._fadeSfx(); }
  _sfxLevel() { return this._hush.paused || this._hush.title ? 0 : this.p.mix.sfx; }
  _fadeSfx() {
    if (!this.ready) return; // applyParams picks it up once audio starts
    const g = this.sfx.gain, t = this.ctx.currentTime;
    g.cancelScheduledValues(t);
    g.setTargetAtTime(this._sfxLevel(), t, 0.05);
  }

  applyParams() {
    const P = this.p;
    this.master.gain.value = P.mix.master;
    this.sfx.gain.value = this._sfxLevel();
    this.musicBus.gain.value = P.mix.music;
    this.fx.gain.value = P.fx.volume;
    this.engine.setTimbre(P.engine);
    this.rivalEngine.setTimbre({ ...P.engine, ...P.rival });
  }

  set musicMuted(m) { if (this.music) this.music.el.muted = m; }
  get musicMuted() { return !!this.music?.el.muted; }

  duck(depth = 0.25, hold = 1.2, release = 0.8) {
    const g = this.duckNode.gain, t = this.ctx.currentTime;
    g.cancelScheduledValues(t);
    g.setTargetAtTime(depth, t, 0.03);
    g.setTargetAtTime(1, t + hold, release / 3);
  }

  /**
   * Per-frame update.
   * st = { camera, warping, player: { rpm, load, slip, grind, gutter, speed01, air },
   *        rival: { active, pos, rpm, load, slip } }
   */
  update(dt, st) {
    if (!this.ready) return;
    const ctx = this.ctx, P = this.p, t = ctx.currentTime;

    // listener rides the camera
    const cam = st.camera, L = ctx.listener;
    const f = cam.getWorldDirection(this._f || (this._f = cam.position.clone()));
    if (L.positionX) {
      L.positionX.value = cam.position.x; L.positionY.value = cam.position.y; L.positionZ.value = cam.position.z;
      L.forwardX.value = f.x; L.forwardY.value = f.y; L.forwardZ.value = f.z;
      L.upX.value = 0; L.upY.value = 1; L.upZ.value = 0;
    } else {
      L.setPosition(cam.position.x, cam.position.y, cam.position.z);
      L.setOrientation(f.x, f.y, f.z, 0, 1, 0);
    }

    // the 86
    let { rpm, load } = st.player;
    if (this.test?.kind === 'rev') {                        // panel: idle -> limiter -> lift (pops)
      const u = (this.test.t += dt);
      if (u < 3) { rpm = 950 + (7800 - 950) * (u / 3); load = 1; }
      else if (u < 5) { rpm = 7600 * Math.exp(-(u - 3) * 0.9) + 950; load = 0; }
      else this.test = null;
    }
    if (st.warping) rpm *= 1.5 + Math.sin(t * 31) * 0.4;   // the fourth dimension is high-rpm
    this.engine.update(rpm, load, dt, st.player.silent ? 0 : 1);
    this.screech.update(Math.max(st.player.slip, this.hold.screech ? 1 : 0), P.screech, dt);
    this.grind.update(Math.max(st.player.grind, this.hold.grind ? 1 : 0), P.grind, st.player.gutter ? 0.45 : 1);
    this.wind.update(st.player.speed01, st.player.air, P.wind);
    this.weatherVoice.update(this.weather.rain, this.weather.wet, st.player.air ? 0 : st.player.speed01);

    // the rival: positioned, with hand-rolled Doppler (Web Audio dropped its own)
    const r = st.rival;
    if (r.active) {
      const p = this.rivalPan;
      if (p.positionX) { p.positionX.value = r.pos.x; p.positionY.value = r.pos.y; p.positionZ.value = r.pos.z; }
      else p.setPosition(r.pos.x, r.pos.y, r.pos.z);
      const dist = cam.position.distanceTo(r.pos);
      const vr = this.lastDist == null || dt <= 0 ? 0 : (dist - this.lastDist) / dt;
      this.lastDist = dist;
      const doppler = clamp(343 / (343 + vr), 0.7, 1.4);
      this.rivalEngine.update(r.rpm * doppler, r.load, dt, r.engineOn === false ? 0 : 1);
      this.rivalScreech.update(r.slip, P.screech, dt);
      this.bovCool -= dt;
      if (this.rivalTurbo && this.prevRivalLoad > 0.6 && r.load < 0.25 && this.bovCool <= 0) { this.play('bov'); this.bovCool = 1.2; }
      this.prevRivalLoad = r.load;
    } else {
      this.rivalEngine.update(900, 0, dt, 0);
      this.rivalScreech.update(0, P.screech, dt);
    }
  }

  // ---------------------------------------------------------------- one-shots
  play(name) {
    if (!this.ready) return;
    const ctx = this.ctx, t = ctx.currentTime, nb = this.noise;
    const env = (g, peak, a, h, r, at = t) => {
      g.gain.setValueAtTime(0, at);
      g.gain.linearRampToValueAtTime(peak, at + a);
      g.gain.setValueAtTime(peak, at + a + h);
      g.gain.exponentialRampToValueAtTime(0.0001, at + a + h + r);
    };
    const noiseBurst = (dest, type, freq, q, peak, a, h, r, at = t) => {
      const s = ctx.createBufferSource(); s.buffer = nb;
      const b = filter(ctx, type, freq, q), g = gain(ctx, 0);
      s.connect(b).connect(g).connect(dest);
      env(g, peak, a, h, r, at);
      s.start(at, Math.random()); s.stop(at + a + h + r + 0.05);
      return b;
    };
    const tone = (dest, type, f0, f1, peak, a, h, r, at = t) => {
      const o = ctx.createOscillator(), g = gain(ctx, 0);
      o.type = type;
      o.frequency.setValueAtTime(f0, at);
      o.frequency.exponentialRampToValueAtTime(f1, at + a + h + r);
      o.connect(g).connect(dest);
      env(g, peak, a, h, r, at);
      o.start(at); o.stop(at + a + h + r + 0.05);
      return o;
    };
    const fx = this.fx;
    switch (name) {
      case 'whoosh': {
        const b = noiseBurst(fx, 'bandpass', 300, 1.2, 0.7, 0.3, 0.05, 0.7);
        b.frequency.setValueAtTime(300, t); b.frequency.exponentialRampToValueAtTime(2200, t + 0.35); b.frequency.exponentialRampToValueAtTime(400, t + 1.05);
        break;
      }
      case 'warp': {
        this.duck(0.2, 1.3, 1);
        for (const det of [1, 1.012]) {
          const o = tone(fx, 'sawtooth', 70 * det, 1800 * det, 0.18, 0.85, 0.02, 0.15);
          o.detune.value = 0;
        }
        const rise = noiseBurst(fx, 'highpass', 800, 0.7, 0.35, 0.85, 0, 0.08);
        rise.frequency.exponentialRampToValueAtTime(5000, t + 0.85);
        tone(fx, 'sine', 140, 28, 0.9, 0.01, 0.05, 0.7, t + 0.85);              // the boom on arrival
        noiseBurst(fx, 'lowpass', 400, 0.7, 0.6, 0.01, 0.05, 0.5, t + 0.85);
        break;
      }
      case 'land':
        tone(fx, 'sine', 75, 32, 1, 0.005, 0.03, 0.32);
        noiseBurst(fx, 'lowpass', 500, 0.7, 0.6, 0.005, 0.03, 0.15);
        break;
      case 'gust': {
        const b = noiseBurst(fx, 'lowpass', 200, 0.6, 0.7, 0.6, 0.2, 1.2);
        b.frequency.exponentialRampToValueAtTime(1400, t + 0.7); b.frequency.exponentialRampToValueAtTime(250, t + 2);
        break;
      }
      case 'popups': {                                                         // the pop-up motor: bzzzzt-clunk
        const bp = filter(ctx, 'bandpass', 700, 2), g = gain(ctx, 0);
        bp.connect(g).connect(fx);
        env(g, 0.35, 0.02, 0.36, 0.05);
        for (const f0 of [92, 184]) {
          const o = ctx.createOscillator(); o.type = 'sawtooth';
          o.frequency.setValueAtTime(f0, t); o.frequency.linearRampToValueAtTime(f0 * 1.2, t + 0.4);
          o.connect(bp); o.start(t); o.stop(t + 0.5);
        }
        noiseBurst(fx, 'lowpass', 250, 0.7, 0.7, 0.003, 0.02, 0.08, t + 0.42);
        tone(fx, 'sine', 180, 120, 0.4, 0.003, 0.01, 0.06, t + 0.42);
        break;
      }
      case 'clunk':                                                            // brakes give up
        noiseBurst(fx, 'lowpass', 300, 0.7, 0.8, 0.003, 0.03, 0.12);
        tone(fx, 'sine', 90, 55, 0.6, 0.003, 0.02, 0.2);
        noiseBurst(fx, 'bandpass', 2400, 30, 0.9, 0.003, 0, 0.45);
        break;
      case 'clang':                                                            // hopping onto the guardrail
        noiseBurst(fx, 'bandpass', 2100, 25, 1.2, 0.002, 0, 0.5);
        noiseBurst(fx, 'bandpass', 3400, 25, 0.9, 0.002, 0, 0.4);
        noiseBurst(fx, 'highpass', 3000, 0.7, 0.4, 0.001, 0.01, 0.04);
        break;
      case 'crash':                                                            // through the guardrail
        for (let k = 0; k < 6; k++) noiseBurst(fx, 'bandpass', 1500 + Math.random() * 2500, 8, 0.8, 0.003, 0.02, 0.18, t + k * 0.06);
        noiseBurst(fx, 'bandpass', 2600, 25, 1, 0.002, 0, 0.7);
        tone(fx, 'sine', 90, 40, 0.8, 0.005, 0.04, 0.3);
        break;
      case 'ghost': {                                                          // theremin wooOOOooo
        for (const [f, pk] of [[520, 0.22], [780, 0.08]]) {
          const o = tone(fx, 'sine', f, f * 0.73, pk, 0.25, 0.6, 0.6);
          const lfo = ctx.createOscillator(), lg = gain(ctx, f * 0.05);
          lfo.frequency.value = 6; lfo.connect(lg).connect(o.frequency); lfo.start(t); lfo.stop(t + 1.5);
        }
        break;
      }
      case 'sputter': {                                                        // out of gas: chug... chug... tick tick
        [[0, 1], [0.2, 0.8], [0.34, 0.9], [0.62, 0.55], [0.95, 0.35]].forEach(([dt, a]) => {
          noiseBurst(this.rivalPan, 'lowpass', 320, 0.8, 0.8 * a, 0.004, 0.03, 0.14, t + dt);
          tone(this.rivalPan, 'sine', 75, 42, 0.9 * a, 0.004, 0.02, 0.16, t + dt);
        });
        for (const dt of [1.7, 2.6, 3.9]) noiseBurst(this.rivalPan, 'highpass', 4000, 0.7, 0.25, 0.001, 0, 0.02, t + dt);
        break;
      }
      case 'explode': {                                                        // the GT-R, at the rival's position
        this.duck(0.15, 1.6, 1.4);
        tone(this.rivalPan, 'sine', 70, 22, 1.2, 0.005, 0.15, 1.6);             // the thump
        noiseBurst(this.rivalPan, 'lowpass', 900, 0.7, 1.4, 0.004, 0.2, 1.8);   // the roar
        noiseBurst(this.rivalPan, 'bandpass', 2500, 2, 0.6, 0.002, 0.03, 0.35); // glass and metal
        for (let k = 0; k < 14; k++) {                                         // then it crackles away
          const at = t + 0.5 + Math.random() * 4;
          noiseBurst(this.rivalPan, 'bandpass', 1200 + Math.random() * 3000, 6, 0.25 + Math.random() * 0.3, 0.001, 0.005, 0.05, at);
        }
        for (const at of [0.9, 1.5, 2.2, 2.8]) tone(this.rivalPan, 'sine', 120, 70, 0.35, 0.003, 0.02, 0.12, t + at); // wheels landing
        break;
      }
      case 'bov':                                                              // rival's blow-off valve: pssssh
        noiseBurst(this.rivalPan, 'bandpass', 2800, 0.9, 0.9, 0.01, 0.02, 0.45);
        break;
    }
  }
}
