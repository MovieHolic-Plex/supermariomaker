import { pasteObjects, type PixelDelta } from "./commands";
import { type CommitOutcome, type EditorHistory } from "./history";
import { deleteSelection, type EditorSelection } from "./selection";
import type { CourseV1, PlacedObject } from "../level/types";

export type ClipboardSnapshot = Readonly<{
  sourceAreaId: string;
  objects: readonly PlacedObject[];
  omittedIds: readonly string[];
}>;

export type PasteAction = Readonly<{
  outcome: CommitOutcome;
  omittedIds: readonly string[];
  pastedIds: readonly string[];
}>;

export type Clipboard = {
  contents(): ClipboardSnapshot | null;
  copy(course: CourseV1, selection: EditorSelection): ClipboardSnapshot;
  cut(history: EditorHistory, selection: EditorSelection): Readonly<{ outcome: CommitOutcome; snapshot: ClipboardSnapshot }>;
  paste(history: EditorHistory, areaId: string, delta: PixelDelta, idFor: (id: string) => string): PasteAction;
  duplicate(
    history: EditorHistory,
    selection: EditorSelection,
    idFor: (id: string) => string,
    delta?: PixelDelta,
  ): PasteAction;
};

function cloneObject(object: PlacedObject): PlacedObject {
  return structuredClone(object);
}

function collect(course: CourseV1, selection: EditorSelection): ClipboardSnapshot {
  const area = course.areas.find((item) => item.id === selection.areaId);
  const byId = new Map((area?.objects ?? []).map((object) => [object.id, object]));
  const picked: PlacedObject[] = [];
  for (const id of selection.objectIds) {
    const object = byId.get(id);
    if (object) picked.push(object);
  }
  const copied = new Set(picked.map((object) => object.id));
  const objects: PlacedObject[] = [];
  const omittedIds: string[] = [];
  for (const object of picked) {
    if (object.kind === "piranha" && !copied.has(object.props.pipeId)) omittedIds.push(object.id);
    else objects.push(cloneObject(object));
  }
  return { sourceAreaId: selection.areaId, objects, omittedIds };
}

const emptyPaste = (outcome: CommitOutcome, omittedIds: readonly string[] = []): PasteAction =>
  ({ outcome, omittedIds, pastedIds: [] });

/** App-local copy buffer. Not a CourseV1 field and never written through history. */
export function createClipboard(): Clipboard {
  let snapshot: ClipboardSnapshot | null = null;
  return {
    contents: () => snapshot,
    copy(course, selection) {
      snapshot = collect(course, selection);
      return snapshot;
    },
    cut(history, selection) {
      const copied = this.copy(history.document(), selection);
      return { outcome: deleteSelection(history, selection), snapshot: copied };
    },
    paste(history, areaId, delta, idFor) {
      if (!snapshot) return emptyPaste({ status: "noop", document: history.document() });
      const omittedIds = snapshot.omittedIds;
      if (snapshot.objects.length === 0) {
        return emptyPaste(history.commit(history.document()), omittedIds);
      }
      const ids: string[] = [];
      const result = pasteObjects(history.document(), areaId, snapshot.objects, {
        dx: delta.dx, dy: delta.dy,
        idFor: (id) => {
          const next = idFor(id);
          ids.push(next);
          return next;
        },
      });
      if (!result.ok) return emptyPaste(history.commit(result), omittedIds);
      const outcome = history.commit(result.value.course);
      if (outcome.status !== "committed") {
        return emptyPaste(outcome, [...omittedIds, ...result.value.omittedIds]);
      }
      return {
        outcome,
        omittedIds: [...omittedIds, ...result.value.omittedIds],
        pastedIds: ids,
      };
    },
    duplicate(history, selection, idFor, delta = { dx: 16, dy: 0 }) {
      this.copy(history.document(), selection);
      return this.paste(history, selection.areaId, delta, idFor);
    },
  };
}
