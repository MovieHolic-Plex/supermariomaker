import { audioKeys, effectKeys, musicKeys } from "../assets/music";
import { createAudioEngine, renderAudioWav } from "../audio/audio";
import type { AudioEngine, AudioSettings, AudioSnapshot } from "../audio/audio";
import type { AudioKey, MusicKey } from "../assets/music";

export type AudioGalleryOptions = {
  readonly settings?: AudioSettings;
  /** The app's IndexedDB settings owner supplies persistence at integration. */
  readonly onSettingsChange?: (settings: AudioSettings) => void;
};
export type AudioGallery = { readonly engine: AudioEngine; dispose(): Promise<void> };
const names: Readonly<Record<AudioKey, string>> = {
  overworld: "지상", underground: "지하", underwater: "수중", castle: "성",
  star: "무적 스타", hurry: "시간 경고", death: "실패", clear: "코스 완료", gameOver: "게임 오버",
  jump: "점프", coin: "동전", bump: "블록 충돌", break: "벽돌 파괴",
  powerupAppear: "아이템 등장", powerupCollect: "파워업 획득", stomp: "밟기", shellKick: "껍질 차기",
  fire: "불꽃 발사", pipe: "파이프 이동", damage: "피해", oneUp: "목숨 추가", spring: "스프링", axe: "도끼와 다리",
};
const statusNames: Readonly<Record<AudioSnapshot["status"], string>> = {
  locked: "소리 켜기를 눌러 시작하세요.", ready: "소리 사용 중", paused: "일시 정지 · 소리 켜기로 재개",
  unavailable: "소리 사용 불가 · 브라우저 설정을 확인하세요. 다른 기능은 계속 사용할 수 있습니다.", disposed: "소리 종료",
};

/** Real incremental module surface; no storage backend or normal app route here. */
export function mountAudioGallery(root: HTMLElement, options: AudioGalleryOptions = {}): AudioGallery {
  const events = new AbortController();
  const urls = new Set<string>();
  let disposed = false;
  let frame = 0;
  let selected: MusicKey = "overworld";
  let exporting: Promise<void> | null = null;
  let previousState = "";
  const panel = document.createElement("section");
  panel.dataset["testid"] = "audio-gallery";
  const style = document.createElement("style");
  style.textContent = `
    [data-testid=audio-gallery] { color:#f7f5e9; background:#142338; font:16px/1.6 system-ui,sans-serif; max-width:1080px; margin:24px auto; padding:28px; border:3px solid #ffc85b; border-radius:8px; box-sizing:border-box; }
    [data-testid=audio-gallery] h1 { margin:0; font-size:28px; color:#ffc85b; }
    [data-testid=audio-gallery] h2 { font-size:20px; margin:20px 0 10px; }
    [data-testid=audio-gallery] p { margin:8px 0 18px; word-break:keep-all; }
    [data-testid=audio-gallery] .audio-controls { display:flex; align-items:center; flex-wrap:wrap; gap:12px; margin:12px 0; }
    [data-testid=audio-gallery] button, [data-testid=audio-gallery] select { font:inherit; color:#fff; background:#263d59; border:1px solid #8096ae; border-radius:4px; padding:8px 14px; min-height:44px; }
    [data-testid=audio-gallery] button { cursor:pointer; }
    [data-testid=audio-gallery] button:hover:enabled { background:#365579; }
    [data-testid=audio-gallery] button:disabled { opacity:.5; cursor:default; }
    [data-testid=audio-gallery] :focus-visible { outline:3px solid #ffc85b; outline-offset:3px; }
    [data-testid=audio-gallery] .audio-effects { display:grid; grid-template-columns:repeat(auto-fit,minmax(145px,1fr)); gap:10px; }
    [data-testid=audio-gallery] output { display:block; padding:10px 14px; background:#0d1827; border-left:4px solid #ffc85b; word-break:keep-all; }
    [data-testid=audio-gallery] label { display:flex; align-items:center; gap:8px; min-height:44px; white-space:nowrap; }
    [data-testid=audio-gallery] input[type=checkbox] { width:20px; height:20px; min-height:20px; flex:0 0 20px; margin:0; padding:0; }
    [data-testid=audio-gallery] input[type=range] { width:160px; accent-color:#ffc85b; }
  `;
  const title = document.createElement("h1"); title.textContent = "사운드 갤러리";
  const intro = document.createElement("p"); intro.textContent = "직접 작곡한 8비트 테마와 효과음 · 펄스 / 삼각파 / 노이즈. 소리 켜기는 직접 눌러야 합니다.";
  const controls = document.createElement("div"); controls.className = "audio-controls";
  const status = document.createElement("output"); status.dataset["testid"] = "audio-status"; status.setAttribute("aria-live", "polite");
  const musicSelect = document.createElement("select"); musicSelect.dataset["testid"] = "theme-select";
  const label = document.createElement("label"); label.textContent = "음악 테마"; label.append(musicSelect);
  for (const key of musicKeys) { const item = document.createElement("option"); item.value = key; item.textContent = names[key]; musicSelect.append(item); }
  const button = (id: string, text: string, parent: HTMLElement) => {
    const element = document.createElement("button"); element.type = "button"; element.dataset["testid"] = id; element.textContent = text; parent.append(element); return element;
  };
  const enable = button("audio-enable", "소리 켜기 / 재개", controls);
  controls.append(label);
  const play = button("audio-play", "음악 재생", controls);
  const pause = button("audio-pause", "일시 정지", controls);
  const stop = button("audio-stop", "모두 정지", controls);
  const settings = document.createElement("div"); settings.className = "audio-controls";
  const muteLabel = document.createElement("label"); muteLabel.textContent = "음소거";
  const mute = document.createElement("input"); mute.type = "checkbox"; mute.dataset["testid"] = "audio-mute"; muteLabel.prepend(mute);
  const volumeLabel = document.createElement("label"); volumeLabel.textContent = "음량";
  const volume = document.createElement("input"); volume.type = "range"; volume.min = "0"; volume.max = "1"; volume.step = "0.05"; volume.dataset["testid"] = "audio-volume"; volumeLabel.append(volume);
  settings.append(muteLabel, volumeLabel);
  const effectsTitle = document.createElement("h2"); effectsTitle.textContent = "효과음 · 14종";
  const effects = document.createElement("div"); effects.className = "audio-effects";
  const effectButtons = effectKeys.map((key) => ({ key, button: button(`audio-effect-${key}`, names[key], effects) }));
  const exportTitle = document.createElement("h2"); exportTitle.textContent = "실제 오디오 렌더링";
  const exportControls = document.createElement("div"); exportControls.className = "audio-controls";
  const exportLabel = document.createElement("label"); exportLabel.textContent = "WAV 소스";
  const exportSelect = document.createElement("select"); exportSelect.dataset["testid"] = "audio-export-select"; exportLabel.append(exportSelect); exportControls.append(exportLabel);
  for (const key of audioKeys) { const item = document.createElement("option"); item.value = key; item.textContent = names[key]; exportSelect.append(item); }
  const exportButton = button("audio-export", "WAV 다운로드", exportControls);
  const exit = button("audio-exit", "갤러리 종료", exportControls);
  const renderStatus = document.createElement("output"); renderStatus.dataset["testid"] = "audio-render-status";
  renderStatus.textContent = "44.1 kHz / 모노 / 16비트 PCM · 선택한 곡 전체를 한 번 렌더링합니다. 음소거와 무관하게 파일을 생성합니다.";
  panel.append(style, title, intro, controls, status, settings, effectsTitle, effects, exportTitle, exportControls, renderStatus);
  root.replaceChildren(panel);

  const show = (state: AudioSnapshot) => {
    const encoded = JSON.stringify(state);
    if (disposed || previousState === encoded) return;
    previousState = encoded;
    panel.dataset["status"] = state.status; panel.dataset["music"] = state.music ?? "";
    panel.dataset["voices"] = String(state.voices); panel.dataset["muted"] = String(state.muted);
    panel.dataset["volume"] = String(state.volume);
    status.textContent = `${statusNames[state.status]}${state.muted ? " · 음소거" : ""}${state.music ? ` · ${names[state.music]}` : ""}${state.error ? ` (${state.error})` : ""}`;
    mute.checked = state.muted; volume.value = String(state.volume);
    enable.disabled = state.status === "unavailable";
    play.disabled = state.status !== "ready"; pause.disabled = state.status !== "ready";
    for (const effect of effectButtons) effect.button.disabled = state.status !== "ready" || state.muted;
    root.dispatchEvent(new CustomEvent("audio-state", { detail: state }));
  };
  const engine = createAudioEngine({ ...options, onChange: show,
    onSchedule: (note) => root.dispatchEvent(new CustomEvent("audio-scheduled", { detail: note })),
  });
  const on = (target: EventTarget, type: string, handler: () => void) => target.addEventListener(type, handler, { signal: events.signal });
  on(enable, "click", () => { void engine.activateFromGesture(); });
  on(play, "click", () => { engine.stop(); engine.playMusic(selected); });
  on(musicSelect, "change", () => {
    const key = musicKeys.find((item) => item === musicSelect.value);
    if (key) { selected = key; engine.playMusic(key); }
  });
  on(pause, "click", () => engine.pause()); on(stop, "click", () => engine.stop());
  on(mute, "change", () => engine.setMuted(mute.checked));
  on(volume, "input", () => engine.setVolume(volume.valueAsNumber));
  for (const effect of effectButtons) on(effect.button, "click", () => { engine.playEffect(effect.key); });
  on(window, "blur", () => engine.pause());
  on(document, "visibilitychange", () => { if (document.hidden) engine.pause(); });

  const render = async (key: AudioKey) => {
    exportButton.disabled = true;
    try {
      const result = await renderAudioWav(key);
      if (disposed) return;
      const url = URL.createObjectURL(new Blob([new Uint8Array(result.wav)], { type: "audio/wav" })); urls.add(url);
      const link = document.createElement("a"); link.href = url; link.download = `${key}.wav`; link.click();
      renderStatus.textContent = `${names[key]} · ${result.frames} 프레임 · 최대 진폭 ${result.peak.toFixed(3)} · 클리핑 ${result.clippedSamples}`;
      const { wav: _wav, ...metrics } = result;
      root.dispatchEvent(new CustomEvent("audio-rendered", { detail: { key, ...metrics } }));
    } catch (cause) {
      const error = cause instanceof Error ? cause.message : String(cause);
      renderStatus.textContent = `WAV 생성 실패: ${error}`;
      root.dispatchEvent(new CustomEvent("audio-render-error", { detail: error }));
    } finally { exportButton.disabled = false; }
  };
  on(exportButton, "click", () => {
    const key = audioKeys.find((item) => item === exportSelect.value);
    if (key && !exporting) exporting = render(key).finally(() => { exporting = null; });
  });
  const dispose = async () => {
    if (disposed) return;
    disposed = true; events.abort(); cancelAnimationFrame(frame);
    await engine.dispose();
    await exporting;
    for (const url of urls) URL.revokeObjectURL(url);
    urls.clear(); root.replaceChildren();
    root.dispatchEvent(new CustomEvent("audio-cleanup", { detail: { voices: engine.snapshot().voices, urls: urls.size, frameCancelled: true, listenersAborted: events.signal.aborted } }));
  };
  on(exit, "click", () => { void dispose(); }); on(window, "pagehide", () => { void dispose(); });
  const animate = () => { if (disposed) return; engine.tick(); frame = requestAnimationFrame(animate); };
  show(engine.snapshot()); frame = requestAnimationFrame(animate);
  return { engine, dispose };
}
