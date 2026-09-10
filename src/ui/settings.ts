import type { AudioSettings } from "../audio/audio";
import type { EffectKey, MusicKey } from "../assets/music";
import type { GameEvent, Runtime } from "../game/state";
import type { Theme } from "../level/types";

export const AUDIO_SETTING_KEY = "audio";
export const MOTION_SETTING_KEY = "reducedMotion";

export type UiPreferences = AudioSettings & { readonly reducedMotion: boolean };

export function defaultPreferences(): UiPreferences {
  return { volume: 0.7, muted: false, reducedMotion: false };
}

export function parsePreferences(audio: unknown, motion: unknown): UiPreferences {
  const fallback = defaultPreferences();
  const volume = audio && typeof audio === "object" && "volume" in audio && typeof audio.volume === "number" && Number.isFinite(audio.volume)
    ? Math.min(1, Math.max(0, audio.volume)) : fallback.volume;
  const muted = audio && typeof audio === "object" && "muted" in audio && typeof audio.muted === "boolean" ? audio.muted : fallback.muted;
  const reducedMotion = motion === true || (typeof motion === "object" && motion !== null && "enabled" in motion && motion.enabled === true);
  return { volume, muted, reducedMotion };
}

export function themeMusic(theme: Theme): MusicKey {
  return theme;
}

export function musicForPlay(runtime: Runtime, mode: string): MusicKey {
  if (mode === "GAME_OVER") return "gameOver";
  if (mode === "DEAD") return "death";
  if (mode === "CLEARED") return "clear";
  if (runtime.combat.starTicks > 0) return "star";
  if (runtime.course.timerSeconds > 0 && runtime.timer.remaining > 0 && runtime.timer.remaining <= 100) return "hurry";
  return themeMusic(runtime.areas.get(runtime.areaId)?.source.theme ?? "overworld");
}

export function effectForEvent(event: GameEvent): EffectKey | null {
  switch (event.type) {
    case "jump": return "jump";
    case "swim": return "jump";
    case "coin": return "coin";
    case "blockBump": return "bump";
    case "blockBreak": return "break";
    case "itemSpawn": return event.kind === "vine" ? "bump" : "powerupAppear";
    case "itemCollect": return "powerupCollect";
    case "oneUp": return "oneUp";
    case "ground-stomp": case "special-stomp": case "water-stomp": return "stomp";
    case "shell-kicked": return "shellKick";
    case "fire": return "fire";
    case "pipe-enter": return "pipe";
    case "damage": case "playerDefeated": case "ground-damage": case "special-damage": case "hazard-damage": case "water-damage": return "damage";
    case "spring-launch": return "spring";
    case "axe": return "axe";
    default: return null;
  }
}

export function applyReducedMotion(document: Document, enabled: boolean): void {
  document.documentElement.dataset["reducedMotion"] = enabled ? "true" : "false";
}
