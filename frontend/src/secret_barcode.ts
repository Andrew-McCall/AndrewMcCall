// Client-side QR-code and barcode generator. Like the Prettier page, nothing
// is bundled: the two generator libraries (`qrcode` for QR codes, `jsbarcode`
// for 1D barcodes) are pulled from a CDN as ES modules. Each is fetched lazily
// on first use (and cached), and a warm-up kicks the fetches off after the
// page's `load` event so they never block first paint.

const QRCODE_URL = "https://esm.sh/qrcode@1.5.4";
const JSBARCODE_URL = "https://esm.sh/jsbarcode@3.11.6";

let qrcodePromise: Promise<any> | null = null;
let jsbarcodePromise: Promise<any> | null = null;

const loadQrcode = (): Promise<any> => {
  if (!qrcodePromise) qrcodePromise = import(/* @vite-ignore */ QRCODE_URL);
  return qrcodePromise;
};

const loadJsbarcode = (): Promise<any> => {
  if (!jsbarcodePromise)
    jsbarcodePromise = import(/* @vite-ignore */ JSBARCODE_URL);
  return jsbarcodePromise;
};

// Prefetch both libraries once the page has finished loading so the first
// generate click doesn't pay the network cost.
const warmUp = () => {
  const go = () => {
    window.setTimeout(loadQrcode, 0);
    window.setTimeout(loadJsbarcode, 0);
  };
  if (document.readyState === "complete") go();
  else window.addEventListener("load", go, { once: true });
};

// The 1D symbologies JsBarcode supports, with a friendly label.
const BARCODE_FORMATS: [string, string][] = [
  ["CODE128", "Code 128 (any text)"],
  ["EAN13", "EAN-13 (12–13 digits)"],
  ["EAN8", "EAN-8 (7–8 digits)"],
  ["UPC", "UPC-A (11–12 digits)"],
  ["CODE39", "Code 39"],
  ["ITF14", "ITF-14 (14 digits)"],
  ["MSI", "MSI"],
  ["pharmacode", "Pharmacode (3–131070)"],
  ["codabar", "Codabar"],
];

export default (app: HTMLElement) => {
  warmUp();

  app.innerHTML = `
<div class="flex flex-col items-center min-h-screen py-10 px-4 text-green-500">
  <a href="/secret" title="Back to the secret menu">
    <h1 class="hover:underline italic text-5xl md:text-6xl font-bold bg-linear-to-r from-green-500 via-green-700 to-green-900 bg-clip-text text-transparent text-center">
      Barcodes
    </h1>
  </a>

  <p class="mt-3 text-green-800 font-mono text-sm text-center max-w-xl">
    Generate a QR code or a 1D barcode, all in the browser. Type, hit
    <span class="text-green-500">Generate</span>, then download the SVG or PNG.
  </p>

  <div class="w-full max-w-2xl mt-8 flex flex-col gap-4">
    <div class="flex flex-wrap gap-2 items-center">
      <select id="bc-kind"
        class="bg-stone-900 border border-green-900 focus:border-green-600 outline-none rounded px-3 py-2 text-green-300 font-mono">
        <option value="qr">QR code</option>
        <option value="barcode">Barcode</option>
      </select>

      <select id="bc-format"
        class="hidden bg-stone-900 border border-green-900 focus:border-green-600 outline-none rounded px-3 py-2 text-green-300 font-mono">
        ${BARCODE_FORMATS.map(
          ([value, label]) => `<option value="${value}">${label}</option>`,
        ).join("")}
      </select>

      <select id="bc-template"
        class="bg-stone-900 border border-green-900 focus:border-green-600 outline-none rounded px-3 py-2 text-green-300 font-mono"
        title="What kind of QR code to build">
        <option value="text">Plain text</option>
        <option value="website">Website</option>
        <option value="wifi">Wi-Fi</option>
      </select>

      <select id="bc-ec"
        class="bg-stone-900 border border-green-900 focus:border-green-600 outline-none rounded px-3 py-2 text-green-300 font-mono"
        title="QR error-correction level">
        <option value="L">EC: Low</option>
        <option value="M" selected>EC: Medium</option>
        <option value="Q">EC: Quartile</option>
        <option value="H">EC: High</option>
      </select>
    </div>

    <textarea id="bc-input" spellcheck="false" rows="3"
      placeholder="Text or URL to encode… (Ctrl/Cmd+Enter to generate)"
      class="w-full bg-stone-900 border border-green-900 focus:border-green-600 outline-none rounded px-3 py-2 text-green-300 placeholder-green-900 font-mono text-sm resize-none"></textarea>

    <div id="bc-website" class="hidden flex-col gap-2">
      <input id="bc-url" type="text" spellcheck="false"
        placeholder="example.com (https:// is added if you omit it)"
        class="w-full bg-stone-900 border border-green-900 focus:border-green-600 outline-none rounded px-3 py-2 text-green-300 placeholder-green-900 font-mono text-sm" />
    </div>

    <div id="bc-wifi" class="hidden flex-col gap-2">
      <input id="bc-ssid" type="text" spellcheck="false" placeholder="Network name (SSID)"
        class="w-full bg-stone-900 border border-green-900 focus:border-green-600 outline-none rounded px-3 py-2 text-green-300 placeholder-green-900 font-mono text-sm" />
      <input id="bc-pass" type="text" spellcheck="false" placeholder="Password"
        class="w-full bg-stone-900 border border-green-900 focus:border-green-600 outline-none rounded px-3 py-2 text-green-300 placeholder-green-900 font-mono text-sm" />
      <div class="flex flex-wrap gap-3 items-center">
        <select id="bc-enc"
          class="bg-stone-900 border border-green-900 focus:border-green-600 outline-none rounded px-3 py-2 text-green-300 font-mono text-sm">
          <option value="WPA">WPA/WPA2</option>
          <option value="WEP">WEP</option>
          <option value="nopass">No password</option>
        </select>
        <label class="flex items-center gap-2 text-green-300 font-mono text-sm cursor-pointer select-none">
          <input id="bc-hidden" type="checkbox" class="accent-green-600" />
          Hidden network
        </label>
      </div>
    </div>

    <div class="flex flex-wrap gap-4 items-center text-green-300 font-mono text-sm">
      <label class="flex items-center gap-2 cursor-pointer select-none" title="Code colour">
        Foreground
        <input id="bc-fg" type="color" value="#000000"
          class="w-8 h-8 bg-transparent border border-green-900 rounded cursor-pointer" />
      </label>
      <label class="flex items-center gap-2 cursor-pointer select-none" title="Background colour">
        Background
        <input id="bc-bg" type="color" value="#ffffff"
          class="w-8 h-8 bg-transparent border border-green-900 rounded cursor-pointer" />
      </label>
      <button id="bc-swap" type="button"
        class="border border-green-900 hover:border-green-600 px-3 py-1 rounded cursor-pointer transition-colors"
        title="Swap foreground and background">
        Swap
      </button>
      <label id="bc-icon-label" class="flex items-center gap-2 cursor-pointer select-none" title="Logo shown in the centre (QR only)">
        Centre icon
        <input id="bc-icon" type="file" accept="image/*" class="hidden" />
        <span id="bc-icon-name" class="border border-green-900 hover:border-green-600 px-3 py-1 rounded transition-colors">Choose…</span>
      </label>
      <button id="bc-icon-clear" type="button"
        class="hidden border border-green-900 hover:border-green-600 px-3 py-1 rounded cursor-pointer transition-colors">
        Clear icon
      </button>
    </div>

    <div class="flex flex-wrap gap-2 items-center">
      <button id="bc-generate"
        class="border border-green-900 hover:border-green-600 disabled:opacity-50 disabled:cursor-not-allowed text-green-300 font-bold px-6 py-2 rounded cursor-pointer transition-colors">
        Generate
      </button>
      <button id="bc-svg"
        class="border border-green-900 hover:border-green-600 disabled:opacity-50 disabled:cursor-not-allowed text-green-300 font-bold px-6 py-2 rounded cursor-pointer transition-colors" disabled>
        Download SVG
      </button>
      <button id="bc-png"
        class="border border-green-900 hover:border-green-600 disabled:opacity-50 disabled:cursor-not-allowed text-green-300 font-bold px-6 py-2 rounded cursor-pointer transition-colors" disabled>
        Download PNG
      </button>
      <span id="bc-status" class="text-sm font-mono text-green-800"></span>
    </div>

    <div id="bc-output"
      class="hidden self-center mt-2 rounded border border-green-900 overflow-hidden max-w-full"></div>
    <p id="bc-empty" class="self-center mt-2 text-green-900 font-mono text-sm">
      No code yet — hit Generate.
    </p>
  </div>
</div>
`;

  const kindSelect = app.querySelector("#bc-kind") as HTMLSelectElement;
  const formatSelect = app.querySelector("#bc-format") as HTMLSelectElement;
  const templateSelect = app.querySelector("#bc-template") as HTMLSelectElement;
  const ecSelect = app.querySelector("#bc-ec") as HTMLSelectElement;
  const input = app.querySelector("#bc-input") as HTMLTextAreaElement;

  const websitePanel = app.querySelector("#bc-website") as HTMLElement;
  const urlInput = app.querySelector("#bc-url") as HTMLInputElement;
  const wifiPanel = app.querySelector("#bc-wifi") as HTMLElement;
  const ssidInput = app.querySelector("#bc-ssid") as HTMLInputElement;
  const passInput = app.querySelector("#bc-pass") as HTMLInputElement;
  const encSelect = app.querySelector("#bc-enc") as HTMLSelectElement;
  const hiddenInput = app.querySelector("#bc-hidden") as HTMLInputElement;
  const fgInput = app.querySelector("#bc-fg") as HTMLInputElement;
  const bgInput = app.querySelector("#bc-bg") as HTMLInputElement;
  const swapBtn = app.querySelector("#bc-swap") as HTMLButtonElement;
  const iconLabel = app.querySelector("#bc-icon-label") as HTMLElement;
  const iconInput = app.querySelector("#bc-icon") as HTMLInputElement;
  const iconName = app.querySelector("#bc-icon-name") as HTMLElement;
  const iconClearBtn = app.querySelector("#bc-icon-clear") as HTMLButtonElement;
  const generateBtn = app.querySelector("#bc-generate") as HTMLButtonElement;
  const svgBtn = app.querySelector("#bc-svg") as HTMLButtonElement;
  const pngBtn = app.querySelector("#bc-png") as HTMLButtonElement;
  const statusEl = app.querySelector("#bc-status") as HTMLElement;
  const output = app.querySelector("#bc-output") as HTMLElement;
  const emptyEl = app.querySelector("#bc-empty") as HTMLElement;

  // The last successfully generated SVG markup, kept for the download buttons.
  let currentSvg: string | null = null;
  // The chosen centre-icon image as a data URL (QR codes only), or null.
  let iconDataUrl: string | null = null;

  const setStatus = (text: string, isError = false) => {
    statusEl.textContent = text;
    statusEl.classList.toggle("text-red-500", isError);
    statusEl.classList.toggle("text-green-800", !isError);
  };

  const setDownloadsEnabled = (enabled: boolean) => {
    svgBtn.disabled = !enabled;
    pngBtn.disabled = !enabled;
  };

  // Toggle the input controls to match the selected kind/template. Barcodes
  // always use the raw textarea; QR codes swap between the textarea (plain
  // text) and the Website / Wi-Fi helper panels.
  const syncControls = () => {
    const isBarcode = kindSelect.value === "barcode";
    const template = isBarcode ? "text" : templateSelect.value;

    formatSelect.classList.toggle("hidden", !isBarcode);
    templateSelect.classList.toggle("hidden", isBarcode);
    ecSelect.classList.toggle("hidden", isBarcode);
    // Centre icons only make sense for QR codes.
    iconLabel.classList.toggle("hidden", isBarcode);
    iconClearBtn.classList.toggle("hidden", isBarcode || !iconDataUrl);

    input.classList.toggle("hidden", template !== "text");
    websitePanel.classList.toggle("hidden", template !== "website");
    websitePanel.classList.toggle("flex", template === "website");
    wifiPanel.classList.toggle("hidden", template !== "wifi");
    wifiPanel.classList.toggle("flex", template === "wifi");
  };

  // Escape the reserved characters in a Wi-Fi payload field per the MECARD-ish
  // `WIFI:` spec: backslash, semicolon, comma, colon and double-quote.
  const wifiEscape = (s: string) => s.replace(/([\\;,:"])/g, "\\$1");

  // Build the string to actually encode from whichever input is active.
  // Returns null (after setting a status message) when required fields are
  // missing.
  const buildPayload = (): string | null => {
    if (kindSelect.value === "barcode") {
      const text = input.value.trim();
      if (!text) return (setStatus("Nothing to encode.", true), null);
      return text;
    }

    switch (templateSelect.value) {
      case "website": {
        let url = urlInput.value.trim();
        if (!url) return (setStatus("Enter a website address.", true), null);
        // Prepend https:// unless the user already gave a scheme.
        if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) url = "https://" + url;
        return url;
      }
      case "wifi": {
        const ssid = ssidInput.value;
        if (!ssid.trim())
          return (setStatus("Enter the network name (SSID).", true), null);
        const enc = encSelect.value; // WPA | WEP | nopass
        const parts = [`WIFI:T:${enc}`, `S:${wifiEscape(ssid)}`];
        if (enc !== "nopass") parts.push(`P:${wifiEscape(passInput.value)}`);
        if (hiddenInput.checked) parts.push("H:true");
        return parts.join(";") + ";;";
      }
      default: {
        const text = input.value.trim();
        if (!text) return (setStatus("Nothing to encode.", true), null);
        return text;
      }
    }
  };

  const SVG_NS = "http://www.w3.org/2000/svg";
  const XLINK_NS = "http://www.w3.org/1999/xlink";

  // Overlay the chosen icon in the centre of a QR SVG, on a small padded
  // background patch so the surrounding modules stay legible. The QR's own
  // error correction reconstructs the covered modules when scanned.
  const overlayIcon = (svg: string, href: string): string => {
    const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
    const root = doc.documentElement;
    const vb = (root.getAttribute("viewBox") || "").split(/\s+/).map(Number);
    if (vb.length !== 4 || !vb[2]) return svg;
    const size = vb[2];
    const icon = size * 0.24;
    const pad = icon * 0.14;
    const x = (size - icon) / 2;
    const y = (size - icon) / 2;

    const rect = doc.createElementNS(SVG_NS, "rect");
    rect.setAttribute("x", String(x - pad));
    rect.setAttribute("y", String(y - pad));
    rect.setAttribute("width", String(icon + pad * 2));
    rect.setAttribute("height", String(icon + pad * 2));
    rect.setAttribute("rx", String(pad));
    rect.setAttribute("fill", bgInput.value);

    const image = doc.createElementNS(SVG_NS, "image");
    image.setAttribute("x", String(x));
    image.setAttribute("y", String(y));
    image.setAttribute("width", String(icon));
    image.setAttribute("height", String(icon));
    image.setAttribute("preserveAspectRatio", "xMidYMid meet");
    image.setAttribute("href", href);
    image.setAttributeNS(XLINK_NS, "xlink:href", href);

    root.appendChild(rect);
    root.appendChild(image);
    return new XMLSerializer().serializeToString(root);
  };

  const makeQr = async (text: string): Promise<string> => {
    const mod = await loadQrcode();
    const QRCode = mod.default ?? mod;
    // `toString` with type "svg" is pure-JS and needs no DOM/canvas.
    const svg: string = await QRCode.toString(text, {
      type: "svg",
      errorCorrectionLevel: ecSelect.value,
      margin: 2,
      width: 320,
      color: { dark: fgInput.value, light: bgInput.value },
    });
    return iconDataUrl ? overlayIcon(svg, iconDataUrl) : svg;
  };

  const makeBarcode = async (text: string): Promise<string> => {
    const mod = await loadJsbarcode();
    const JsBarcode = mod.default ?? mod;
    // JsBarcode renders into an SVG node; we build a detached one so nothing
    // flashes on screen, then hand back its serialized markup.
    const svg = document.createElementNS(SVG_NS, "svg");
    JsBarcode(svg, text, {
      format: formatSelect.value,
      displayValue: true,
      margin: 10,
      lineColor: fgInput.value,
      background: bgInput.value,
    });
    return new XMLSerializer().serializeToString(svg);
  };

  const run = async () => {
    const text = buildPayload();
    if (text === null) return;

    generateBtn.disabled = true;
    setDownloadsEnabled(false);
    setStatus("Generating…");

    try {
      const svg =
        kindSelect.value === "qr"
          ? await makeQr(text)
          : await makeBarcode(text);
      currentSvg = svg;
      output.innerHTML = svg;
      // Keep the preview compact so it never dominates the page.
      const svgEl = output.querySelector("svg");
      if (svgEl) {
        svgEl.style.display = "block";
        svgEl.style.width = "240px";
        svgEl.style.maxWidth = "100%";
        svgEl.style.height = "auto";
      }
      output.classList.remove("hidden");
      emptyEl.classList.add("hidden");
      setDownloadsEnabled(true);
      setStatus("");
    } catch (err) {
      currentSvg = null;
      output.innerHTML = "";
      output.classList.add("hidden");
      emptyEl.classList.remove("hidden");
      // JsBarcode throws when the input is invalid for the chosen format.
      setStatus(err instanceof Error ? err.message : String(err), true);
    } finally {
      generateBtn.disabled = false;
    }
  };

  const download = (href: string, filename: string) => {
    const a = document.createElement("a");
    a.href = href;
    a.download = filename;
    a.click();
  };

  const downloadSvg = () => {
    if (!currentSvg) return;
    const blob = new Blob([currentSvg], { type: "image/svg+xml" });
    const url = URL.createObjectURL(blob);
    download(url, `${kindSelect.value}.svg`);
    URL.revokeObjectURL(url);
  };

  // Rasterize the SVG to a PNG via an offscreen canvas.
  const downloadPng = () => {
    if (!currentSvg) return;
    const img = new Image();
    const blob = new Blob([currentSvg], { type: "image/svg+xml" });
    const url = URL.createObjectURL(blob);
    img.onload = () => {
      // Render at 2x for a crisper bitmap.
      const scale = 2;
      const canvas = document.createElement("canvas");
      canvas.width = (img.naturalWidth || 320) * scale;
      canvas.height = (img.naturalHeight || 320) * scale;
      const ctx = canvas.getContext("2d")!;
      ctx.fillStyle = bgInput.value;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      download(canvas.toDataURL("image/png"), `${kindSelect.value}.png`);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      setStatus("Could not rasterize to PNG.", true);
    };
    img.src = url;
  };

  const setIcon = (dataUrl: string | null, label: string) => {
    iconDataUrl = dataUrl;
    iconName.textContent = label;
    iconClearBtn.classList.toggle("hidden", !dataUrl);
  };

  kindSelect.addEventListener("change", syncControls);
  templateSelect.addEventListener("change", syncControls);

  swapBtn.addEventListener("click", () => {
    const fg = fgInput.value;
    fgInput.value = bgInput.value;
    bgInput.value = fg;
  });

  iconInput.addEventListener("change", () => {
    const file = iconInput.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setIcon(String(reader.result), file.name);
    reader.onerror = () => setStatus("Could not read that image.", true);
    reader.readAsDataURL(file);
  });

  iconClearBtn.addEventListener("click", () => {
    iconInput.value = "";
    setIcon(null, "Choose…");
  });

  generateBtn.addEventListener("click", run);
  svgBtn.addEventListener("click", downloadSvg);
  pngBtn.addEventListener("click", downloadPng);

  // Ctrl/Cmd+Enter generates from any of the text-ish inputs.
  const submitOnCtrlEnter = (e: Event) => {
    const ke = e as KeyboardEvent;
    if ((ke.ctrlKey || ke.metaKey) && ke.key === "Enter") {
      e.preventDefault();
      run();
    }
  };
  for (const el of [input, urlInput, ssidInput, passInput]) {
    el.addEventListener("keydown", submitOnCtrlEnter);
  }

  syncControls();
  input.focus();
};
