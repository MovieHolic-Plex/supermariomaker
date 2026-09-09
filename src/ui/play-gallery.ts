import { attachInput, EMPTY_INPUT } from "../input";
import type { InputFrame, PauseReason } from "../input";
import { FixedClock } from "../game/clock";
import { createRuntime, snapshot } from "../game/state";
import type { GameEvent, Runtime, RuntimeSnapshot } from "../game/state";
import { step } from "../game/step";
import type { CourseV1 } from "../level/types";
import { validatePreview } from "../level/validate";
import { mountFixtureGallery } from "./fixture-gallery";
import { playView, renderPlay } from "./play-view";

export interface PlayObservation {
  readonly mode: "READY" | "PLAYING" | "PAUSED";
  readonly reason: PauseReason | null;
  readonly runtime: RuntimeSnapshot | null;
  readonly input: InputFrame;
  readonly events: readonly GameEvent[];
  readonly clock: FixedClock["state"];
  readonly view: ReturnType<typeof playView> | null;
}
export interface PlayQA {
  snapshot(): PlayObservation;
  course(): CourseV1 | null;
  nextState(predicate: (state: PlayObservation) => boolean, timeoutMs?: number): Promise<PlayObservation>;
}
declare global { interface Window { readonly __qa?: PlayQA } }

/** Temporary movement lab, not the editor-to-play integration (task 17). */
export function mountPlayGallery(root: HTMLElement): Readonly<{ dispose(): void }> {
  const events = new AbortController(), clock = new FixedClock();
  let authored: CourseV1 | null = null, runtime: Runtime | null = null;
  let mode: PlayObservation["mode"] = "READY", reason: PauseReason | null = null;
  let lastInput = EMPTY_INPUT, gameEvents: GameEvent[] = [], raf: number | null = null, disposed = false;
  const pending = new Set<() => void>();
  const loaderRoot = document.createElement("div"), panel = document.createElement("main"), entry = document.createElement("section");
  root.replaceChildren(entry, loaderRoot, panel);
  const style = document.createElement("style"); style.textContent = `
    .movement-entry, .movement-play { max-width:1100px; margin:16px auto; padding:16px 24px; background:var(--surface); border:1px solid var(--border); }
    .movement-play [hidden], .movement-play[hidden], .movement-entry[hidden] { display:none; }
    .movement-play h1 { font-size:24px; line-height:32px; margin:0 0 8px; }
    .movement-play p { line-height:24px; margin:8px 0 12px; }
    .movement-play .movement-layout { display:grid; grid-template-columns:512px minmax(0,1fr); gap:32px; }
    .movement-play canvas { image-rendering:pixelated; display:block; outline-offset:4px; max-width:100%; }
    .movement-play button, .movement-entry button { min-height:44px; margin:0 8px 12px 0; padding:8px 16px; }
    .movement-play output { display:block; margin:12px 0; font-variant-numeric:tabular-nums; }
    .movement-play input { display:block; width:100%; min-height:44px; margin-top:8px; }
    @media(max-width:900px) { .movement-play .movement-layout { grid-template-columns:1fr; } }
  `;
  entry.className = "movement-entry"; panel.className = "movement-play"; panel.hidden = true;
  const start = document.createElement("button"); start.type = "button"; start.dataset["testid"] = "play-start"; start.textContent = "목표 없이 이동 테스트 시작"; start.disabled = true;
  const status = document.createElement("output"); status.dataset["testid"] = "play-status"; status.setAttribute("aria-live", "polite"); status.textContent = "아래에서 코스 파일을 선택해 주세요.";
  entry.append(style, start, status);
  panel.innerHTML = `<h1>이동 실험실</h1><p>← → / A D 이동 · ↑ 덩굴 · Shift / X 달리기·불꽃 · Space / Z 점프·수영 · ↓ / S 웅크리기 · Esc 일시정지</p><div class="movement-layout"><div></div><section><p>60 Hz 고정 시뮬레이션 · 256 × 240 픽셀<br>블록 · 아이템 · 지상 적 밟기 · 등껍질 연속 공격 · 불꽃 사용 가능<br>움직이는 발판 · 스프링 · 덩굴 타기 · 수중 수영 가능 · 타이머 · 완료 판정은 아직 없습니다.</p></section></div>`;
  const canvasSlot = panel.querySelector(".movement-layout > div"), controls = panel.querySelector("section");
  if (!canvasSlot || !controls) throw new Error("Movement layout missing");
  const canvas = document.createElement("canvas"); canvas.dataset["testid"] = "game-canvas"; canvas.tabIndex = 0; canvas.setAttribute("aria-label", "마리오 이동 테스트. 방향키와 스페이스로 조작합니다."); canvasSlot.append(canvas);
  const hud = document.createElement("output"); hud.dataset["testid"] = "hud"; controls.append(hud);
  const overload = document.createElement("output"); overload.dataset["testid"] = "spawn-overload"; overload.hidden = true; overload.textContent = "스폰 과부하"; controls.append(overload);
  const button = (id: string, text: string, action: () => void) => {
    const element = document.createElement("button"); element.type = "button"; element.dataset["testid"] = id; element.textContent = text;
    element.addEventListener("click", action, { signal: events.signal }); controls.append(element); return element;
  };
  const observation = (): PlayObservation => structuredClone({ mode, reason, runtime: runtime ? snapshot(runtime) : null,
    input: lastInput, events: gameEvents, clock: clock.state, view: runtime ? playView(runtime) : null });
  const emit = () => root.dispatchEvent(new CustomEvent<PlayObservation>("play-state", { bubbles: true, detail: observation() }));
  const render = () => {
    if (runtime) {
      renderPlay(canvas, runtime);
      const over = runtime.special.overloadedEnemies || runtime.special.overloadedProjectiles;
      overload.hidden = !over;
      overload.textContent = runtime.special.overloadedEnemies && runtime.special.overloadedProjectiles ? "스폰 과부하 · 적 128 · 발사체 128"
        : runtime.special.overloadedEnemies ? "스폰 과부하 · 적 128" : "스폰 과부하 · 발사체 128";
      hud.textContent = `${runtime.combat.defeated ? "피격 · 처음부터 다시 눌러 재시작" : mode === "PAUSED" ? "일시정지 · 재개 버튼을 눌러 주세요" : "플레이 중"} | 틱 ${runtime.tick}\nX ${runtime.player.x.toFixed(2)} · Y ${runtime.player.y.toFixed(2)}\n점수 ${runtime.progress.score} · 코인 ${runtime.progress.coins} · 목숨 ${runtime.progress.lives}\n${runtime.player.form === "small" ? "작은 마리오" : runtime.player.form === "super" ? "슈퍼 마리오" : "파이어 마리오"} · 스타 ${runtime.combat.starTicks}${over ? " · 스폰 과부하" : ""}`;
    }
  };
  const cancelFrame = () => { if (raf !== null) cancelAnimationFrame(raf); raf = null; };
  const pause = (why: PauseReason) => {
    if (mode !== "PLAYING") return;
    mode = "PAUSED"; reason = why; clock.pause(); input.setActive(false); cancelFrame(); lastInput = EMPTY_INPUT; gameEvents = [];
    pauseButton.hidden = true; resumeButton.hidden = false; render(); emit();
  };
  const input = attachInput(canvas, pause);
  const frame = (now: number) => {
    raf = null;
    clock.frame(now, () => {
      if (!runtime) throw new Error("Playing runtime missing");
      lastInput = input.consume(); gameEvents = step(runtime, lastInput); emit();
    });
    render();
    if (mode === "PLAYING") raf = requestAnimationFrame(frame);
  };
  const resume = () => {
    if (!runtime || disposed || document.hidden) return;
    mode = "PLAYING"; reason = null; input.setActive(true); clock.resume(); lastInput = EMPTY_INPUT; gameEvents = [];
    pauseButton.hidden = false; resumeButton.hidden = true; canvas.focus(); render(); emit();
    raf = requestAnimationFrame(frame);
  };
  const begin = () => {
    if (!authored) return;
    const checked = validatePreview(authored, { allowNoGoal: true });
    if (!checked.ok) { status.textContent = `시작 불가: ${checked.error.message} (${checked.error.code})`; return; }
    cancelFrame(); clock.pause(); input.setActive(false); runtime = createRuntime(authored);
    loaderRoot.hidden = true; entry.hidden = true; panel.hidden = false; resume();
  };
  const pauseButton = button("pause", "일시정지", () => pause("button"));
  const resumeButton = button("resume", "명시적으로 재개", resume); resumeButton.hidden = true;
  button("restart-course", "처음부터 다시", begin);
  button("return-editor", "파일 미리보기로 돌아가기", () => {
    cancelFrame(); clock.pause(); input.setActive(false); runtime = null; mode = "READY"; reason = null; lastInput = EMPTY_INPUT; gameEvents = [];
    panel.hidden = true; loaderRoot.hidden = false; entry.hidden = false; start.focus(); emit();
  });
  // A real form control also makes the shortcut focus boundary inspectable without a runtime hook.
  const noteLabel = document.createElement("label"), note = document.createElement("input"); note.type = "text"; note.dataset["testid"] = "play-note";
  noteLabel.textContent = "테스트 메모 (저장하지 않음)"; noteLabel.append(note); controls.append(noteLabel);
  start.addEventListener("click", begin, { signal: events.signal });
  const dispose = () => {
    if (disposed) return;
    disposed = true; cancelFrame(); clock.pause(); input.dispose(); events.abort();
    for (const cancel of [...pending]) cancel();
    Reflect.deleteProperty(window, "__qa"); gallery.dispose(); authored = null; runtime = null; root.replaceChildren();
    root.dispatchEvent(new CustomEvent("play-cleanup", { bubbles: true, detail: { rafCancelled: raf === null, inputDisposed: input.disposed,
      listenersAborted: events.signal.aborted, subscriptions: pending.size, debtMs: clock.state.debtMs, qaRemoved: !("__qa" in window) } }));
  };
  const gallery = mountFixtureGallery(loaderRoot, { purpose: "movement", onCourseLoaded(course) {
    authored = course; start.disabled = false; status.textContent = "검증 완료 · 목표 없이 이동 테스트를 시작할 수 있습니다."; emit();
  }, onDispose: dispose });
  window.addEventListener("pagehide", dispose, { signal: events.signal });
  if (new URLSearchParams(location.search).get("qa") === "play") Object.defineProperty(window, "__qa", { configurable: true, value: Object.freeze({
    snapshot: observation,
    course: () => authored ? structuredClone(authored) : null,
    nextState(predicate: (state: PlayObservation) => boolean, timeoutMs = 10_000): Promise<PlayObservation> {
      return new Promise((resolve, reject) => {
        const finish = () => { clearTimeout(timer); root.removeEventListener("play-state", listener); pending.delete(cancel); };
        const cancel = () => { finish(); reject(new Error("Play observation disposed")); };
        const listener = (event: Event) => {
          if (!(event instanceof CustomEvent)) return;
          const value = observation();
          try { if (predicate(value)) { finish(); resolve(value); } } catch (error) { finish(); reject(error); }
        };
        const timer = setTimeout(() => { finish(); reject(new Error("Play state timeout")); }, timeoutMs);
        pending.add(cancel); root.addEventListener("play-state", listener);
      });
    },
  } satisfies PlayQA) });
  document.title = "이동 실험실 | 코스 메이커"; emit();
  return { dispose };
}
