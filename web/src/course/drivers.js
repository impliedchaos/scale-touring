// How each car drives itself (DriftLine overrides, see DRIFT_TUNING in drift.js) and which side of the road it favours.
// A car that isn't listed drives like the AE86: the baseline tuning.
//   tuning: vmax (m/s) and aLat (m/s², cornering grip) cap the speed plan; maxAngle / driftFrom / driftFull shape the drift
//   lane:   metres right of the racing line it habitually runs
export const DRIVERS = {
  r32: { tuning: { vmax: 43, aLat: 26 } },
  celica7: { tuning: { vmax: 44, aLat: 27 } },
  celica6: { tuning: { vmax: 41, aLat: 25, maxAngle: 1.35, driftFrom: 400, driftFull: 60 } }, // sideways at all times
  supra: { tuning: { vmax: 45, aLat: 28 }, lane: 1.6 },
  gtr: { tuning: { vmax: 48, aLat: 34, maxAngle: 0.12 } },                                      // grip, no drama
  rx7: { tuning: { vmax: 46, aLat: 30, maxAngle: 0.85 } },                                      // quick and tidy
};
