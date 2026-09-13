// One room: who is here, what they are publishing, and the connections to
// them.
//
// Joining is opening the event stream and leaving is closing it, so there is no
// join or leave call — only a stream whose lifetime is the membership. The
// media elements are created once per person and kept: re-rendering the page
// would detach a playing video, so the roster updates touch text and classes
// and never the elements carrying media.

import { esc, LINK_CLASS, PAGE_CLASS } from "./helpers";
import { iceServers, joinRoom, setSources } from "./live/api";
import { roomPath, titleFrom } from "./live/link";
import * as media from "./live/media";
import { createMesh, noTracks, type Tracks } from "./live/mesh";
import { apply, labels, type Room } from "./live/roster";
import { watchSpeaking } from "./live/speaking";
import type { SourceName } from "./live/negotiation";
import type { Sources } from "@andrewmccall/api-types";

interface Tile {
  root: HTMLElement;
  camera: HTMLVideoElement;
  mic: HTMLAudioElement;
  app: HTMLAudioElement;
  label: HTMLElement;
  state: HTMLElement;
}

let leave: (() => void) | null = null;
let mesh: ReturnType<typeof createMesh> | null = null;
let tracks: Tracks = noTracks();
let watchers = new Map<string, () => void>();
let tiles = new Map<string, Tile>();
let screens = new Map<string, HTMLVideoElement>();

const CONTROL =
  "border px-3 py-2 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed";
const OFF = `${CONTROL} border-green-900 text-green-600 hover:border-green-600`;
const ON = `${CONTROL} border-green-400 text-green-300 bg-green-950`;

export default (app: HTMLElement, id: string) => {
  // Deliberately without the title: a shared link joins a room that already
  // exists and already has one.
  const link = location.origin + roomPath(id);

  app.innerHTML = `
<div class="${PAGE_CLASS}">
  <h1 id="live-heading" class="italic text-4xl md:text-5xl font-bold bg-linear-to-r from-green-500 via-green-700 to-green-900 bg-clip-text text-transparent text-center">
    ${esc(id)}
  </h1>
  <p id="live-status" class="mt-2 text-green-700">Joining…</p>

  <div class="w-full max-w-4xl mt-6 flex flex-col gap-6">
    <div class="flex flex-wrap gap-2 items-center justify-center">
      <button id="c-mic" class="${OFF}">Microphone</button>
      <button id="c-app" class="${OFF}">App audio</button>
      <button id="c-camera" class="${OFF}">Camera</button>
      <button id="c-screen" class="${OFF}">Screen</button>
      <select id="c-device" class="bg-stone-950 border border-green-900 px-2 py-2 text-green-500 text-sm max-w-60">
        <option value="">app audio: allow the mic once to list devices</option>
      </select>
    </div>

    <button id="live-unblock" class="hidden ${OFF} self-center">
      Click to let this page play sound
    </button>
    <p id="live-error" class="text-sm text-red-400 text-center"></p>

    <div id="live-stage" class="flex flex-col gap-3"></div>
    <div id="live-tiles" class="grid grid-cols-2 md:grid-cols-3 gap-3"></div>

    <div class="flex items-center justify-between gap-2">
      <input id="live-link" class="flex-1 bg-stone-950 border border-green-900 px-3 py-2 text-green-700 font-mono text-sm" readonly value="${esc(link)}" />
      <button id="live-copy" class="${OFF}">Copy</button>
    </div>
    <p class="text-sm text-green-800 -mt-4">
      Anyone signed in can open that link while the room is up. Stop the call and the link dies with it.
    </p>

    <details class="text-sm text-green-800">
      <summary class="cursor-pointer">Connections</summary>
      <div id="live-diagnostics" class="mt-2 flex flex-col gap-1 font-mono"></div>
    </details>
  </div>

  <a href="/secret/live" class="${LINK_CLASS} mt-10">Leave</a>
</div>`;

  const $ = <T extends HTMLElement>(sel: string) => app.querySelector<T>(sel)!;
  const stage = $<HTMLDivElement>("#live-stage");
  const tileBox = $<HTMLDivElement>("#live-tiles");
  const status = $<HTMLParagraphElement>("#live-status");
  const heading = $<HTMLHeadingElement>("#live-heading");
  const errorLine = $<HTMLParagraphElement>("#live-error");
  const unblock = $<HTMLButtonElement>("#live-unblock");
  const devices = $<HTMLSelectElement>("#c-device");
  const diagnostics = $<HTMLDivElement>("#live-diagnostics");

  const copy = $<HTMLButtonElement>("#live-copy");
  copy.onclick = async () => {
    await navigator.clipboard.writeText(link);
    copy.textContent = "Copied";
    setTimeout(() => (copy.textContent = "Copy"), 1500);
  };

  let room: Room | null = null;
  let sources: Sources = { mic: false, app: false, camera: false, screen: false };

  const fail = (message: string) => (errorLine.textContent = message);

  // Autoplay with sound needs a user gesture, and a pasted link arrives without
  // one. Rather than silently playing nothing, ask once.
  const play = (element: HTMLMediaElement) => {
    element.play().catch(() => unblock.classList.remove("hidden"));
  };
  unblock.onclick = () => {
    tiles.forEach((tile) => {
      void tile.mic.play();
      void tile.app.play();
    });
    screens.forEach((video) => void video.play());
    unblock.classList.add("hidden");
  };

  const tileFor = (peerId: string, name: string): Tile => {
    const existing = tiles.get(peerId);
    if (existing) return existing;

    const root = document.createElement("div");
    root.className =
      "border border-green-900 p-2 flex flex-col gap-2 transition-colors";
    root.innerHTML = `
      <video class="w-full aspect-video bg-stone-950 object-cover hidden" playsinline autoplay></video>
      <div class="flex items-center justify-between gap-2">
        <span class="text-green-400 truncate">${esc(name)}</span>
        <span class="text-xs text-green-800"></span>
      </div>`;

    const tile: Tile = {
      root,
      camera: root.querySelector("video")!,
      mic: document.createElement("audio"),
      app: document.createElement("audio"),
      label: root.querySelector("span")!,
      state: root.querySelectorAll("span")[1] as HTMLElement,
    };
    // Muted on your own tile: a microphone playing back through the same
    // speakers is feedback.
    tile.mic.autoplay = tile.app.autoplay = true;
    tile.mic.muted = tile.app.muted = peerId === room?.self;
    root.append(tile.mic, tile.app);

    tiles.set(peerId, tile);
    tileBox.append(root);
    return tile;
  };

  const screenFor = (peerId: string): HTMLVideoElement => {
    const existing = screens.get(peerId);
    if (existing) return existing;

    const video = document.createElement("video");
    video.className = "w-full bg-stone-950 border border-green-900";
    video.autoplay = video.playsInline = true;
    video.muted = true; // screen shares carry no audio here; app audio is its own mid
    screens.set(peerId, video);
    stage.append(video);
    return video;
  };

  const dropScreen = (peerId: string) => {
    screens.get(peerId)?.remove();
    screens.delete(peerId);
  };

  const drop = (peerId: string) => {
    watchers.get(peerId)?.();
    watchers.delete(peerId);
    tiles.get(peerId)?.root.remove();
    tiles.delete(peerId);
    dropScreen(peerId);
  };

  const render = () => {
    if (!room) return;
    heading.textContent = room.title;

    tileFor(room.self, "you").label.textContent = "you";

    // One account signed in twice is two participants with one name; numbering
    // them is the difference between two tiles and two identical tiles.
    const names = labels(room.peers);

    room.peers.forEach((peer) => {
      const name = names.get(peer.peer_id) ?? peer.name;
      const tile = tileFor(peer.peer_id, name);
      const off = [
        peer.sources.mic ? "" : "mic off",
        peer.sources.camera ? "" : "camera off",
      ].filter(Boolean);
      tile.label.textContent = name;
      tile.state.textContent = off.join(" · ");
      tile.camera.classList.toggle("hidden", !peer.sources.camera);
    });

    // Anyone whose tile is still here but who has left the roster.
    const here = new Set([room.self, ...room.peers.map((p) => p.peer_id)]);
    [...tiles.keys()].filter((id) => !here.has(id)).forEach(drop);

    const publishing = room.peers.filter(
      (peer) => peer.sources.camera || peer.sources.screen,
    ).length;
    status.textContent =
      publishing > 2
        ? `${publishing} people are sending video — a mesh this size will struggle`
        : "Here now";
  };

  // --- publishing ---------------------------------------------------------

  const announce = () => {
    if (room) void setSources(id, room.self, sources);
  };

  const setTrack = (source: SourceName, track: MediaStreamTrack | null) => {
    tracks[source]?.stop();
    tracks = { ...tracks, [source]: track };
    mesh?.setTracks(tracks);
    sources = { ...sources, [source]: Boolean(track) };
    announce();
    render();

    const button = app.querySelector<HTMLButtonElement>(`#c-${source}`)!;
    button.className = track ? ON : OFF;

    if (source === "mic" && room) {
      const tile = tileFor(room.self, "you");
      watchers.get(room.self)?.();
      watchers.delete(room.self);
      if (track) {
        watchers.set(
          room.self,
          watchSpeaking(track, (talking) => {
            tile.root.classList.toggle("border-green-400", talking);
            tile.root.classList.toggle("border-green-900", !talking);
          }),
        );
      }
    }
    if (source === "camera" && room) {
      const tile = tileFor(room.self, "you");
      tile.camera.srcObject = track ? new MediaStream([track]) : null;
      tile.camera.muted = true;
      tile.camera.classList.toggle("hidden", !track);
      if (track) play(tile.camera);
    }
    if (source === "screen" && room) {
      const video = screenFor(room.self);
      video.srcObject = track ? new MediaStream([track]) : null;
      if (track) play(video);
      else dropScreen(room.self);
    }
  };

  const toggle = async (source: SourceName, start: () => Promise<MediaStreamTrack>) => {
    try {
      if (tracks[source]) return setTrack(source, null);
      const track = await start();
      // A screen share ends from the browser's own bar, not only our button.
      track.onended = () => setTrack(source, null);
      setTrack(source, track);
      if (source === "mic") void listDevices();
    } catch (err) {
      fail(err instanceof Error ? err.message : `Could not start the ${source}.`);
    }
  };

  const listDevices = async () => {
    const inputs = await media.audioInputs();
    const labelled = inputs.filter((device) => device.label);
    if (!labelled.length) return;
    devices.innerHTML = labelled
      .map(
        (device) =>
          `<option value="${esc(device.deviceId)}">${esc(device.label)}</option>`,
      )
      .join("");
  };

  $<HTMLButtonElement>("#c-mic").onclick = () => toggle("mic", () => media.mic());
  $<HTMLButtonElement>("#c-camera").onclick = () => toggle("camera", media.camera);
  $<HTMLButtonElement>("#c-screen").onclick = () => toggle("screen", media.screen);
  $<HTMLButtonElement>("#c-app").onclick = () =>
    toggle("app", () => {
      const device = devices.value;
      if (!device) {
        throw new Error(
          "Pick an app-audio device first — allow the microphone once so the list fills in.",
        );
      }
      return media.appAudio(device);
    });

  // --- the room -----------------------------------------------------------

  const start = async () => {
    let servers: RTCIceServer[] = [];
    try {
      servers = await iceServers();
    } catch {
      // A missing ICE list is not fatal: host candidates alone connect two
      // machines on the same network, which is worth having.
    }

    leave?.();
    leave = joinRoom(id, titleFrom(location.search), {
      hello: (data) => {
        room = apply(room, { kind: "hello", ...data });
        mesh = createMesh(id, data.peer_id, data.seq, servers, {
          track: (peerId, source, track) => {
            const known = room?.peers.find((peer) => peer.peer_id === peerId);
            const tile = tileFor(peerId, known?.name ?? "…");
            if (source === "camera") {
              tile.camera.srcObject = new MediaStream([track]);
              play(tile.camera);
            } else if (source === "screen") {
              const video = screenFor(peerId);
              video.srcObject = new MediaStream([track]);
              play(video);
            } else {
              const element = source === "mic" ? tile.mic : tile.app;
              element.srcObject = new MediaStream([track]);
              play(element);
              if (source === "mic") {
                watchers.get(peerId)?.();
                watchers.set(
                  peerId,
                  watchSpeaking(track, (talking) => {
                    tile.root.classList.toggle("border-green-400", talking);
                    tile.root.classList.toggle("border-green-900", !talking);
                  }),
                );
              }
            }
            render();
          },
          state: (peerId, state, path) => {
            const line =
              diagnostics.querySelector<HTMLDivElement>(`[data-peer="${peerId}"]`) ??
              Object.assign(document.createElement("div"), {
                className: "text-green-700",
              });
            line.dataset.peer = peerId;
            line.textContent = `${peerId.slice(0, 8)} ${state}${path ? ` via ${path}` : ""}`;
            diagnostics.append(line);
          },
        });
        mesh.setTracks(tracks);
        data.roster.forEach((peer) => void mesh!.add(peer));
        render();
        announce();
      },
      joined: (peer) => {
        room = apply(room, { kind: "peer-joined", peer });
        void mesh?.add(peer);
        render();
      },
      left: (peer_id) => {
        room = apply(room, { kind: "peer-left", peer_id });
        mesh?.remove(peer_id);
        drop(peer_id);
        render();
      },
      sources: (from, next) => {
        room = apply(room, { kind: "sources", from, sources: next });
        render();
      },
      signal: (message) => void mesh?.signal(message),
      dropped: () => {
        // A stream that drops before the first hello never got in: a full room
        // reads exactly like a failed connection from here, so say both.
        if (!room) {
          disposeLiveRoom();
          status.textContent =
            "Could not join. The room may be full, or the connection failed.";
          return;
        }
        status.textContent = "Reconnecting…";
      },
    });
  };

  void start();
};

// Called by the router on the way out. Closing the stream is what tells everyone
// else you left, and stopping the tracks is what turns the camera light off —
// neither is optional tidying.
export const disposeLiveRoom = () => {
  leave?.();
  leave = null;
  mesh?.close();
  mesh = null;
  watchers.forEach((stop) => stop());
  watchers = new Map();
  Object.values(tracks).forEach((track) => track?.stop());
  tracks = noTracks();
  tiles = new Map();
  screens = new Map();
};
