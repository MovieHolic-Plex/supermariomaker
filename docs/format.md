# 코스 파일 형식

교환 형식은 JSON, MIME `application/json`, 권장 파일 이름 `제목.smb1.json`입니다. `src/level/types.ts`의 `CourseV1`만 저장합니다. 버전 1에는 마이그레이션이 없습니다. 모르는 필드·종류·버전은 거절하고, 실패하면 호출 쪽 문서를 바꾸지 않습니다.

내보내기 파일 이름은 제목에서 `<>:"/\|?*`와 제어 문자를 `_`로 바꾸고 앞뒤 점을 뗀 뒤 `.smb1.json`을 붙입니다. 비면 `course.smb1.json`입니다. 브라우저 다운로드가 디스크에 남았는지는 앱이 확인하지 않습니다.

가져오기는 바이트 길이를 먼저 봅니다. 32 MiB를 넘으면 `JSON.parse` 전에 거절합니다. 통과하면 새 코스 `id`와 `revision` 0을 부여하고, 영역·오브젝트 ID는 파일 값을 유지합니다. 가져온 `id`로 기존 보관함 항목을 덮어쓰지 않습니다.

## `CourseV1`

필수 키만 허용합니다: `format`, `version`, `id`, `title`, `revision`, `mainAreaId`, `start`, `timerSeconds`, `areas`.

| 필드 | 값 |
| --- | --- |
| `format` | 문자열 `"smb1-maker"` |
| `version` | 숫자 `1`만. 그 외는 `unsupported_version` |
| `id`, `mainAreaId`, 영역·오브젝트 `id` | UUID. 파싱 후 소문자. 코스 전체에서 유일 |
| `title` | 앞뒤 공백 없는 1–80자 |
| `revision` | 0 이상 정수. 저장 동시성 토큰이며 실행 취소 내용이 아닙니다 |
| `start` | `{ areaId, x, y }`. 플레이어 **바닥 중앙** 픽셀. 작은 마리오 콜라이더 12×15가 영역 안에 들어야 합니다 |
| `timerSeconds` | `0`(무제한) 또는 `30`–`999`. `1`–`29`는 거절 |

`AreaV1`: `{ id, name, theme, width, height, tiles, objects }`. `theme`는 `overworld` \| `underground` \| `underwater` \| `castle`. `name`은 문자열입니다. 파일 검증기는 길이·공백을 보지 않고, 작업실 **이름 변경**만 앞뒤 공백 없이 1–80자를 요구합니다.

타일 좌표는 칸, 오브젝트 `(x, y)`는 바닥 중앙 픽셀이며 16픽셀 격자(`x % 16 === 0`, `y % 16 === 0`)여야 합니다.

## 한계 (`COURSE_LIMITS`)

| 항목 | 값 |
| --- | --- |
| 영역 수 | 1–16 |
| 영역 너비 | 32–4096 칸 |
| 영역 높이 | 15–128 칸 |
| 채워진 칸 합 | 262144 |
| 배치 오브젝트 합 | 4096 |
| UTF-8 파일 | 32 MiB (`32 * 1024 * 1024` 바이트) |
| 격자 | 16 픽셀 |

칸은 희소 배열입니다. 같은 좌표에 타일 두 개, 음수·영역 밖, 다리와 겹친 타일은 거절합니다.

## 타일 (`TILE_KINDS`)

| `kind` | 화면 라벨 | `content` |
| --- | --- | --- |
| `ground` | 땅 | 없음 |
| `brick` | 벽돌 | 선택. 기본 `none` |
| `question` | 물음표 블록 | 선택. 기본 `coin` |
| `hidden` | 숨은 블록 | 선택. 기본 `coin` |
| `used` | 사용한 블록 | 없음 |
| `hard` | 단단한 블록 | 없음 |
| `coin` | 코인 | 없음 |

`brick` \| `question` \| `hidden`의 `content`: `none` \| `coin` \| `multiCoin` \| `powerup` \| `star` \| `oneUp` \| `vine`.

## 배치 오브젝트 (`OBJECT_KINDS`)

기본값은 `OBJECT_CATALOG`. 비어 있는 `props`는 `{}`입니다.

| `kind` | 라벨 | `props` |
| --- | --- | --- |
| `pipe` | 토관 | `height` 2–16칸, `entrance` `none`\|`down`\|`up`, 선택 `destination: { areaId, pipeId }` (서로 다른 토관의 양방향 링크) |
| `platform` | 발판 | `motion` `horizontal`\|`vertical`\|`falling`\|`balance`, `length` 2–8, `travel` 1–32, `speed` `0.5`\|`1`\|`2`, 균형일 때 선택 `pairId` |
| `spring` | 스프링 | `{}` |
| `flagGoal` | 깃발 목표 | `height` 4–12칸. 기본 9 |
| `castleGoal` | 성 목표 | `bridge: { x, y, width, height: 1 }` 칸 좌표, `width` 1–64, 빈 칸 위. 선택 `bowserId` |
| `goomba` | 굼바 | `{}` |
| `koopa` | 엉금엉금 | `color` `green`\|`red` |
| `paratroopa` | 펄럭펄럭 | `color`, `motion` `hop`\|`vertical` |
| `piranha` | 뻐끔플라워 | `pipeId` (같은 영역 토관 입구 좌표와 일치) |
| `buzzy` | 하잉바 | `{}` |
| `billCannon` | 킬러 대포 | `{}` |
| `hammerBro` | 해머브러스 | `{}` |
| `lakitu` | 김수한무 | `{}` |
| `cheep` | 뽀꾸뽀꾸 | `mode` `swim`\|`leap`, `color` `green`\|`red` |
| `blooper` | 징오징오 | `{}` |
| `podoboo` | 버블 | `{}` |
| `firebar` | 파이어바 | `length` 3–12, `direction` `cw`\|`ccw`, `speed` `slow`\|`normal`\|`fast` |
| `bowser` | 쿠파 | `{}` |
| `warpZone` | 워프 존 | `pipeIds` 길이 3, 각 값은 같은 영역 토관 ID 또는 `null` |

플레이 중에만 생기는 종류(`SPAWNED_KINDS`): `shell`, `bulletBill`, `spiny`, `spinyEgg`, `hammer`, `fireball`, `mushroom`, `flower`, `star`, `oneUp`, `vine`, `bowserFlame`. 파일에 배치 오브젝트로 넣지 않습니다.

불완전한 초안(목표 없음, 토관 미연결, 균형 짝 없음)은 **저장·가져오기**가 될 수 있습니다. 플레이는 시작이 막히지 않아야 하고, 목표가 없으면 **목표 없이 테스트**가 필요합니다.

## 로컬 저장

데이터베이스 이름 `smb1-maker`, 버전 1, 저장소 `courses`(키 `id`)와 `settings`(키 `key`). 코스 레코드는 `{ id, title, updatedAt, document }`. 계정이나 원격 사본은 없습니다. 브라우저가 IndexedDB를 지우면 보관함도 사라집니다. 백업은 내보낸 JSON입니다.

## 작은 예

검증기가 받는 최소에 가까운 초안입니다. 깃발은 32칸 폭 안에 들어야 합니다.

```json
{
  "format": "smb1-maker",
  "version": 1,
  "id": "11111111-1111-4111-8111-111111111111",
  "title": "예제",
  "revision": 0,
  "mainAreaId": "22222222-2222-4222-8222-222222222222",
  "start": {
    "areaId": "22222222-2222-4222-8222-222222222222",
    "x": 40,
    "y": 208
  },
  "timerSeconds": 400,
  "areas": [
    {
      "id": "22222222-2222-4222-8222-222222222222",
      "name": "지상",
      "theme": "overworld",
      "width": 32,
      "height": 15,
      "tiles": [
        { "x": 2, "y": 13, "kind": "ground" },
        { "x": 2, "y": 14, "kind": "ground" }
      ],
      "objects": [
        {
          "id": "33333333-3333-4333-8333-333333333333",
          "kind": "flagGoal",
          "x": 480,
          "y": 208,
          "props": { "height": 9 }
        }
      ]
    }
  ]
}
```
