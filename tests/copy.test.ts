import { expect, test } from "bun:test";
import { koreanValidation } from "../src/ui/copy";

test("koreanValidation replaces known English validation sentences and leaves unknown text", () => {
  expect(koreanValidation("Spawn intersects solid terrain")).not.toBe("Spawn intersects solid terrain");
  expect(koreanValidation("IDs must be unique throughout the course")).not.toBe("IDs must be unique throughout the course");
  expect(koreanValidation("Unsupported value")).not.toBe("Unsupported value");
  expect(koreanValidation("not a catalogued validator sentence")).toBe("not a catalogued validator sentence");
});
