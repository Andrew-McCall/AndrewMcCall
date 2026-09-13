// Who is talking. A ring around a tile is the cheapest way to answer "who was
// that?" in a call with more than three people in it.

// Whether a level counts as speech. Two thresholds rather than one: a voice
// sitting exactly on a single threshold flickers the indicator on and off
// several times a second, which is worse than not having one.
export function speaking(level: number, was: boolean): boolean {
  return was ? level > 0.02 : level > 0.05;
}

// Watches an audio track and reports when it starts and stops carrying speech.
// Returns the function that stops watching.
export function watchSpeaking(
  track: MediaStreamTrack,
  onChange: (speaking: boolean) => void,
): () => void {
  const context = new AudioContext();
  const analyser = context.createAnalyser();
  analyser.fftSize = 512;
  context.createMediaStreamSource(new MediaStream([track])).connect(analyser);

  const samples = new Uint8Array(analyser.frequencyBinCount);
  let was = false;

  // Ten times a second: fast enough to feel immediate, and far cheaper than
  // running this on every animation frame for every person in the room.
  const timer = setInterval(() => {
    analyser.getByteTimeDomainData(samples);

    let peak = 0;
    for (const sample of samples) {
      peak = Math.max(peak, Math.abs(sample - 128) / 128);
    }

    const now = speaking(peak, was);
    if (now !== was) {
      was = now;
      onChange(now);
    }
  }, 100);

  return () => {
    clearInterval(timer);
    void context.close();
  };
}
