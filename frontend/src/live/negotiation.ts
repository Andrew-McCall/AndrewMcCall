// The rules two browsers follow to agree on a connection, kept pure so they can
// be tested without a browser. Nothing here touches an RTCPeerConnection.

// The four transceivers every connection carries, in the order they are
// created. The mid *is* the source: mid "0" is always a microphone, mid "3" is
// always a screen, in both directions, for everyone. That is what lets a source
// be switched on mid-call with replaceTrack instead of a renegotiation.
export const MIDS = ["mic", "app", "camera", "screen"] as const;

export type SourceName = (typeof MIDS)[number];

// Who sends the offer. Join sequences are handed out by the server and never
// reused, so both ends reach the same answer from the roster they already hold
// — no simultaneous offers, and no glare to resolve.
export function weOffer(ourSeq: number, theirSeq: number): boolean {
  return ourSeq < theirSeq;
}

export function sourceOfMid(mid: string | null): SourceName | null {
  if (mid === null) return null;
  const index = Number(mid);
  return Number.isInteger(index) ? (MIDS[index] ?? null) : null;
}

export function midOfSource(source: SourceName): string {
  return String(MIDS.indexOf(source));
}

// Asks for stereo, 128kbps Opus on the application-audio transceiver only.
//
// Opus defaults to a mono, voice-grade bitrate, which is right for a microphone
// and ruinous for music: Spotify through the default settings arrives as a
// mono, heavily compressed version of itself. Only mid 1 is touched, so the
// microphone keeps the settings tuned for speech.
export function withStereoAppAudio(sdp: string): string {
  const sections = sdp.split(/(?=^m=)/m);

  return sections
    .map((section) => {
      if (!/^a=mid:1$/m.test(section)) return section;

      const opus = section.match(/^a=rtpmap:(\d+) opus\/48000\/2$/m);
      if (!opus) return section;
      const payload = opus[1];

      const fmtp = new RegExp(`^a=fmtp:${payload} (.*)$`, "m");
      const wanted = "stereo=1;sprop-stereo=1;maxaveragebitrate=128000";

      if (fmtp.test(section)) {
        return section.replace(fmtp, `a=fmtp:${payload} $1;${wanted}`);
      }
      return section.replace(
        opus[0],
        `${opus[0]}\r\na=fmtp:${payload} ${wanted}`,
      );
    })
    .join("");
}
