import { describe, expect, it } from "vitest";
import {
  MIDS,
  midOfSource,
  sourceOfMid,
  weOffer,
  withStereoAppAudio,
} from "./negotiation";

describe("who offers", () => {
  it("is whoever joined first", () => {
    expect(weOffer(0, 1)).toBe(true);
    expect(weOffer(1, 0)).toBe(false);
  });

  it("never has both ends offering", () => {
    for (const [a, b] of [[0, 1], [2, 5], [4, 9]]) {
      expect(weOffer(a, b)).not.toBe(weOffer(b, a));
    }
  });
});

describe("the mid layout", () => {
  it("maps each mid to its fixed source", () => {
    expect(MIDS).toEqual(["mic", "app", "camera", "screen"]);
    expect(sourceOfMid("0")).toBe("mic");
    expect(sourceOfMid("3")).toBe("screen");
    expect(midOfSource("camera")).toBe("2");
  });

  it("has nothing to say about a mid it did not create", () => {
    expect(sourceOfMid("9")).toBeNull();
    expect(sourceOfMid(null)).toBeNull();
    expect(sourceOfMid("video")).toBeNull();
  });
});

const sdp = [
  "v=0\r\n",
  "m=audio 9 UDP/TLS/RTP/SAVPF 111\r\n",
  "a=mid:0\r\n",
  "a=rtpmap:111 opus/48000/2\r\n",
  "a=fmtp:111 minptime=10;useinbandfec=1\r\n",
  "m=audio 9 UDP/TLS/RTP/SAVPF 111\r\n",
  "a=mid:1\r\n",
  "a=rtpmap:111 opus/48000/2\r\n",
  "a=fmtp:111 minptime=10;useinbandfec=1\r\n",
].join("");

describe("application audio", () => {
  it("asks for stereo at a bitrate music survives", () => {
    const out = withStereoAppAudio(sdp);

    const appSection = out.split(/(?=^m=)/m).find((s) => /a=mid:1/.test(s))!;
    expect(appSection).toContain("stereo=1");
    expect(appSection).toContain("maxaveragebitrate=128000");
  });

  it("leaves the microphone tuned for speech", () => {
    const out = withStereoAppAudio(sdp);

    const micSection = out.split(/(?=^m=)/m).find((s) => /a=mid:0/.test(s))!;
    expect(micSection).not.toContain("stereo=1");
    expect(micSection).toContain("minptime=10;useinbandfec=1");
  });

  it("keeps what was already negotiated on that line", () => {
    expect(withStereoAppAudio(sdp)).toContain(
      "a=fmtp:111 minptime=10;useinbandfec=1;stereo=1",
    );
  });

  it("leaves an sdp with no application audio alone", () => {
    const plain = "v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=mid:0\r\n";
    expect(withStereoAppAudio(plain)).toBe(plain);
  });
});
