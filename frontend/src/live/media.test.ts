import { describe, expect, it } from "vitest";
import { looksLikeMonitor } from "./media";

describe("spotting an application-audio device", () => {
  it("recognises what the desktop calls them", () => {
    expect(looksLikeMonitor("Monitor of Built-in Audio Analog Stereo")).toBe(true);
    expect(looksLikeMonitor("pw-loopback Spotify")).toBe(true);
  });

  it("leaves real microphones alone", () => {
    expect(looksLikeMonitor("Built-in Audio Analog Stereo")).toBe(false);
    expect(looksLikeMonitor("Yeti Nano")).toBe(false);
  });
});
