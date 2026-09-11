<div align="center">

# 🍄 Super Mario Course Maker

**Build your own SMB1-style courses in the browser — playtest instantly, share them as files**

[English](README.md) · [한국어](README.ko.md) · [简体中文](README.zh-CN.md)

[![Bun](https://img.shields.io/badge/Bun-1.4-f9f1e1?logo=bun&logoColor=000)](https://bun.sh)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6?logo=typescript&logoColor=fff)](https://www.typescriptlang.org)
[![Runtime deps](https://img.shields.io/badge/runtime%20deps-0-brightgreen)](#-tech-stack)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

![Course editor](docs/screenshots/editor.png)

</div>

---

## ✨ Features

<table>
<tr>
<td width="50%">

### 🖌️ Full course editor
- Paint · erase · rectangle fill · select/move/copy/paste
- Gesture-level undo/redo (up to 200 steps)
- 1x–8x pointer-anchored zoom · pan · 16px grid snap
- Categorized palette + **property inspector** for placed objects
- Start position · flag & castle goals · linked pipes / warp zones
- Multiple linked areas (overworld ↔ underground, etc.)

</td>
<td width="50%">

### 🎮 Actually playable
- Run · variable jump · crouch · swim · vine climb
- Small → Super → Fire forms, Star, 1UP
- Stomps · shell combos · fireball combat
- Coins · score · lives · timer · flag/axe endings
- Instant editor ↔ playtest round-trip (authored state fully restored)

</td>
</tr>
<tr>
<td>

### 🗺️ 4 themes · full SMB1 roster
- **Overworld · Underground · Underwater · Castle**
- Goomba, green/red Koopa & Paratroopa, Piranha, Buzzy, cannon/Bullet Bill, Hammer Bro, Lakitu, Cheep Cheep/Blooper, Podoboo, Firebar, Bowser + axe bridge
- Moving/falling/balance platforms, springs, hidden blocks, vines

</td>
<td>

### 💾 Local-first storage
- IndexedDB **autosave** + revision conflict detection
- Course library: open/rename/duplicate/delete
- `.smb1.json` **export/import** — fully validated portable format
- No accounts · no servers · nothing to install

</td>
</tr>
</table>

🎵 The chiptune soundtrack (per-theme BGM + effects) is synthesized live with Web Audio.

> **Honest scope** — no accounts, no hosted catalog, no servers, no multiplayer, no mobile editor. IndexedDB autosave is **not a permanent backup**: clearing site data, storage eviction, or another profile loses it — the durable backup is the **exported** JSON file. No promise of original-bug or frame-exact parity.

---

## 📸 Screenshots

<div align="center">
<img src="docs/screenshots/library.png" width="720" alt="Course library">
<p><sub>Course library — create · open · rename · duplicate · delete</sub></p>

<table>
<tr>
<td><img src="docs/screenshots/play-overworld.png" alt="Overworld gameplay"></td>
<td><img src="docs/screenshots/play-underground.png" alt="Underground gameplay"></td>
</tr>
<tr>
<td><img src="docs/screenshots/play-underwater.png" alt="Underwater gameplay"></td>
<td><img src="docs/screenshots/play-castle.png" alt="Castle gameplay"></td>
</tr>
</table>
<p><sub>Overworld · Underground · Underwater · Castle — all four themes in play</sub></p>

<img src="docs/screenshots/playtest.png" width="720" alt="Playtest overlay">
<p><sub>Playtest straight from the editor — score · coins · lives · time HUD</sub></p>

<img src="docs/screenshots/sprites.png" width="720" alt="Pixel asset gallery">
<p><sub>113 frames · 4 theme palettes — every sprite authored in-repo</sub></p>
</div>

---

## 🚀 Getting started

All you need is [Bun](https://bun.sh) 1.4+. (Zero runtime dependencies.)

```bash
bun install        # install dev dependencies
bun run dev        # dev server (http://127.0.0.1:4173)
```

Build and preview:

```bash
bun run build      # emit browser bundle to dist/
bun run preview    # serve dist (http://127.0.0.1:4173)
```

Open `http://127.0.0.1:4173`, then **새 코스 만들기** (New Course) → **작업실 열기** (Open Workshop) → **▶ 플레이** (Play).

> 💡 Four sample courses (`솔바람 능선` · `등잔 굴` · `청파 수로` · `불씨 성`) live in `src/level/samples.ts`. Serialize one to `.smb1.json` and open it via the editor toolbar's **가져오기** (Import) — there is no file picker on the library's first screen.

In-depth controls: [`docs/controls.md`](docs/controls.md) · file format: [`docs/format.md`](docs/format.md) · asset/audio sources: [`docs/assets.md`](docs/assets.md). The app UI itself is Korean.

## 🕹️ Controls

| Play | Keys |
| --- | --- |
| Move | `←` `→` or `A` `D` |
| Jump / Swim | `Space` or `Z` |
| Run / Fireball | `Shift` or `X` |
| Crouch / Enter pipe | `↓` or `S` |
| Climb vine | `↑` |
| Pause | `Esc` |

| Editor | Keys / action |
| --- | --- |
| Undo / Redo | `Ctrl+Z` / `Ctrl+Y` |
| Copy / Paste / Delete | `Ctrl+C` / `Ctrl+V` / `Delete` |
| Deselect | `Esc` |
| Pan | middle-drag or `Space`+drag |
| Zoom | `1x`–`8x` buttons (anchored at pointer) |

## 🗂️ Course file format

Courses export and import as `.smb1.json` — a **versioned JSON document** (`format: "smb1-maker", version: 1`).

- Sparse tile map + placed objects with coordinates and typed properties
- Cross references (pipe destinations, balance pairs, warp slots) are validated reciprocally
- Up to 32 MiB, 16 areas — imports are atomic: a failure never overwrites the open course
- Bad JSON/versions/references are rejected with concrete codes (`malformed_json`, `invalid_reference` …)

## 🧱 Tech stack

| Area | Choice |
| --- | --- |
| Language | TypeScript (`strict`, `noUncheckedIndexedAccess`) |
| Rendering | Canvas 2D — 256×240 logical resolution, pixel-perfect scaling |
| Simulation | Fixed 60Hz step, deterministic, DOM-free (`src/game`) |
| Audio | Web Audio API live chiptune synthesis |
| Storage | IndexedDB transactional autosave + file import/export |
| Tooling | Bun (dev/build/test) · Biome · real-browser Playwright QA |
| Runtime deps | **None** — plain DOM + Canvas, no game/UI framework |

```
src/
├── game/       fixed-step simulation (physics·collision·enemies·items·goals)
├── editor/     edit commands · history · paint · selection · areas
├── level/      course schema · validation · serialization · catalog · samples
├── render/     pixel-art atlas · scene renderer
├── audio/      chiptune scheduler · instruments · effects
├── storage/    IndexedDB · autosave · library · files
└── ui/         library · editor · inspector · HUD
```

## ✅ Development

```bash
bun test               # unit/integration tests (27 suites)
bun run typecheck      # tsc --noEmit
bun run diagnostics    # code diagnostics
bun run qa --scenario all --evidence <dir>   # real-browser QA scenarios
bun run scripts/screenshots.ts               # regenerate this README's screenshots
```

Every screenshot was captured from the real built app. To regenerate, run `bun run preview`, then the script above (`PREVIEW_ORIGIN` overrides the address).

## 📜 License

[MIT](LICENSE) — covers the code and the pixel-art/music data authored in this repository.

> ⚠️ This is an unofficial fan project, not affiliated with Nintendo. All rights to the *Super Mario Bros.* names and characters belong to Nintendo; the sprites and music here are **original reinterpretations** — no ROM or original assets were copied. Commercial use is not recommended.
