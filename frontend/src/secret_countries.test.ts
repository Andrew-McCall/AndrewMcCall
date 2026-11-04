import { describe, expect, it } from "vitest";

import { formatGdp } from "./secret_countries";

describe("formatGdp", () => {
  it("keeps economies under a billion in millions", () => {
    expect(formatGdp(314)).toBe("$314 million");
    expect(formatGdp(999.7)).toBe("$1 billion");
  });

  it("rounds larger economies to billions", () => {
    expect(formatGdp(2_827_113)).toBe("$2,827 billion");
  });
});
