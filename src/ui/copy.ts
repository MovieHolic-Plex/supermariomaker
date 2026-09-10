const VALIDATION_KO: Readonly<Record<string, string>> = {
  "Spawn intersects solid terrain": "시작 위치가 단단한 지형과 겹칩니다.",
  "Spawn intersects a solid object": "시작 위치가 단단한 오브젝트와 겹칩니다.",
  "Spawn intersects a bridge": "시작 위치가 다리와 겹칩니다.",
  "File is not valid JSON": "파일이 올바른 JSON이 아닙니다.",
  "File is not valid UTF-8": "파일이 올바른 UTF-8이 아닙니다.",
  "Unsupported value": "지원하지 않는 값입니다.",
  "Course files may not exceed 32 MiB of UTF-8": "코스 파일은 UTF-8 기준 32 MiB를 넘을 수 없습니다.",
  "IDs must be unique throughout the course": "코스 전체에서 ID는 고유해야 합니다.",
  "Expected an object": "객체여야 합니다.",
  "Unknown property": "지원하지 않는 속성입니다.",
  "Spawn area does not exist": "시작 영역이 없습니다.",
  "Entire player collider must fit the spawn area": "플레이어 전체가 시작 영역 안에 있어야 합니다.",
  "Preview requires a goal or explicit goal-free testing": "목표가 필요하거나 '목표 없이 테스트'를 선택하세요.",
};

export function koreanValidation(message: string): string {
  return VALIDATION_KO[message] ?? message;
}
