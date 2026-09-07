// Original, project-authored scores. No ROM data or transcribed Nintendo melodies.
// MIDI pitches, seconds after compilation; rests are -1 in the handwritten rows.
export const musicKeys = ["overworld", "underground", "underwater", "castle", "star", "hurry", "death", "clear", "gameOver"] as const;
export const effectKeys = ["jump", "coin", "bump", "break", "powerupAppear", "powerupCollect", "stomp", "shellKick", "fire", "pipe", "damage", "oneUp", "spring", "axe"] as const;
export type MusicKey = typeof musicKeys[number];
export type EffectKey = typeof effectKeys[number];
export type AudioKey = MusicKey | EffectKey;
export type Instrument = "pulse" | "triangle" | "noise";
export type Note = {
  readonly at: number;
  readonly duration: number;
  readonly midi: number;
  readonly endMidi: number;
  readonly instrument: Instrument;
  readonly gain: number;
};
export type Score = { readonly bpm: number; readonly duration: number; readonly loop: boolean; readonly notes: readonly Note[] };
type Part = { readonly instrument: Instrument; readonly step: number; readonly pitches: readonly number[]; readonly gate?: number; readonly gain?: number };
function song(bpm: number, beats: number, parts: readonly Part[], loop = true): Score {
  const beat = 60 / bpm;
  const notes = parts.flatMap((part) => part.pitches.flatMap((midi, index): Note[] => midi < 0 ? [] : [{
    at: index * part.step * beat, duration: part.step * beat * (part.gate ?? 0.78),
    midi, endMidi: midi, instrument: part.instrument, gain: part.gain ?? 0.035,
  }])).sort((a, b) => a.at - b.at);
  return { bpm, duration: beats * beat, loop, notes };
}

export const MUSIC: Readonly<Record<MusicKey, Score>> = {
  // Sunny, syncopated C-major call/response; alternating bass and dry backbeat.
  overworld: song(156, 32, [
    { instrument: "pulse", step: 0.5, pitches: [72,-1,76,79,-1,76,74,72, 67,-1,72,-1,76,74,-1,71, 69,72,-1,76,81,-1,79,76, 74,-1,71,67,72,-1,-1,-1, 76,-1,79,84,-1,83,81,79, 77,76,-1,74,72,-1,71,67, 69,-1,74,77,76,-1,74,71, 72,76,79,-1,72,-1,-1,-1] },
    { instrument: "pulse", step: 1, gain: 0.018, pitches: [-1,60,-1,64,-1,59,-1,62,-1,60,-1,64,-1,59,-1,60,-1,64,-1,67,-1,62,-1,59,-1,62,-1,65,-1,64,-1,60] },
    { instrument: "triangle", step: 1, gate: 0.65, gain: 0.045, pitches: [48,55,48,55,47,55,47,55,45,52,45,52,43,50,48,55,48,55,48,55,41,48,43,50,45,52,43,50,48,55,48,43] },
    { instrument: "noise", step: 1, gate: 0.09, gain: 0.013, pitches: [-1,48,-1,60,-1,48,-1,60,-1,48,-1,60,-1,48,-1,60,-1,48,-1,60,-1,48,-1,60,-1,48,-1,60,-1,48,60,60] },
  ]),
  // Sparse chromatic cellar groove: low octaves, displaced accents and long gaps.
  underground: song(112, 32, [
    { instrument: "pulse", step: 0.5, gain: 0.027, gate: 0.48, pitches: [48,60,-1,51,63,-1,50,62,-1,-1,48,60,-1,-1,-1,-1, 46,58,-1,49,61,-1,48,60,-1,-1,43,55,-1,-1,-1,-1, 48,60,-1,55,67,-1,54,66,-1,-1,51,63,-1,50,62,-1, 46,58,-1,43,55,-1,47,59,48,-1,60,-1,-1,-1,-1,-1] },
    { instrument: "triangle", step: 2, gain: 0.05, gate: 0.65, pitches: [36,-1,36,43,34,-1,31,-1,36,43,39,-1,34,31,36,-1] },
    { instrument: "noise", step: 2, gate: 0.025, gain: 0.009, pitches: [-1,40,-1,52,-1,40,-1,52,-1,40,-1,52,-1,40,-1,52] },
  ]),
  // Buoyant 3/4 waltz in F major; a sustained triangle sings over broken chords.
  underwater: song(96, 24, [
    { instrument: "triangle", step: 1, gate: 0.93, gain: 0.05, pitches: [77,81,84,83,79,76,77,81,86,84,81,77,79,82,86,88,86,82,81,79,76,77,-1,-1] },
    { instrument: "pulse", step: 0.5, gain: 0.019, gate: 0.62, pitches: [53,60,65,69,65,60, 52,59,64,67,64,59, 50,57,62,65,62,57, 53,60,65,69,65,60, 55,62,67,70,67,62, 58,65,70,74,70,65, 48,55,60,64,60,55, 53,60,65,69,65,60] },
    { instrument: "triangle", step: 3, gate: 0.88, gain: 0.033, pitches: [41,40,38,41,43,46,36,41] },
  ]),
  // Driving D-minor fortress ostinato with a descending tritone answer.
  castle: song(144, 32, [
    { instrument: "pulse", step: 0.5, gain: 0.027, gate: 0.55, pitches: [62,69,65,69,62,69,65,69,61,68,64,68,61,68,64,68,60,67,63,67,60,67,63,67,58,65,61,65,57,64,60,64,62,69,74,69,65,69,74,69,63,70,75,70,66,70,75,70,61,68,73,68,64,68,73,68,62,65,69,74,73,69,65,-1] },
    { instrument: "triangle", step: 1, gate: 0.7, gain: 0.05, pitches: [38,38,45,38,37,37,44,37,36,36,43,36,34,34,33,33,38,38,45,38,39,39,46,39,37,37,44,37,38,45,38,33] },
    { instrument: "pulse", step: 2, gate: 0.8, gain: 0.018, pitches: [74,-1,73,-1,72,-1,70,69,77,75,78,77,76,73,74,-1] },
    { instrument: "noise", step: 1, gate: 0.08, gain: 0.016, pitches: [48,-1,60,-1,48,-1,60,60,48,-1,60,-1,48,-1,60,60,48,-1,60,-1,48,-1,60,60,48,-1,60,-1,48,60,60,60] },
  ]),
  star: song(192, 16, [
    { instrument: "pulse", step: 0.5, pitches: [84,79,84,88,86,81,86,89,88,84,91,88,86,83,89,86,84,79,88,84,86,81,89,86,88,91,96,91,89,86,84,-1] },
    { instrument: "triangle", step: 0.5, gain: 0.045, pitches: [48,60,55,60,50,62,57,62,52,64,59,64,55,67,62,67,48,60,55,60,50,62,57,62,52,64,55,67,53,65,48,60] },
    { instrument: "noise", step: 1, gate: 0.12, gain: 0.014, pitches: [60,60,60,60,60,60,60,60,60,60,60,60,60,60,60,60] },
  ]),
  hurry: song(216, 16, [
    { instrument: "pulse", step: 0.5, gate: 0.52, pitches: [76,77,76,71,72,74,76,-1,79,80,79,74,76,77,79,-1,81,82,81,76,77,79,81,83,84,83,81,79,77,74,71,72] },
    { instrument: "triangle", step: 0.5, gain: 0.045, pitches: [48,55,48,55,48,55,48,55,43,50,43,50,43,50,43,50,45,52,45,52,45,52,45,52,43,50,43,50,48,55,48,55] },
    { instrument: "noise", step: 0.5, gate: 0.1, gain: 0.01, pitches: [48,-1,60,-1,48,-1,60,60,48,-1,60,-1,48,-1,60,60,48,-1,60,-1,48,-1,60,60,48,60,48,60,48,60,48,60] },
  ]),
  death: song(108, 6, [
    { instrument: "pulse", step: 0.5, gate: 0.85, pitches: [79,84,-1,83,77,74,71,68,65,62,59,-1] },
    { instrument: "triangle", step: 1, gain: 0.045, pitches: [48,-1,47,41,35,-1] },
  ], false),
  clear: song(132, 12, [
    { instrument: "pulse", step: 0.5, pitches: [72,76,79,84,-1,79,81,84,88,-1,86,84,83,79,74,71,72,76,79,84,88,91,96,-1] },
    { instrument: "pulse", step: 1, gain: 0.023, pitches: [64,67,72,69,72,77,71,67,64,67,72,76] },
    { instrument: "triangle", step: 1, gain: 0.05, pitches: [48,55,60,53,60,65,55,50,48,55,60,48] },
  ], false),
  gameOver: song(84, 8, [
    { instrument: "pulse", step: 0.5, gate: 0.92, pitches: [72,-1,67,64,65,-1,69,-1,68,65,62,-1,60,-1,-1,-1] },
    { instrument: "triangle", step: 1, gate: 0.92, gain: 0.045, pitches: [48,52,53,57,44,43,36,-1] },
    { instrument: "pulse", step: 2, gate: 0.94, gain: 0.02, pitches: [60,60,59,55] },
  ], false),
};

// Each effect has an authored envelope/contour, not one shared beep with a new name.
// Tuples: onset seconds, duration seconds, start MIDI, end MIDI, instrument.
type Gesture = readonly [number, number, number, number, Instrument];
function effect(gestures: readonly Gesture[]): Score {
  return { bpm: 0, loop: false, duration: Math.max(...gestures.map(([at, duration]) => at + duration)) + 0.03,
    notes: gestures.map(([at, duration, midi, endMidi, instrument]) => ({ at, duration, midi, endMidi, instrument, gain: instrument === "noise" ? 0.028 : 0.04 })) };
}
export const EFFECTS: Readonly<Record<EffectKey, Score>> = {
  jump: effect([[0,.16,48,81,"pulse"],[.025,.13,36,60,"triangle"]]),
  coin: effect([[0,.065,83,83,"pulse"],[.065,.27,95,95,"pulse"]]),
  bump: effect([[0,.09,43,29,"triangle"],[0,.045,45,30,"pulse"]]),
  break: effect([[0,.085,70,36,"noise"],[.07,.095,58,30,"noise"],[.15,.13,48,24,"noise"],[0,.12,41,23,"triangle"]]),
  powerupAppear: effect([[0,.07,48,48,"pulse"],[.07,.07,55,55,"pulse"],[.14,.07,60,60,"pulse"],[.21,.07,64,64,"pulse"],[.28,.07,67,67,"pulse"],[.35,.07,72,72,"pulse"],[.42,.07,76,76,"pulse"],[.49,.16,79,84,"pulse"]]),
  powerupCollect: effect([[0,.08,60,60,"pulse"],[.08,.08,64,64,"pulse"],[.16,.08,67,67,"pulse"],[.24,.08,72,72,"pulse"],[.32,.08,76,76,"pulse"],[.4,.22,84,84,"pulse"],[0,.24,48,48,"triangle"],[.24,.38,60,60,"triangle"]]),
  stomp: effect([[0,.07,58,38,"pulse"],[0,.1,42,25,"triangle"],[0,.035,55,35,"noise"]]),
  shellKick: effect([[0,.07,76,43,"pulse"],[.015,.14,55,31,"triangle"],[0,.04,70,48,"noise"]]),
  fire: effect([[0,.045,84,50,"pulse"],[.025,.11,75,29,"noise"]]),
  pipe: effect([[0,.095,62,43,"pulse"],[.13,.095,58,39,"pulse"],[.26,.14,53,34,"pulse"],[0,.4,38,26,"triangle"]]),
  damage: effect([[0,.11,80,42,"pulse"],[.04,.19,70,30,"noise"],[.12,.19,57,24,"triangle"]]),
  oneUp: effect([[0,.11,76,76,"pulse"],[.11,.11,79,79,"pulse"],[.22,.11,88,88,"pulse"],[.33,.11,84,84,"pulse"],[.44,.11,86,86,"pulse"],[.55,.3,91,91,"pulse"],[.22,.22,60,60,"triangle"],[.55,.3,67,67,"triangle"]]),
  spring: effect([[0,.08,48,36,"triangle"],[.08,.2,43,91,"pulse"],[.28,.07,88,81,"pulse"],[.35,.09,86,89,"pulse"]]),
  axe: effect([[0,.16,82,32,"noise"],[0,.22,48,24,"triangle"],[.08,.12,79,67,"pulse"],[.22,.18,60,48,"noise"]]),
};
export const SCORES: Readonly<Record<AudioKey, Score>> = { ...MUSIC, ...EFFECTS };
export const audioKeys: readonly AudioKey[] = [...musicKeys, ...effectKeys];
