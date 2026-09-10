# 자산 출처

이 저장소의 **모든 스프라이트와 모든 음악·효과음은 이 프로젝트에서 코드로 작성했습니다.** 닌텐도 원작 ROM, 시트, 음원, 바이너리를 넣지 않았고, 원작 그래픽·악보에 대한 소유권도 주장하지 않습니다. 보이는 모습은 슈퍼 마리오 브라더스 1을 떠올리게 하려고 만든 **오리지널 픽셀·칩튠**입니다.

원격 URL에서 에셋을 받지 않습니다. 아틀라스와 점수는 빌드에 포함됩니다.

## 픽셀

손글씨 팔레트 인덱스 행렬입니다.

| 모듈 | 내용 |
| --- | --- |
| `src/assets/pixels-player.ts` | `PLAYER_PIXELS` — 작은/슈퍼/파이어 마리오 포즈 |
| `src/assets/pixels-world.ts` | `WORLD_PIXELS`, `WORLD_PALETTES` — 타일·장식·네 테마 배경색 |
| `src/assets/pixels-enemies.ts` | `ENEMY_PIXELS` — 적·아이템·쿠파 |
| `src/assets/pixels.ts` | `PIXELS = { ...PLAYER_PIXELS, ...WORLD_PIXELS, ...ENEMY_PIXELS }`, `ASSET_KEYS` |
| `src/assets/manifest.ts` | `ASSET_KEYS`를 그대로 `MANIFEST` 프레임으로 펼칩니다. 앵커·팔레트·아틀라스 칸 |

프레임 수를 문서에 고정하지 마세요. 권위 있는 값은 다음 길이입니다.

1. `Object.keys(PIXELS)` / `ASSET_KEYS.length` (`src/assets/pixels.ts`)
2. `MANIFEST.length` (`src/assets/manifest.ts`) — `ASSET_KEYS.map(...)`이라 항상 같습니다.

이 문서를 `HEAD`에서 `bun`으로 세면 위 세 값이 모두 113이었습니다. 키가 늘면 그 숫자가 바뀝니다. 애니메이션 묶음은 `FRAME_SEQUENCES`이며 별도 키가 아니라 기존 프레임의 순서입니다.

숨은 블록 `tile.hidden`만 `editorOnly`입니다. 테마 배경은 `THEME_BACKGROUNDS`의 CSS 색입니다.

## 음악과 효과

| 모듈 | 내용 |
| --- | --- |
| `src/assets/music.ts` | 손작성 음표. `musicKeys`, `effectKeys`, `MUSIC`, `EFFECTS` |
| `src/audio/audio.ts` | Web Audio 펄스/삼각/노이즈 합성, 제스처 후에만 `AudioContext` 재개, 동시 효과 최대 16 |

곡 키는 `musicKeys` 배열 길이만큼입니다: `overworld`, `underground`, `underwater`, `castle`, `star`, `hurry`, `death`, `clear`, `gameOver`.

효과 키는 `effectKeys` 길이만큼입니다: `jump`, `coin`, `bump`, `break`, `powerupAppear`, `powerupCollect`, `stomp`, `shellKick`, `fire`, `pipe`, `damage`, `oneUp`, `spring`, `axe`.

파일 주석 그대로, ROM 데이터나 닌텐도 멜로디를 옮긴 것이 아닙니다. 작업실 플레이 오버레이의 **음소거**만 노출되고, 갤러리 `/?qa=audio`의 음량 슬라이더는 진단용입니다.
