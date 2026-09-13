// The lobby: what is live now, and the button that opens a new room.
//
// The list is pushed rather than polled — `/api/live/events` sends the whole
// room list on subscribing and again whenever it changes, which is cheap
// because a room list is small and the alternative is every open tab asking.

import { esc, LINK_CLASS, PAGE_CLASS, pageTitle } from "./helpers";
import { createRoom, watchLobby } from "./live/api";
import type { RoomSummary } from "@andrewmccall/api-types";

const inputClass =
  "flex-1 bg-stone-950 border border-green-900 focus:border-green-600 outline-none px-3 py-2 text-green-300 placeholder-green-900 font-mono";

const buttonClass =
  "border border-green-900 hover:border-green-500 px-4 py-2 text-green-400 hover:text-green-300 cursor-pointer";

let stopWatching: (() => void) | null = null;

const roomRow = (room: RoomSummary): string => `
  <a href="/secret/live/${encodeURIComponent(room.id)}"
     class="block border border-green-900 hover:border-green-500 px-4 py-3">
    <div class="flex items-center justify-between gap-4">
      <span class="text-green-300">${esc(room.title)}</span>
      <span class="text-sm text-green-700">${room.people}/6</span>
    </div>
    <div class="text-sm text-green-700">started by ${esc(room.started_by)}</div>
  </a>`;

export default (app: HTMLElement) => {
  app.innerHTML = `
<div class="${PAGE_CLASS}">
  ${pageTitle("Live")}
  <p class="mt-2 text-green-700 text-center">Talk to whoever else is signed in.</p>

  <div class="w-full max-w-xl mt-8">
    <div class="flex gap-2">
      <input id="live-title" class="${inputClass}" placeholder="What is it about?" maxlength="60" />
      <button id="live-start" class="${buttonClass}">Start a room</button>
    </div>
    <p id="live-error" class="mt-2 text-sm text-red-400"></p>

    <div id="live-rooms" class="mt-6 flex flex-col gap-3">
      <p class="text-green-700">Nothing live right now.</p>
    </div>
  </div>

  <a href="/secret" class="${LINK_CLASS} mt-10">Back to the secret menu</a>
</div>`;

  const rooms = app.querySelector<HTMLDivElement>("#live-rooms")!;
  const error = app.querySelector<HTMLParagraphElement>("#live-error")!;
  const title = app.querySelector<HTMLInputElement>("#live-title")!;
  const start = app.querySelector<HTMLButtonElement>("#live-start")!;

  start.onclick = async () => {
    start.disabled = true;
    error.textContent = "";
    try {
      const room = await createRoom(title.value);
      window.navigate(`/secret/live/${encodeURIComponent(room.id)}`);
    } catch (err) {
      error.textContent = err instanceof Error ? err.message : "Could not start a room.";
      start.disabled = false;
    }
  };

  stopWatching?.();
  stopWatching = watchLobby((open) => {
    rooms.innerHTML = open.length
      ? open.map(roomRow).join("")
      : `<p class="text-green-700">Nothing live right now.</p>`;
  });
};

// Called by the router on the way out: an event stream left open would keep
// receiving room lists for a page nobody is looking at.
export const disposeLive = () => {
  stopWatching?.();
  stopWatching = null;
};
