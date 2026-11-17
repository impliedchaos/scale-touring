// Sound for the fly-by: the chased car's engine (heard from the drone, positioned, with Doppler) and the music.
// Both are off by default and switched in the options menu. Browsers only allow audio after a click or key press, so
// `sync()` (called from the menu, which is one) or the first press anywhere starts it. The engine is the audio engine's
// "rival" voice: it is positional, and each car has its own voice and gearbox (`RIVAL_ENGINES` in audio/sound.js, `GEARBOXES`).
import { Sound } from '../audio/sound.js';
import { loadParams } from '../audio/params.js';
import { Drivetrain, GEARBOXES } from '../audio/drivetrain.js';

const REF_DISTANCE = 40; // m: the drone is usually 30 to 150 m from the car; the audio engine's default (8 m) would make it nearly inaudible

export class FlyAudio {
  /** `opt`: the options (engine, music volumes, 0..1); `car`: the BootlegCar or null; `spec`: its cars.json entry; `weather`: world.weather. */
  constructor({ opt, car, carId, spec, weather }) {
    Object.assign(this, { opt, car, carId: carId || 'rx7', weather, nowPlaying: '', sound: null });
    this.dt = car ? new Drivetrain(GEARBOXES[this.carId] || GEARBOXES.ae86, spec.wheel_radius) : null;
    const arm = () => this.sync();
    addEventListener('pointerdown', arm, { once: true });
    addEventListener('keydown', arm, { once: true });
  }

  /** A new world (place / car / weather) after an in-page swap: the audio context and the music carry on. */
  rebind({ car, carId, spec, weather }) {
    Object.assign(this, { car, carId: carId || 'rx7', weather });
    this.dt = car ? new Drivetrain(GEARBOXES[this.carId] || GEARBOXES.ae86, spec.wheel_radius) : null;
    if (this.sound?.ready) {
      this.sound.setRival(this.carId);
      this.sound.weather = { rain: weather.rain ? 1 : 0, wet: weather.wet ? 1 : 0 };
      this.sound.lastDist = null;
    }
  }

  /** Make audio match the options. Needs a user gesture the first time it turns anything on. */
  async sync() {
    const { opt } = this;
    if (!(opt.engine > 0) && !(opt.music > 0) && !this.sound) return;
    if (!this.sound) {
      this.sound = new Sound(loadParams(), { onTrack: (t) => { this.nowPlaying = `${t.title}${t.artist ? ` · ${t.artist}` : ''}`; } });
      this.sound.weather = { rain: this.weather.rain ? 1 : 0, wet: this.weather.wet ? 1 : 0 };
      await this.sound.init(this.carId);
      this.sound.rivalPan.refDistance = REF_DISTANCE;
    }
    const s = this.sound;
    await s.init(this.carId);
    s.resume();
    s.volumes(opt.engine, opt.music);
    s.titleQuiet = !(opt.engine > 0); // "title quiet" = effects bus silent, music still plays
    if (opt.music > 0) {
      if (opt.song) await s.music.playFile(opt.song);
      if (!(await s.music.start(opt.song)) && !s.music.list.length) this.nowPlaying = 'no music installed';
    } else { s.music.pause(); this.nowPlaying = ''; }
  }

  /** Once a frame, after the car has moved. `dt`: seconds of the car's own time (0 when paused). */
  update(dt, camera, paused) {
    const s = this.sound;
    if (!s?.ready || (!(this.opt.engine > 0) && !this.car)) return;
    s.paused = paused;
    if (!(this.opt.engine > 0) || !this.car) return;
    const d = this.car.drive, t = this.dt.update(dt, { v: d.v, throttle: d.throttle, slip: d.slip });
    s.update(dt, {
      camera, warping: false,
      player: { rpm: 900, load: 0, slip: 0, grind: 0, gutter: false, speed01: 0, air: false, silent: true }, // nobody is driving; the car is the "rival"
      rival: { active: true, pos: this.car.rig.pos, rpm: t.rpm, load: t.load, slip: d.slip },
    });
  }
}
