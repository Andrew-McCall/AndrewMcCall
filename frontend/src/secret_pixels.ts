// Pixel Shape Generator. Everything is client-side: the shape table in
// `pixels/shapes.ts` says which controls to draw, the rasterisers turn those
// values into a grid of cells, and the canvas here blows that grid up with
// `image-rendering: pixelated` — one device pixel per cell normally, several
// each once Pixel size asks for gaps between them.

import { PAGE_CLASS, pageTitle, setMeta } from "./helpers";
import {
  rowCountText,
  rowStats,
  spansOf,
  toPngBlob,
  toSvg,
  download,
} from "./pixels/export";
import { GRID_BOLD, GRID_FINE, gridOffset, line } from "./pixels/grid";
import { backingScale, cellRect } from "./pixels/render";
import type { Mask, Mode } from "./pixels/mask";
import {
  SHAPES,
  defaultsFor,
  generate,
  maxThicknessFor,
  shapeById,
  visibleInputs,
  type Input,
  type Values,
} from "./pixels/shapes";

const FIELD =
  "bg-stone-900 border border-green-900 focus:border-green-600 outline-none px-3 py-2 text-green-300 font-mono";

const BUTTON =
  "border border-green-900 hover:border-green-600 px-3 py-2 text-green-300 font-mono cursor-pointer transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-green-500 focus-visible:ring-offset-2 focus-visible:ring-offset-stone-950";

const MODES: { id: Mode; label: string; hint: string }[] = [
  { id: "outline", label: "Outline", hint: "One cell thick" },
  {
    id: "diagonal",
    label: "Outline + diagonals",
    hint: "No diagonal gaps to see through",
  },
  { id: "thick", label: "Wall", hint: "A wall of the depth you choose" },
  { id: "filled", label: "Filled", hint: "Solid" },
];

export default (app: HTMLElement) => {
  setMeta(
    "Pixel Shapes",
    "Generate pixel-grid circles, ellipses, semi and quarter circles, squares and stars, with wall thickness and edge smoothing.",
  );

  app.innerHTML = `
<div class="${PAGE_CLASS}">
  ${pageTitle("Pixel Shapes")}

  <p class="mt-3 text-green-800 font-mono text-sm text-center max-w-xl">
    Circles that are just right -.- pick a shape, set the size, and see for yourself.
  </p>

  <div class="w-full max-w-5xl mt-8 flex flex-col lg:flex-row gap-6">
    <div class="lg:w-72 shrink-0 flex flex-col gap-5">
      <select id="px-shape" class="${FIELD} w-full">
        ${SHAPES.map((shape) => `<option value="${shape.id}">${shape.label}</option>`).join("")}
      </select>

      <div id="px-inputs" class="flex flex-col gap-3"></div>

      <div class="flex flex-col gap-2">
        <span class="text-green-600 uppercase tracking-widest text-xs font-bold">Mode</span>
        <div id="px-modes" class="grid grid-cols-2 gap-2"></div>
      </div>

      <label id="px-thickness-row" class="flex flex-col gap-1 font-mono text-sm text-green-300">
        <span class="flex justify-between">
          <span>Wall depth</span>
          <span id="px-thickness-value" class="text-green-600"></span>
        </span>
        <input id="px-thickness" type="range" min="2" step="1" class="accent-green-600 w-full" />
      </label>

      <label id="px-bias-row" class="flex flex-col gap-1 font-mono text-sm text-green-300">
        <span class="flex justify-between">
          <span title="Shifts the edge in or out by this many cells">Smoothing</span>
          <span id="px-bias-value" class="text-green-600"></span>
        </span>
        <input id="px-bias" type="range" min="-1" max="1" step="0.05" value="0" class="accent-green-600 w-full" />
      </label>

      <label class="flex flex-col gap-1 font-mono text-sm text-green-300">
        <span class="flex justify-between">
          <span title="Draw each pixel smaller than its cell, leaving gaps between them">Pixel size</span>
          <span id="px-pixel-value" class="text-green-600"></span>
        </span>
        <input id="px-pixel" type="range" min="0.1" max="1" step="0.05" value="1" class="accent-green-600 w-full" />
      </label>

      <div class="flex flex-wrap gap-4 font-mono text-sm text-green-300">
        <label class="flex items-center gap-2 cursor-pointer select-none" title="Rule the preview, centred on the shape">
          <input id="px-grid" type="checkbox" class="accent-green-600" /> Grid
        </label>
        <label class="flex items-center gap-2 select-none" title="Cells per grid square">
          every
          <input id="px-grid-step" type="number" min="1" max="64" value="5"
            class="${FIELD} w-16 py-1" />
        </label>
        <label class="flex items-center gap-2 cursor-pointer select-none">
          Colour
          <input id="px-colour" type="color" value="#a3e635"
            class="w-8 h-8 bg-transparent border border-green-900 cursor-pointer" />
        </label>
      </div>
    </div>

    <div class="flex-1 min-w-0 flex flex-col gap-4">
      <div class="relative border border-green-900 bg-stone-950 p-2">
        <canvas id="px-canvas" class="w-full block" style="image-rendering: pixelated;"></canvas>
        <div id="px-overlay" class="absolute top-2 left-2 right-2 pointer-events-none hidden"></div>
      </div>

      <div class="flex flex-wrap items-center gap-3 font-mono text-sm text-green-800">
        <span id="px-size"></span>
        <span id="px-hover" class="text-green-600"></span>
      </div>

      <div class="flex flex-wrap items-center gap-2">
        <button id="px-png" class="${BUTTON}">Download PNG</button>
        <label class="flex items-center gap-2 font-mono text-sm text-green-300">
          at
          <input id="px-cell" type="number" min="1" max="32" value="8" class="${FIELD} w-16 py-1" />
          px
        </label>
        <button id="px-svg" class="${BUTTON}">Download SVG</button>
        <label class="flex items-center gap-2 font-mono text-sm text-green-300 cursor-pointer select-none">
          <input id="px-transparent" type="checkbox" checked class="accent-green-600" />
          Transparent
        </label>
      </div>

      <div class="flex flex-col gap-2">
        <div class="flex items-center justify-between">
          <span class="text-green-600 uppercase tracking-widest text-xs font-bold">Rows</span>
          <div class="flex items-center gap-3">
            <span id="px-total" class="text-green-800 font-mono text-xs"></span>
            <button id="px-copy" class="${BUTTON} py-1 text-xs">Copy</button>
          </div>
        </div>
        <div class="border border-green-900 bg-stone-900 overflow-auto">
          <table class="w-full font-mono text-xs">
            <thead>
              <tr class="sticky top-0 bg-stone-950 text-green-600 uppercase tracking-widest">
                <th class="text-right px-3 py-2 w-12">y</th>
                <th class="text-right px-3 py-2 w-16">Cells</th>
                <th class="text-left px-3 py-2">Spans</th>
              </tr>
            </thead>
            <tbody id="px-rows"></tbody>
          </table>
        </div>
      </div>
    </div>
  </div>
</div>
`;

  const $ = <T extends HTMLElement>(id: string) =>
    app.querySelector<T>(`#${id}`)!;

  const shapeSelect = $<HTMLSelectElement>("px-shape");
  const inputsSlot = $<HTMLDivElement>("px-inputs");
  const modesSlot = $<HTMLDivElement>("px-modes");
  const thicknessRow = $<HTMLLabelElement>("px-thickness-row");
  const thickness = $<HTMLInputElement>("px-thickness");
  const thicknessValue = $<HTMLSpanElement>("px-thickness-value");
  const biasRow = $<HTMLLabelElement>("px-bias-row");
  const bias = $<HTMLInputElement>("px-bias");
  const biasValue = $<HTMLSpanElement>("px-bias-value");
  const pixelScale = $<HTMLInputElement>("px-pixel");
  const pixelValue = $<HTMLSpanElement>("px-pixel-value");
  const gridToggle = $<HTMLInputElement>("px-grid");
  const gridStep = $<HTMLInputElement>("px-grid-step");
  const colour = $<HTMLInputElement>("px-colour");
  const canvas = $<HTMLCanvasElement>("px-canvas");
  const overlay = $<HTMLDivElement>("px-overlay");
  const sizeLabel = $<HTMLSpanElement>("px-size");
  const hoverLabel = $<HTMLSpanElement>("px-hover");
  const cellSize = $<HTMLInputElement>("px-cell");
  const transparent = $<HTMLInputElement>("px-transparent");
  const rowsPanel = $<HTMLTableSectionElement>("px-rows");
  const totalLabel = $<HTMLSpanElement>("px-total");

  let shape = SHAPES[0];
  let values: Values = defaultsFor(shape);
  let mode: Mode = "outline";
  let current: Mask = generate(shape, values, {
    mode,
    thickness: 2,
    bias: 0.0,
  });

  const renderInput = (input: Input): string => {
    const label = `<span title="${input.hint ?? ""}">${input.label}</span>`;
    const value = values[input.key];

    if (input.type === "bool") {
      return `<label class="flex items-center gap-2 font-mono text-sm text-green-300 cursor-pointer select-none">
        <input type="checkbox" data-key="${input.key}" class="accent-green-600" ${value ? "checked" : ""} />
        ${label}
      </label>`;
    }

    if (input.type === "choice") {
      return `<label class="flex flex-col gap-1 font-mono text-sm text-green-300">
        ${label}
        <select data-key="${input.key}" class="${FIELD}">
          ${input.options!
            .map(
              (option) =>
                `<option value="${option}" ${option === value ? "selected" : ""}>${option}</option>`,
            )
            .join("")}
        </select>
      </label>`;
    }

    if (input.type === "ratio") {
      return `<label class="flex flex-col gap-1 font-mono text-sm text-green-300">
        <span class="flex justify-between">${label}<span class="text-green-600">${value}</span></span>
        <input type="range" data-key="${input.key}" min="${input.min}" max="${input.max}"
          step="${input.step ?? 0.05}" value="${value}" class="accent-green-600 w-full" />
      </label>`;
    }

    return `<label class="flex flex-col gap-1 font-mono text-sm text-green-300">
      ${label}
      <input type="number" data-key="${input.key}" min="${input.min}" max="${input.max}"
        step="1" value="${value}" class="${FIELD}" />
    </label>`;
  };

  const renderInputs = () => {
    inputsSlot.innerHTML = visibleInputs(shape, values).map(renderInput).join("");
  };

  const renderModes = () => {
    modesSlot.innerHTML = MODES.map(
      (option) => `<button data-mode="${option.id}" title="${option.hint}"
        class="${BUTTON} text-xs text-left ${
          option.id === mode
            ? "border-green-500 text-lime-300 bg-stone-900"
            : ""
        }">${option.label}</button>`,
    ).join("");
  };

  // Only mode 3 has a depth to set, and a square has no edge to smooth.
  const renderSecondaryControls = () => {
    const cap = Math.max(2, maxThicknessFor(shape, values, Number(bias.value)));
    thickness.max = String(cap);
    if (Number(thickness.value) > cap) thickness.value = String(cap);
    if (Number(thickness.value) < 2) thickness.value = "2";
    thicknessValue.textContent = thickness.value;
    thicknessRow.classList.toggle("hidden", mode !== "thick");

    biasValue.textContent = Number(bias.value).toFixed(2);
    biasRow.classList.toggle("hidden", !shape.smoothing);

    pixelValue.textContent = `${Math.round(Number(pixelScale.value) * 100)}%`;
  };

  // The overlay takes the canvas's own aspect ratio rather than being pinned to
  // the box, so the two are the same rectangle to the pixel and the lines sit on
  // real cell boundaries.
  const paintGrid = (mask: Mask) => {
    overlay.classList.toggle("hidden", !gridToggle.checked);
    overlay.style.aspectRatio = `${mask.w} / ${mask.h}`;
    if (!gridToggle.checked) return;

    const step = Math.min(
      Math.max(1, Math.round(Number(gridStep.value) || 1)),
      Math.max(mask.w, mask.h),
    );
    const layers: string[] = [];
    const tiles: string[] = [];
    const add = (layer: string, tile: string) => {
      layers.push(layer);
      tiles.push(tile);
    };

    // Everything is a share of the box, so the grid is measured in cells of the
    // shape and stays put as the shape resizes or the page does.
    //
    // A line per cell as well, but only while the cells are big enough on
    // screen for it to read as a grid instead of a wash.
    if (mask.w <= 64 && mask.h <= 64 && step > 1) {
      add(line("right", GRID_FINE, 0), `${100 / mask.w}% 100%`);
      add(line("bottom", GRID_FINE, 0), `100% ${100 / mask.h}%`);
    }
    add(
      line("right", GRID_BOLD, (gridOffset(mask.w, step) / step) * 100),
      `${(100 * step) / mask.w}% 100%`,
    );
    add(
      line("bottom", GRID_BOLD, (gridOffset(mask.h, step) / step) * 100),
      `100% ${(100 * step) / mask.h}%`,
    );

    overlay.style.backgroundImage = layers.join(",");
    overlay.style.backgroundSize = tiles.join(",");
  };

  // At full size a cell is one device pixel and the whole mask goes down in a
  // single putImageData. Gaps need room inside a cell, so the canvas grows to
  // several pixels each and the cells are drawn one at a time.
  const paintCells = (mask: Mask, pixelSize: number, scale: number) => {
    const context = canvas.getContext("2d")!;
    const rect = cellRect(scale, pixelSize);
    context.fillStyle = colour.value;

    for (let y = 0; y < mask.h; y++) {
      for (let x = 0; x < mask.w; x++) {
        if (!mask.cells[y * mask.w + x]) continue;
        context.fillRect(
          x * scale + rect.offset,
          y * scale + rect.offset,
          rect.size,
          rect.size,
        );
      }
    }
  };

  const paint = (mask: Mask) => {
    const pixelSize = Number(pixelScale.value);
    const scale = backingScale(Math.max(mask.w, mask.h), pixelSize);

    canvas.width = mask.w * scale;
    canvas.height = mask.h * scale;
    canvas.style.aspectRatio = `${mask.w} / ${mask.h}`;

    const context = canvas.getContext("2d")!;
    if (scale > 1) {
      paintCells(mask, pixelSize, scale);
      return paintGrid(mask);
    }

    const image = context.createImageData(mask.w, mask.h);
    const red = parseInt(colour.value.slice(1, 3), 16);
    const green = parseInt(colour.value.slice(3, 5), 16);
    const blue = parseInt(colour.value.slice(5, 7), 16);

    for (let i = 0; i < mask.cells.length; i++) {
      if (!mask.cells[i]) continue;
      image.data[i * 4] = red;
      image.data[i * 4 + 1] = green;
      image.data[i * 4 + 2] = blue;
      image.data[i * 4 + 3] = 255;
    }
    context.putImageData(image, 0, 0);
    paintGrid(mask);
  };

  let frame = 0;
  const draw = () => {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      renderSecondaryControls();
      current = generate(shape, values, {
        mode,
        thickness: Number(thickness.value),
        bias: shape.smoothing ? Number(bias.value) : 0,
      });
      paint(current);
      // The mask is trimmed to what it draws, so this is the size the shape
      // came out at — which is not the size that was asked for once smoothing
      // has moved the edge.
      sizeLabel.textContent = current.cells.some((cell) => cell)
        ? `${current.w} × ${current.h}`
        : "nothing to draw";
      const stats = rowStats(current);
      rowsPanel.innerHTML = stats
        .map(
          (row) => {
            const span = spansOf(row);
            return `<tr data-y="${row.y}" class="odd:bg-stone-950/40">
            <td class="text-right px-3 py-1 text-green-700">${row.y}</td>
            <td class="text-right px-3 py-1 text-lime-300">${span.length > 1 ? row.total: `${row.total} (${row.total/span.length})`}</td>
            <td class="px-3 py-1 text-green-400">${span.join(", ")}</td>
          </tr>`},
        )
        .join("");
      const cells = stats.reduce((sum, row) => sum + row.total, 0);
      totalLabel.textContent = `${cells} cells, ${stats.length} rows`;
    });
  };

  shapeSelect.addEventListener("change", () => {
    shape = shapeById(shapeSelect.value);
    values = defaultsFor(shape, values); // keep any size the new shape shares
    renderInputs();
    draw();
  });

  inputsSlot.addEventListener("input", (event) => {
    const field = event.target as HTMLInputElement | HTMLSelectElement;
    const key = field.dataset.key;
    if (!key) return;

    if (field instanceof HTMLInputElement && field.type === "checkbox") {
      values[key] = field.checked;
      // A tickbox is the only thing `showIf` keys off, so this is the only
      // change that can add or remove a field.
      renderInputs();
    } else if (field instanceof HTMLInputElement && field.type !== "text") {
      values[key] = Number(field.value);
      const readout = field.previousElementSibling?.querySelector("span:last-child");
      if (readout && field.type === "range") readout.textContent = field.value;
    } else {
      values[key] = field.value;
    }
    draw();
  });

  modesSlot.addEventListener("click", (event) => {
    const button = (event.target as HTMLElement).closest("button");
    const chosen = button?.dataset.mode as Mode | undefined;
    if (!chosen) return;
    mode = chosen;
    renderModes();
    draw();
  });

  for (const control of [
    thickness,
    bias,
    pixelScale,
    gridToggle,
    gridStep,
    colour,
  ]) {
    control.addEventListener("input", draw);
  }

  // Lights up the row under the pointer, so the preview and the numbers point
  // at each other rather than being two things to hold in your head at once.
  // Set inline rather than by class, to win over the zebra striping.
  let lit: HTMLElement | null = null;
  const litRow = (y: number | null) => {
    if (lit) lit.style.backgroundColor = "";
    lit = y === null ? null : rowsPanel.querySelector(`tr[data-y="${y}"]`);
    if (lit) lit.style.backgroundColor = "rgba(34,197,94,0.22)";
  };

  canvas.addEventListener("mousemove", (event) => {
    const box = canvas.getBoundingClientRect();
    const cell = (along: number, of: number, count: number) =>
      Math.min(count - 1, Math.max(0, Math.floor((along / of) * count)));
    const x = cell(event.clientX - box.left, box.width, current.w);
    const y = cell(event.clientY - box.top, box.height, current.h);

    // Also from the middle, since the grid is ruled from there.
    const signed = (n: number) => (n > 0 ? `+${n}` : `${n}`);
    const fromCentre = `${signed(x - Math.floor((current.w - 1) / 2))}, ${signed(
      y - Math.floor((current.h - 1) / 2),
    )}`;
    hoverLabel.textContent = `x ${x}, y ${y}   ${fromCentre} from centre`;
    litRow(y);
  });
  canvas.addEventListener("mouseleave", () => {
    hoverLabel.textContent = "";
    litRow(null);
  });

  const filename = (extension: string) =>
    `${shape.id}-${current.w}x${current.h}.${extension}`;

  $("px-png").addEventListener("click", async () => {
    const blob = await toPngBlob(current, {
      cell: Math.max(1, Number(cellSize.value)),
      fill: colour.value,
      background: transparent.checked ? undefined : "#0c0a09",
      pixelSize: Number(pixelScale.value),
    });
    download(blob, filename("png"));
  });

  $("px-svg").addEventListener("click", () => {
    const svg = toSvg(current, {
      fill: colour.value,
      background: transparent.checked ? undefined : "#0c0a09",
      pixelSize: Number(pixelScale.value),
    });
    download(new Blob([svg], { type: "image/svg+xml" }), filename("svg"));
  });

  $("px-copy").addEventListener("click", async (event) => {
    await navigator.clipboard.writeText(rowCountText(current));
    const button = event.currentTarget as HTMLButtonElement;
    button.textContent = "Copied";
    window.setTimeout(() => (button.textContent = "Copy"), 1200);
  });

  renderInputs();
  renderModes();
  draw();
};
