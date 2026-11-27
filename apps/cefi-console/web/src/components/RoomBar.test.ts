import { describe, expect, it } from "vitest";
import { leanText } from "./RoomBar.tsx";

describe("leanText", () => {
  it("says which way and how far, capped at the limit", () => {
    expect(leanText(0.876)).toBe("88% long");
    expect(leanText(-0.1)).toBe("10% short");
    expect(leanText(0)).toBe("flat");
    expect(leanText(0.004)).toBe("flat");
    expect(leanText(-1.3)).toBe("100% short");
  });
});
