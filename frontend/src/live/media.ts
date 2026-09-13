// Getting hold of the four things this page can publish.
//
// The constraints matter more than the calls do: the browser's defaults are
// tuned for a person talking into a laptop, and applying them to music is what
// makes shared audio sound like a phone call.

export async function mic(deviceId?: string): Promise<MediaStreamTrack> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: deviceId ? { deviceId: { exact: deviceId } } : true,
  });
  return stream.getAudioTracks()[0]!;
}

// Application audio — a PipeWire monitor picked from the device list, so
// Spotify can be shared without sharing a screen.
//
// Every voice filter is turned off deliberately. Automatic gain control pumps
// with the track, noise suppression treats sustained notes as noise, and echo
// cancellation mangles anything that is not speech. Stereo is asked for here
// and again in the SDP — the constraint governs capture, the SDP governs what
// is sent.
export async function appAudio(deviceId: string): Promise<MediaStreamTrack> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      deviceId: { exact: deviceId },
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      channelCount: 2,
    },
  });
  return stream.getAudioTracks()[0]!;
}

export async function camera(): Promise<MediaStreamTrack> {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { width: { ideal: 1280 }, height: { ideal: 720 } },
  });
  return stream.getVideoTracks()[0]!;
}

// Screen share at 15fps: a screen is mostly still, and halving the frame rate
// roughly halves the bitrate — which matters when it is being sent to everyone
// in the room separately.
export async function screen(): Promise<MediaStreamTrack> {
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: { frameRate: { ideal: 15 } },
    audio: false,
  });
  return stream.getVideoTracks()[0]!;
}

// Audio inputs, monitors first. Labels are empty until permission has been
// granted once, which is why the picker only fills in after the microphone has
// been allowed.
export async function audioInputs(): Promise<MediaDeviceInfo[]> {
  const devices = await navigator.mediaDevices.enumerateDevices();
  const inputs = devices.filter((device) => device.kind === "audioinput");
  return [
    ...inputs.filter((device) => looksLikeMonitor(device.label)),
    ...inputs.filter((device) => !looksLikeMonitor(device.label)),
  ];
}

// Whether a device label reads like the output of an application rather than a
// microphone. Firefox lists these as "Monitor of …"; a pw-loopback virtual
// device usually carries "loopback" instead.
export function looksLikeMonitor(label: string): boolean {
  return /monitor|loopback/i.test(label);
}
