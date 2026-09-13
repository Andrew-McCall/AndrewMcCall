// One room. For now it shows who is here; the media sits on top of this in the
// next step.
//
// Joining is opening the event stream and leaving is closing it, so this page
// has no join or leave call — only a stream whose lifetime is the membership.

import { esc, LINK_CLASS, PAGE_CLASS } from "./helpers";
import { joinRoom } from "./live/api";
import { roomPath, titleFrom } from "./live/link";
import { apply, type Room } from "./live/roster";

let leave: (() => void) | null = null;

const render = (app: HTMLElement, room: Room | null, status: string) => {
  const people = app.querySelector<HTMLDivElement>("#live-people");
  const heading = app.querySelector<HTMLHeadingElement>("#live-heading");
  const state = app.querySelector<HTMLParagraphElement>("#live-status");
  if (!people || !heading || !state) return;

  state.textContent = status;
  if (!room) return;

  heading.textContent = room.title;
  const rows = [
    `<li class="text-green-300">you</li>`,
    ...room.peers.map((peer) => `<li class="text-green-400">${esc(peer.name)}</li>`),
  ];
  people.innerHTML = `<ul class="flex flex-col gap-1">${rows.join("")}</ul>`;
};

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

  <div class="w-full max-w-xl mt-8">
    <div class="flex gap-2 items-center">
      <input id="live-link" class="flex-1 bg-stone-950 border border-green-900 px-3 py-2 text-green-700 font-mono text-sm" readonly value="${esc(link)}" />
      <button id="live-copy" class="border border-green-900 hover:border-green-500 px-4 py-2 text-green-400 cursor-pointer">Copy</button>
    </div>
    <p class="mt-2 text-sm text-green-800">Anyone signed in can open that link while the room is up.</p>

    <div id="live-people" class="mt-6"></div>
  </div>

  <a href="/secret/live" class="${LINK_CLASS} mt-10">Leave</a>
</div>`;

  const copy = app.querySelector<HTMLButtonElement>("#live-copy")!;
  copy.onclick = async () => {
    await navigator.clipboard.writeText(link);
    copy.textContent = "Copied";
    setTimeout(() => (copy.textContent = "Copy"), 1500);
  };

  let room: Room | null = null;
  const update = (status: string) => render(app, room, status);

  leave?.();
  leave = joinRoom(id, titleFrom(location.search), {
    hello: (data) => {
      room = apply(room, { kind: "hello", ...data });
      update("Here now");
    },
    joined: (peer) => {
      room = apply(room, { kind: "peer-joined", peer });
      update("Here now");
    },
    left: (peer_id) => {
      room = apply(room, { kind: "peer-left", peer_id });
      update("Here now");
    },
    signal: () => {
      // Nothing to connect yet — the mesh arrives with the media.
    },
    dropped: () => {
      // A stream that drops before the first hello never got in: a full room
      // reads exactly like a failed connection from here, so say both.
      if (!room) {
        disposeLiveRoom();
        update("Could not join. The room may be full, or the connection failed.");
        return;
      }
      update("Reconnecting…");
    },
  });
};

// Called by the router on the way out. Closing the stream is what tells
// everyone else you left, so this is not optional tidying.
export const disposeLiveRoom = () => {
  leave?.();
  leave = null;
};
