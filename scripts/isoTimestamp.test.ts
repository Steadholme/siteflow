import { describe, expect, it } from "vitest";
import { strictIsoTimestampValue } from "./isoTimestamp";

describe("strictIsoTimestampValue", () => {
  it("accepts ISO timestamps with explicit UTC or offset time zones", () => {
    expect(strictIsoTimestampValue("2026-06-08T11:45:00.000Z")).toBe("2026-06-08T11:45:00.000Z");
    expect(strictIsoTimestampValue("2026-06-08T19:45:00+08:00")).toBe("2026-06-08T19:45:00+08:00");
  });

  it("rejects loose Date.parse-compatible timestamps and impossible dates", () => {
    expect(strictIsoTimestampValue("June 8, 2026 11:45 UTC")).toBeUndefined();
    expect(strictIsoTimestampValue("2026-02-31T11:45:00.000Z")).toBeUndefined();
  });
});
