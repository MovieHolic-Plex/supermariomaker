import { EFFECTS, MUSIC, SCORES } from "../assets/music";
import type { AudioKey, EffectKey, Instrument, MusicKey, Note } from "../assets/music";
export type { AudioKey, EffectKey, MusicKey } from "../assets/music";

export type AudioSettings = { readonly volume: number; readonly muted: boolean };
export type ScheduledNote = { readonly key: AudioKey; readonly at: number; readonly duration: number; readonly frequency: number; readonly endFrequency: number; readonly instrument: Instrument; readonly gain: number };
export interface AudioVoice { stop(): void }
// Narrow browser boundary: the test driver implements the same audio-clock and
// ended-event contract. The actual synthesis path is also rendered in browser QA.
export interface AudioDriver {
  readonly currentTime: number;
  readonly state: string;
  resume(): Promise<void>;
  close(): Promise<void>;
  setVolume(value: number): void;
  schedule(note: ScheduledNote, ended: () => void): AudioVoice;
}
export type AudioSnapshot = AudioSettings & { readonly status: "locked" | "ready" | "paused" | "unavailable" | "disposed"; readonly music: MusicKey | null; readonly voices: number; readonly pendingEffects: number; readonly error: string | null };
export interface AudioEngine {
  /** Call directly from a trusted click/key handler, never a frame or game event. */
  activateFromGesture(): Promise<boolean>;
  playMusic(key: MusicKey): void;
  playEffect(key: EffectKey): boolean;
  /** Call each animation frame. Scheduling uses AudioContext.currentTime, not frame dt. */
  tick(): void;
  pause(): void;
  stop(): void;
  setMuted(muted: boolean): void;
  setVolume(volume: number): void;
  snapshot(): AudioSnapshot;
  dispose(): Promise<void>;
}
export type AudioOptions = { readonly createDriver?: () => AudioDriver; readonly settings?: AudioSettings; readonly onSettingsChange?: (settings: AudioSettings) => void; readonly onChange?: (snapshot: AudioSnapshot) => void; readonly onSchedule?: (note: ScheduledNote) => void };
export const MAX_VOICES = 16;
const LOOKAHEAD = 0.12;
const LEAD = 0.015;
const frequency = (midi: number) => 440 * 2 ** ((midi - 69) / 12);
function scheduled(key: AudioKey, note: Note, origin: number): ScheduledNote {
  return { key, at: origin + note.at, duration: note.duration, frequency: frequency(note.midi), endFrequency: frequency(note.endMidi), instrument: note.instrument, gain: note.gain };
}

// Shared real WebAudio synthesis for live playback AND OfflineAudioContext proof.
function synthesizer(context: BaseAudioContext) {
  const master = context.createGain();
  master.connect(context.destination);
  const noise = context.createBuffer(1, context.sampleRate, context.sampleRate);
  const samples = noise.getChannelData(0);
  let seed = 0x534d4231;
  for (let i = 0; i < samples.length; i++) {
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
    samples[i] = ((seed >>> 0) / 0x100000000) * 2 - 1;
  }
  return {
    setVolume(value: number) { master.gain.setValueAtTime(value, context.currentTime); },
    schedule(note: ScheduledNote, ended: () => void): AudioVoice {
      const envelope = context.createGain();
      envelope.connect(master);
      let source: AudioScheduledSourceNode;
      switch (note.instrument) {
        case "noise": {
          const buffer = context.createBufferSource();
          buffer.buffer = noise; buffer.loop = true;
          buffer.playbackRate.setValueAtTime(note.frequency / 440, note.at);
          buffer.playbackRate.exponentialRampToValueAtTime(note.endFrequency / 440, note.at + note.duration);
          source = buffer; break;
        }
        case "pulse": case "triangle": {
          const oscillator = context.createOscillator();
          oscillator.type = note.instrument === "pulse" ? "square" : "triangle";
          oscillator.frequency.setValueAtTime(note.frequency, note.at);
          oscillator.frequency.exponentialRampToValueAtTime(note.endFrequency, note.at + note.duration);
          source = oscillator; break;
        }
        default: { const exhaustive: never = note.instrument; throw new TypeError(`Unknown instrument: ${exhaustive}`); }
      }
      source.connect(envelope);
      // At most sixteen voices, each <= .05: headroom without a clipping limiter.
      envelope.gain.setValueAtTime(0, note.at);
      envelope.gain.linearRampToValueAtTime(note.gain, note.at + Math.min(0.003, note.duration / 4));
      envelope.gain.linearRampToValueAtTime(note.gain * 0.65, note.at + note.duration * 0.6);
      envelope.gain.linearRampToValueAtTime(0, note.at + note.duration);
      let finished = false;
      const release = () => { if (finished) return; finished = true; source.disconnect(); envelope.disconnect(); ended(); };
      source.onended = release;
      source.start(note.at); source.stop(note.at + note.duration);
      return { stop() { if (finished) return; source.stop(context.currentTime); release(); } };
    },
  };
}
function browserDriver(): AudioDriver {
  if (typeof AudioContext === "undefined") throw new DOMException("Web Audio API is unavailable", "NotSupportedError");
  const context = new AudioContext();
  const synth = synthesizer(context);
  return { get currentTime() { return context.currentTime; }, get state() { return context.state; },
    resume: () => context.resume(), close: () => context.close(), ...synth };
}

type Cursor = { readonly key: AudioKey; origin: number; index: number };
// allow: SIZE_OK -- owned task4 API, transport and shared WebAudio backend must
// stay in this one owned module; no shared-file or speculative adapter split.
export function createAudioEngine(options: AudioOptions = {}): AudioEngine {
  let volume = Number.isFinite(options.settings?.volume) ? Math.min(1, Math.max(0, options.settings?.volume ?? 0.7)) : 0.7;
  let muted = options.settings?.muted ?? false;
  let status: AudioSnapshot["status"] = "locked";
  let music: MusicKey | null = null;
  let error: string | null = null;
  let driver: AudioDriver | null = null;
  let cursor: Cursor | null = null;
  let effects: Cursor[] = [];
  let activation: { readonly generation: number; readonly promise: Promise<boolean> } | null = null;
  let generation = 0;
  const voices = new Map<AudioVoice, ScheduledNote>();
  const snapshot = (): AudioSnapshot => ({ volume, muted, status, music, voices: voices.size, pendingEffects: effects.length, error });
  const notify = () => options.onChange?.(snapshot());
  const clearVoices = () => { for (const voice of voices.keys()) voice.stop(); voices.clear(); effects = []; cursor = null; };
  const resetMusic = () => { cursor = music && driver ? { key: music, origin: driver.currentTime + LEAD, index: 0 } : null; };
  const gain = () => driver?.setVolume(muted ? 0 : volume);
  const save = () => { gain(); options.onSettingsChange?.({ volume, muted }); notify(); };
  const closeDriver = async () => {
    const closing = driver; driver = null;
    if (closing && closing.state !== "closed") {
      try { await closing.close(); }
      catch (cause) { error = `${error ?? "Audio close failed"}; ${cause instanceof Error ? cause.message : String(cause)}`; notify(); }
    }
  };
  const unavailable = (cause: unknown) => {
    error = cause instanceof Error ? cause.message : String(cause);
    status = "unavailable"; clearVoices(); notify();
  };
  const scheduleCursor = (track: Cursor, now: number) => {
    const score = SCORES[track.key];
    if (score.loop && now >= track.origin + score.duration) {
      track.origin += Math.floor((now - track.origin) / score.duration) * score.duration; track.index = 0;
    }
    while (true) {
      const note = score.notes[track.index];
      if (!note) {
        if (!score.loop || track.origin + score.duration > now + LOOKAHEAD) break;
        track.origin += score.duration; track.index = 0; continue;
      }
      const event = scheduled(track.key, note, track.origin);
      if (event.at > now + LOOKAHEAD) break;
      track.index++;
      if (event.at < now || voices.size >= MAX_VOICES || !driver) continue;
      const voice = driver.schedule(event, () => { voices.delete(voice); });
      voices.set(voice, event); options.onSchedule?.(event);
    }
  };
  const tick = () => {
    if (status !== "ready" || !driver || muted) return;
    if (driver.state !== "running") { engine.pause(); return; }
    try {
      const now = driver.currentTime;
      // ended events can arrive after the next frame; retire by the audio clock too.
      for (const [voice, note] of voices) if (note.at + note.duration <= now) { voice.stop(); voices.delete(voice); }
      if (cursor) scheduleCursor(cursor, now);
      for (const effect of effects) scheduleCursor(effect, now);
      effects = effects.filter((effect) => now < effect.origin + SCORES[effect.key].duration);
      if (cursor && !SCORES[cursor.key].loop && now >= cursor.origin + SCORES[cursor.key].duration) { cursor = null; music = null; }
    } catch (cause) { unavailable(cause); void closeDriver(); }
    notify();
  };
  const engine: AudioEngine = {
    activateFromGesture() {
      if (status === "disposed" || status === "unavailable") return Promise.resolve(false);
      if (status === "ready" && driver?.state === "running") return Promise.resolve(true);
      if (activation?.generation === generation) return activation.promise;
      const token = generation;
      // Context construction and resume invocation happen synchronously in the
      // caller's gesture, before awaiting any storage or other asynchronous work.
      const activate = async () => {
        try {
          driver ??= (options.createDriver ?? browserDriver)();
          await driver.resume();
          if (generation !== token) return false;
          if (driver?.state !== "running") throw new DOMException("Audio context did not resume", "NotAllowedError");
          status = "ready"; gain(); resetMusic(); tick(); notify(); return true;
        } catch (cause) {
          if (generation !== token) return false;
          unavailable(cause); await closeDriver(); return false;
        }
      };
      const promise = activate().finally(() => { if (activation?.generation === token) activation = null; });
      activation = { generation: token, promise };
      return promise;
    },
    playMusic(key) {
      if (status === "disposed" || status === "unavailable" || music === key) return;
      clearVoices(); music = key; resetMusic(); tick(); notify();
    },
    playEffect(key) {
      if (status !== "ready" || !driver || muted || volume === 0 || effects.length >= MAX_VOICES) return false;
      effects.push({ key, origin: driver.currentTime + LEAD, index: 0 }); tick(); return true;
    },
    tick,
    pause() { if (status !== "ready" && !activation) return; generation++; status = "paused"; clearVoices(); notify(); },
    stop() { generation++; clearVoices(); music = null; notify(); },
    setMuted(value) { if (status === "disposed" || muted === value) return; muted = value; clearVoices(); if (!muted) resetMusic(); save(); tick(); },
    setVolume(value) { if (status === "disposed" || !Number.isFinite(value)) return; volume = Math.max(0, Math.min(1, value)); save(); },
    snapshot,
    async dispose() { if (status === "disposed") return; generation++; clearVoices(); music = null; status = "disposed"; notify(); await closeDriver(); },
  };
  return engine;
}

export type AudioRender = { readonly wav: Uint8Array; readonly schedule: readonly ScheduledNote[]; readonly sampleRate: number; readonly frames: number; readonly peak: number; readonly rms: number; readonly clippedSamples: number };
/** Render a full authored cue, once, with the same synthesis as live playback. */
export async function renderAudioWav(key: AudioKey): Promise<AudioRender> {
  const score = SCORES[key];
  const sampleRate = 44100;
  const context = new OfflineAudioContext(1, Math.ceil((score.duration + 0.15) * sampleRate), sampleRate);
  const synth = synthesizer(context);
  const schedule = score.notes.map((note) => scheduled(key, note, LEAD));
  for (const note of schedule) synth.schedule(note, () => {});
  const rendered = await context.startRendering();
  const samples = rendered.getChannelData(0);
  const wav = new Uint8Array(44 + samples.length * 2);
  const data = new DataView(wav.buffer);
  const text = (at: number, value: string) => { for (let i = 0; i < value.length; i++) data.setUint8(at + i, value.charCodeAt(i)); };
  text(0, "RIFF"); data.setUint32(4, wav.length - 8, true); text(8, "WAVEfmt ");
  data.setUint32(16, 16, true); data.setUint16(20, 1, true); data.setUint16(22, 1, true);
  data.setUint32(24, sampleRate, true); data.setUint32(28, sampleRate * 2, true); data.setUint16(32, 2, true); data.setUint16(34, 16, true);
  text(36, "data"); data.setUint32(40, samples.length * 2, true);
  let peak = 0; let squares = 0; let clippedSamples = 0;
  for (let i = 0; i < samples.length; i++) {
    const sample = samples[i] ?? 0;
    if (!Number.isFinite(sample)) throw new RangeError("Nonfinite audio sample");
    peak = Math.max(peak, Math.abs(sample)); squares += sample * sample;
    if (Math.abs(sample) >= 1) clippedSamples++;
    data.setInt16(44 + i * 2, Math.round(Math.max(-1, Math.min(1, sample)) * (sample < 0 ? 32768 : 32767)), true);
  }
  return { wav, schedule, sampleRate, frames: samples.length, peak, rms: Math.sqrt(squares / samples.length), clippedSamples };
}

// Keep inventory discoverable without requiring consumers to duplicate string unions.
export { MUSIC, EFFECTS };
