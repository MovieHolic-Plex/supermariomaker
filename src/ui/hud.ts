import type { Runtime } from "../game/state";

export function hudModel(runtime: Runtime) {
  return {
    score: runtime.progress.score,
    coins: runtime.progress.coins,
    lives: runtime.progress.lives,
    timer: runtime.course.timerSeconds === 0 ? null : runtime.timer.remaining,
    ending: runtime.ending.kind,
    defeated: runtime.combat.defeated,
  };
}

/** Machine-consumed dataset plus visible Korean readout. Tests never pin the prose. */
export function renderHud(node: HTMLElement, runtime: Runtime, mode: string): void {
  const model = hudModel(runtime);
  node.dataset["score"] = String(model.score);
  node.dataset["coins"] = String(model.coins);
  node.dataset["lives"] = String(model.lives);
  node.dataset["timer"] = model.timer === null ? "unlimited" : String(model.timer);
  node.dataset["ending"] = model.ending;
  node.dataset["mode"] = mode;
  const timer = model.timer === null ? "무제한" : String(model.timer).padStart(3, "0");
  const status = model.defeated ? "피격" : mode === "PAUSED" ? "일시정지" : mode === "CLEARED" ? "클리어" : mode === "GAME_OVER" ? "게임 오버" : mode === "DEAD" ? "재시도" : "플레이 중";
  node.textContent = `${status} | 틱 ${runtime.tick}\n점수 ${model.score} · 코인 ${model.coins} · 목숨 ${model.lives} · 시간 ${timer}`;
}
