//! Dependency-free, `no_std` WASM game core: Conway's Game of Life front page.
//!
//! The framebuffer and simulation state are fixed statics living in wasm bss,
//! so the module needs no allocator and no wasm-bindgen glue — just four
//! exports:
//!
//!   * `frame_ptr()`            -> pointer to the RGBA framebuffer
//!   * `tick(w, h, dt)`         -> advance the simulation by `dt` seconds and render
//!   * `reset()`                -> restart the simulation (call when (re)shown)
//!   * `seed(s)`                -> seed the PRNG (call once with e.g. Date.now())
//!
//! JS calls `frame_ptr` once, then `tick` every animation frame, and blits the
//! buffer to a `<canvas>` with `putImageData`.
//!
//! The sim opens by spelling "Andrew David McCall" in live cells (an embedded
//! 8x8 bitmap font, integer-scaled with Scale2x corner smoothing to fit the
//! viewport), holds the name for a moment, then evolves it under B3/S23.
//! Meteor streaks periodically fly through from the top-right toward the
//! bottom-left, birthing a trail of live cells as they pass.

#![cfg_attr(target_arch = "wasm32", no_std)]

#[cfg(target_arch = "wasm32")]
#[panic_handler]
fn panic(_: &core::panic::PanicInfo) -> ! {
    core::arch::wasm32::unreachable()
}

use core::ptr::addr_of_mut;

/// Max backing resolution the framebuffer supports. It is a zero-initialised
/// static (wasm bss), so it costs nothing in the compiled binary and lets us
/// skip a heap allocator entirely. JS must never pass a larger `w`/`h`.
const MAX_W: usize = 1920;
const MAX_H: usize = 1080;
static mut FRAME: [u8; MAX_W * MAX_H * 4] = [0; MAX_W * MAX_H * 4];

/// Cell grids sized for the densest pitch the layout will ever pick.
const MIN_PITCH: usize = 4;
const MAX_GW: usize = MAX_W / MIN_PITCH;
const MAX_GH: usize = MAX_H / MIN_PITCH;
const MAX_CELLS: usize = MAX_GW * MAX_GH;
static mut CELLS: [u8; MAX_CELLS] = [0; MAX_CELLS];
static mut NEXT: [u8; MAX_CELLS] = [0; MAX_CELLS];

/// Seconds the stamped name stays frozen before evolution begins.
const HOLD: f32 = 2.5;
/// Meteors start spawning just before the hold ends, so the first streak
/// visually ignites the name.
const SPAWN_START: f32 = 2.0;
/// Automaton generations per second.
const STEP_DT: f32 = 1.0 / 12.0;
const MAX_METROIDS: usize = 4;
const TRAIL_DOTS: i32 = 14;

const BG: [u8; 3] = [0x0c, 0x0a, 0x09]; // stone-950
const GRID_LINE: [u8; 3] = [0x1c, 0x19, 0x17]; // stone-900
const METEOR_HEAD: [u8; 3] = [0xec, 0xfc, 0xcb]; // lime-100
const METEOR_TAIL: [u8; 3] = [0x4d, 0x7c, 0x0f]; // lime-700

/// Cell colour by age: newborns flash bright lime; long-lived stable patterns
/// settle into a deep green that sits quietly against the background.
fn cell_colour(age: u8) -> [u8; 3] {
    match age {
        1 => [0xbe, 0xf2, 0x64],      // lime-300
        2..=4 => [0x84, 0xcc, 0x16],  // lime-500
        5..=11 => [0x22, 0xc5, 0x5e], // green-500
        _ => [0x15, 0x80, 0x3d],      // green-700
    }
}

// --- Text: embedded 8x8 bitmap font + viewport-fitting layout ---------------

/// Glyphs from the public-domain font8x8 basic set (LSB = leftmost pixel),
/// trimmed to just the characters of the name.
fn glyph(c: u8) -> [u8; 8] {
    match c {
        b'A' => [0x0C, 0x1E, 0x33, 0x33, 0x3F, 0x33, 0x33, 0x00],
        b'C' => [0x3C, 0x66, 0x03, 0x03, 0x03, 0x66, 0x3C, 0x00],
        b'D' => [0x1F, 0x36, 0x66, 0x66, 0x66, 0x36, 0x1F, 0x00],
        b'M' => [0x63, 0x77, 0x7F, 0x7F, 0x6B, 0x63, 0x63, 0x00],
        b'a' => [0x00, 0x00, 0x1E, 0x30, 0x3E, 0x33, 0x6E, 0x00],
        b'c' => [0x00, 0x00, 0x1E, 0x33, 0x03, 0x33, 0x1E, 0x00],
        b'd' => [0x38, 0x30, 0x30, 0x3E, 0x33, 0x33, 0x6E, 0x00],
        b'e' => [0x00, 0x00, 0x1E, 0x33, 0x3F, 0x03, 0x1E, 0x00],
        b'i' => [0x0C, 0x00, 0x0E, 0x0C, 0x0C, 0x0C, 0x1E, 0x00],
        b'l' => [0x0E, 0x0C, 0x0C, 0x0C, 0x0C, 0x0C, 0x1E, 0x00],
        b'n' => [0x00, 0x00, 0x1B, 0x37, 0x33, 0x33, 0x33, 0x00],
        b'r' => [0x00, 0x00, 0x3B, 0x6E, 0x66, 0x06, 0x0F, 0x00],
        b'v' => [0x00, 0x00, 0x33, 0x33, 0x33, 0x1E, 0x0C, 0x00],
        b'w' => [0x00, 0x00, 0x63, 0x6B, 0x7F, 0x7F, 0x36, 0x00],
        _ => [0; 8],
    }
}

const LINES_1: [&str; 1] = ["Andrew David McCall"];
const LINES_2: [&str; 2] = ["Andrew David", "McCall"];
const LINES_3: [&str; 3] = ["Andrew", "David", "McCall"];
/// Fewest lines first: ties on glyph scale prefer the wider layout.
const CANDIDATES: [&[&str]; 3] = [&LINES_1, &LINES_2, &LINES_3];

struct Layout {
    pitch: usize,
    scale: usize,
    lines: &'static [&'static str],
}

fn grid_dim(px: usize, pitch: usize) -> usize {
    // Leave one pixel for the closing grid line so cells never sit half off
    // screen; a viewport smaller than one pitch still gets a single cell.
    ((px.saturating_sub(1)) / pitch).max(1)
}

/// Height of an n-line block in cells at glyph scale s: 8s per line plus a
/// 2s gap between lines.
fn block_height(n: usize, s: usize) -> usize {
    8 * s * n + 2 * s * (n - 1)
}

/// Pick the pitch, glyph scale and word-wrapping that render the name biggest
/// while fitting 90% of the grid's width and 80% of its height. Coarse cells
/// (pitch 8) are tried first; small viewports fall back to finer pitches so a
/// phone in portrait still fits the stacked name.
fn plan_layout(w: usize, h: usize) -> Layout {
    for &pitch in &[8usize, 6, 5, 4] {
        let gw = grid_dim(w, pitch);
        let gh = grid_dim(h, pitch);
        let mut best: Option<(usize, &'static [&'static str])> = None;
        for &lines in CANDIDATES.iter() {
            let max_chars = lines.iter().map(|l| l.len()).fold(1, usize::max);
            let s_w = (gw * 9 / 10) / (max_chars * 8);
            let s_h = (gh * 8 / 10) / block_height(lines.len(), 1);
            let s = s_w.min(s_h);
            if s >= 1 && best.map_or(true, |(bs, _)| s > bs) {
                best = Some((s, lines));
            }
        }
        if let Some((scale, lines)) = best {
            return Layout { pitch, scale, lines };
        }
    }
    // Viewport too small for even the finest pitch — stamp anyway, clipped.
    Layout { pitch: MIN_PITCH, scale: 1, lines: &LINES_3 }
}

fn font_px(g: &[u8; 8], x: i32, y: i32) -> bool {
    (0..8).contains(&x) && (0..8).contains(&y) && (g[y as usize] >> x) & 1 == 1
}

/// Stamp one glyph as live cells, each font pixel becoming an s×s block.
/// At s ≥ 2 the four corner quadrants of each block follow the Scale2x rule,
/// clipping outer staircase corners and filling inner ones so scaled letters
/// read chunky-smooth instead of raw nearest-neighbour.
fn stamp_glyph(cells: &mut [u8], gw: usize, gh: usize, cx0: usize, cy0: usize, ch: u8, s: usize) {
    let g = glyph(ch);
    for fy in 0..8i32 {
        for fx in 0..8i32 {
            let e = font_px(&g, fx, fy);
            let up = font_px(&g, fx, fy - 1);
            let left = font_px(&g, fx - 1, fy);
            let right = font_px(&g, fx + 1, fy);
            let down = font_px(&g, fx, fy + 1);
            let quads = if s >= 2 {
                [
                    if left == up && up != right && left != down { left } else { e },
                    if up == right && up != left && right != down { right } else { e },
                    if left == down && left != up && down != right { left } else { e },
                    if down == right && left != down && up != right { right } else { e },
                ]
            } else {
                [e; 4]
            };
            for sy in 0..s {
                for sx in 0..s {
                    let q = (sx * 2 >= s) as usize + 2 * (sy * 2 >= s) as usize;
                    if !quads[q] {
                        continue;
                    }
                    let cx = cx0 + fx as usize * s + sx;
                    let cy = cy0 + fy as usize * s + sy;
                    if cx < gw && cy < gh {
                        cells[cy * gw + cx] = 1;
                    }
                }
            }
        }
    }
}

/// Stamp the laid-out name centred in the cell grid.
fn stamp_text(cells: &mut [u8], gw: usize, gh: usize, lay: &Layout) {
    let s = lay.scale;
    let mut y = gh.saturating_sub(block_height(lay.lines.len(), s)) / 2;
    for line in lay.lines {
        let x = gw.saturating_sub(line.len() * 8 * s) / 2;
        for (i, &ch) in line.as_bytes().iter().enumerate() {
            stamp_glyph(cells, gw, gh, x + i * 8 * s, y, ch, s);
        }
        y += 10 * s;
    }
}

// --- Life ------------------------------------------------------------------

/// One B3/S23 generation with dead (non-wrapping) borders. Cell values are
/// ages: 0 dead, else generations alive (saturating) — survivors grow older,
/// births start at 1.
fn step_life(cur: &[u8], next: &mut [u8], gw: usize, gh: usize) {
    for y in 0..gh {
        for x in 0..gw {
            let mut n = 0u32;
            let y0 = y.saturating_sub(1);
            let x0 = x.saturating_sub(1);
            for ny in y0..=(y + 1).min(gh - 1) {
                for nx in x0..=(x + 1).min(gw - 1) {
                    if (nx != x || ny != y) && cur[ny * gw + nx] > 0 {
                        n += 1;
                    }
                }
            }
            let age = cur[y * gw + x];
            next[y * gw + x] = match (age > 0, n) {
                (true, 2) | (true, 3) => age.saturating_add(1),
                (false, 3) => 1,
                _ => 0,
            };
        }
    }
}

// --- Simulation state ------------------------------------------------------

#[derive(Clone, Copy)]
struct Metroid {
    x: f32,
    y: f32,
    vx: f32,
    vy: f32,
    active: bool,
}

const DEAD_METROID: Metroid = Metroid { x: 0.0, y: 0.0, vx: 0.0, vy: 0.0, active: false };

struct Sim {
    ready: bool,
    w: usize,
    h: usize,
    pitch: usize,
    gw: usize,
    gh: usize,
    ox: usize,
    oy: usize,
    t: f32,
    step_acc: f32,
    rng: u32,
    spawn_in: f32,
    metroids: [Metroid; MAX_METROIDS],
}

static mut SIM: Sim = Sim {
    ready: false,
    w: 0,
    h: 0,
    pitch: 8,
    gw: 1,
    gh: 1,
    ox: 0,
    oy: 0,
    t: 0.0,
    step_acc: 0.0,
    rng: 0x9d2c_5680, // works unseeded; JS overrides via `seed()`
    spawn_in: 0.0,
    metroids: [DEAD_METROID; MAX_METROIDS],
};

impl Sim {
    fn rand(&mut self) -> u32 {
        let mut x = self.rng;
        x ^= x << 13;
        x ^= x >> 17;
        x ^= x << 5;
        self.rng = x;
        x
    }

    fn rand_f(&mut self) -> f32 {
        (self.rand() >> 8) as f32 / 16_777_216.0 // [0, 1)
    }

    fn rand_range(&mut self, lo: f32, hi: f32) -> f32 {
        lo + (hi - lo) * self.rand_f()
    }

    /// (Re)start for a viewport: lay out and stamp the name, clear timers.
    /// Runs on first tick, on `reset()`, and whenever the viewport resizes.
    fn init(&mut self, w: usize, h: usize, cells: &mut [u8]) {
        let lay = plan_layout(w, h);
        self.w = w;
        self.h = h;
        self.pitch = lay.pitch;
        self.gw = grid_dim(w, lay.pitch).min(MAX_GW);
        self.gh = grid_dim(h, lay.pitch).min(MAX_GH);
        self.ox = (w.saturating_sub(self.gw * self.pitch + 1)) / 2;
        self.oy = (h.saturating_sub(self.gh * self.pitch + 1)) / 2;
        self.t = 0.0;
        self.step_acc = 0.0;
        self.spawn_in = 0.0;
        self.metroids = [DEAD_METROID; MAX_METROIDS];
        cells.fill(0);
        stamp_text(cells, self.gw, self.gh, &lay);
        self.ready = true;
    }

    /// Spawn timer + integration + cell trail for the meteor streaks. They
    /// enter from the top edge's right half or the right edge's upper third
    /// and head down-left; picking the velocity components directly gives a
    /// random angle without needing trig in `no_std`.
    fn update_metroids(&mut self, dt: f32, cells: &mut [u8]) {
        if self.t >= SPAWN_START {
            self.spawn_in -= dt;
            if self.spawn_in <= 0.0 {
                self.spawn_in = self.rand_range(2.0, 6.0);
                if let Some(i) = (0..MAX_METROIDS).find(|&i| !self.metroids[i].active) {
                    let w = self.w as f32;
                    let h = self.h as f32;
                    let speed = self.rand_range(350.0, 650.0);
                    let vx = -self.rand_range(0.55, 1.0) * speed;
                    let vy = self.rand_range(0.45, 0.9) * speed;
                    let (x, y) = if self.rand() & 1 == 0 {
                        (self.rand_range(w * 0.5, w), -8.0)
                    } else {
                        (w + 8.0, self.rand_range(0.0, h / 3.0))
                    };
                    self.metroids[i] = Metroid { x, y, vx, vy, active: true };
                }
            }
        }

        for i in 0..MAX_METROIDS {
            let mut m = self.metroids[i];
            if !m.active {
                continue;
            }
            m.x += m.vx * dt;
            m.y += m.vy * dt;
            if m.x < -60.0 || m.y > self.h as f32 + 60.0 {
                m.active = false;
            } else {
                // Birth a few cells just behind the head — the evolving trail.
                let births = 1 + self.rand() % 3;
                for _ in 0..births {
                    let px = m.x - m.vx * 0.02 + self.rand_range(-1.5, 1.5) * self.pitch as f32;
                    let py = m.y - m.vy * 0.02 + self.rand_range(-1.5, 1.5) * self.pitch as f32;
                    let cx = (px - self.ox as f32) / self.pitch as f32;
                    let cy = (py - self.oy as f32) / self.pitch as f32;
                    if cx >= 0.0 && cy >= 0.0 {
                        let (cx, cy) = (cx as usize, cy as usize);
                        if cx < self.gw && cy < self.gh && cells[cy * self.gw + cx] == 0 {
                            cells[cy * self.gw + cx] = 1;
                        }
                    }
                }
            }
            self.metroids[i] = m;
        }
    }
}

// --- Framebuffer helpers ----------------------------------------------------

fn fill_rect(fb: &mut [u8], w: usize, h: usize, x: i32, y: i32, rw: i32, rh: i32, c: [u8; 3]) {
    let x0 = x.max(0) as usize;
    let y0 = y.max(0) as usize;
    let x1 = (x + rw).clamp(0, w as i32) as usize;
    let y1 = (y + rh).clamp(0, h as i32) as usize;
    for yy in y0..y1 {
        let row = yy * w;
        for xx in x0..x1 {
            let i = (row + xx) * 4;
            fb[i] = c[0];
            fb[i + 1] = c[1];
            fb[i + 2] = c[2];
            fb[i + 3] = 0xff;
        }
    }
}

fn lerp_colour(a: [u8; 3], b: [u8; 3], t: f32) -> [u8; 3] {
    let mix = |x: u8, y: u8| (x as f32 + (y as f32 - x as f32) * t) as u8;
    [mix(a[0], b[0]), mix(a[1], b[1]), mix(a[2], b[2])]
}

// --- Exports -----------------------------------------------------------------

#[no_mangle]
pub extern "C" fn frame_ptr() -> *mut u8 {
    addr_of_mut!(FRAME).cast()
}

/// Restart the simulation. The next `tick` re-lays-out for its viewport.
#[no_mangle]
pub extern "C" fn reset() {
    unsafe { (*addr_of_mut!(SIM)).ready = false }
}

/// Seed the PRNG (meteor timing/angles, trail scatter). Zero is remapped so
/// xorshift never locks up.
#[no_mangle]
pub extern "C" fn seed(s: u32) {
    unsafe { (*addr_of_mut!(SIM)).rng = if s == 0 { 0x9e37_79b9 } else { s } }
}

/// Advance the simulation by `dt` seconds, then render into the framebuffer.
#[no_mangle]
pub extern "C" fn tick(width: usize, height: usize, dt: f32) {
    if width == 0 || height == 0 || width > MAX_W || height > MAX_H {
        return;
    }
    let sim = unsafe { &mut *addr_of_mut!(SIM) };
    let cells: &mut [u8] = unsafe { &mut *addr_of_mut!(CELLS) };
    let next: &mut [u8] = unsafe { &mut *addr_of_mut!(NEXT) };

    if !sim.ready || sim.w != width || sim.h != height {
        sim.init(width, height, cells);
    }
    sim.t += dt;

    let (gw, gh, pitch, ox, oy) = (sim.gw, sim.gh, sim.pitch, sim.ox as i32, sim.oy as i32);
    let n_cells = gw * gh;

    // Fixed-timestep generations (capped so a background-tab stall can't
    // spiral). During the hold the name stays frozen but still ages, ramping
    // its colour from bright lime down to deep green before evolution begins.
    sim.step_acc += dt;
    let mut steps = 0;
    while sim.step_acc >= STEP_DT && steps < 4 {
        sim.step_acc -= STEP_DT;
        steps += 1;
        if sim.t < HOLD {
            for c in cells[..n_cells].iter_mut() {
                if *c > 0 {
                    *c = c.saturating_add(1);
                }
            }
        } else {
            step_life(cells, next, gw, gh);
            cells[..n_cells].copy_from_slice(&next[..n_cells]);
        }
    }

    sim.update_metroids(dt, cells);

    // Render: background, 1px grid lines, cells, meteor streaks.
    let fb = unsafe { core::slice::from_raw_parts_mut(frame_ptr(), width * height * 4) };
    for px in fb.chunks_exact_mut(4) {
        px[0] = BG[0];
        px[1] = BG[1];
        px[2] = BG[2];
        px[3] = 0xff;
    }

    let span_w = (gw * pitch + 1) as i32;
    let span_h = (gh * pitch + 1) as i32;
    for i in 0..=gw {
        fill_rect(fb, width, height, ox + (i * pitch) as i32, oy, 1, span_h, GRID_LINE);
    }
    for j in 0..=gh {
        fill_rect(fb, width, height, ox, oy + (j * pitch) as i32, span_w, 1, GRID_LINE);
    }

    let cell_px = (pitch - 1) as i32;
    for cy in 0..gh {
        for cx in 0..gw {
            let age = cells[cy * gw + cx];
            if age > 0 {
                let x = ox + (cx * pitch) as i32 + 1;
                let y = oy + (cy * pitch) as i32 + 1;
                fill_rect(fb, width, height, x, y, cell_px, cell_px, cell_colour(age));
            }
        }
    }

    for m in sim.metroids.iter().filter(|m| m.active) {
        for k in 0..TRAIL_DOTS {
            let t = k as f32 / TRAIL_DOTS as f32;
            let x = m.x - m.vx * 0.0085 * k as f32;
            let y = m.y - m.vy * 0.0085 * k as f32;
            let size = (5 - k * 4 / TRAIL_DOTS).max(1);
            let c = lerp_colour(METEOR_HEAD, METEOR_TAIL, t);
            fill_rect(fb, width, height, x as i32 - size / 2, y as i32 - size / 2, size, size, c);
        }
    }
}

// --- Tests (host target only) ------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn alive_set(cells: &[u8], gw: usize, gh: usize) -> Vec<(usize, usize)> {
        let mut v: Vec<_> = (0..gh)
            .flat_map(|y| (0..gw).map(move |x| (x, y)))
            .filter(|&(x, y)| cells[y * gw + x] > 0)
            .collect();
        v.sort();
        v
    }

    #[test]
    fn blinker_oscillates() {
        let (gw, gh) = (5, 5);
        let mut cur = vec![0u8; gw * gh];
        let mut next = vec![0u8; gw * gh];
        for x in 1..=3 {
            cur[2 * gw + x] = 1; // horizontal blinker
        }
        step_life(&cur, &mut next, gw, gh);
        assert_eq!(alive_set(&next, gw, gh), vec![(2, 1), (2, 2), (2, 3)]);
        let vertical = next.clone();
        step_life(&vertical, &mut next, gw, gh);
        assert_eq!(alive_set(&next, gw, gh), vec![(1, 2), (2, 2), (3, 2)]);
        // The survivor at the centre must be older than the fresh births.
        assert!(next[2 * gw + 2] > next[2 * gw + 1]);
    }

    #[test]
    fn block_is_stable() {
        let (gw, gh) = (4, 4);
        let mut cur = vec![0u8; gw * gh];
        let mut next = vec![0u8; gw * gh];
        for (x, y) in [(1, 1), (2, 1), (1, 2), (2, 2)] {
            cur[y * gw + x] = 1;
        }
        step_life(&cur, &mut next, gw, gh);
        assert_eq!(alive_set(&next, gw, gh), vec![(1, 1), (1, 2), (2, 1), (2, 2)]);
    }

    #[test]
    fn layout_fits_desktop_and_phone() {
        for (w, h) in [(1920usize, 1080usize), (390, 844), (768, 1024), (2560usize.min(MAX_W), 1080)] {
            let lay = plan_layout(w, h);
            let gw = grid_dim(w, lay.pitch);
            let gh = grid_dim(h, lay.pitch);
            assert!(lay.scale >= 1, "{w}x{h} got scale 0");
            let max_chars = lay.lines.iter().map(|l| l.len()).max().unwrap();
            assert!(max_chars * 8 * lay.scale <= gw, "{w}x{h} overflows width");
            assert!(block_height(lay.lines.len(), lay.scale) <= gh, "{w}x{h} overflows height");
        }
        // Desktop should render the name big: stacked words at a multi-cell scale.
        let lay = plan_layout(1920, 1080);
        assert!(lay.scale >= 2, "desktop scale too small: {}", lay.scale);
    }

    #[test]
    fn stamp_is_centred_and_in_bounds() {
        let (w, h) = (1920, 1080);
        let lay = plan_layout(w, h);
        let gw = grid_dim(w, lay.pitch);
        let gh = grid_dim(h, lay.pitch);
        let mut cells = vec![0u8; gw * gh];
        stamp_text(&mut cells, gw, gh, &lay);
        let alive = alive_set(&cells, gw, gh);
        assert!(!alive.is_empty());
        let min_x = alive.iter().map(|&(x, _)| x).min().unwrap();
        let max_x = alive.iter().map(|&(x, _)| x).max().unwrap();
        let min_y = alive.iter().map(|&(_, y)| y).min().unwrap();
        let max_y = alive.iter().map(|&(_, y)| y).max().unwrap();
        assert!(max_x < gw && max_y < gh);
        // Margins on opposite sides should be within one glyph advance.
        let advance = 8 * lay.scale;
        assert!(min_x.abs_diff(gw - 1 - max_x) <= advance);
        assert!(min_y.abs_diff(gh - 1 - max_y) <= advance);
    }
}
