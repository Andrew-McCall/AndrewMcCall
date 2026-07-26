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
//!   * `paint(x0,y0,x1,y1,a)`   -> stroke a line of births (a != 0) or kills (a == 0)
//!   * `hold(x,y,mode)`         -> mouse-hold point; 1 heals alpha, 2 erodes, 0 clears
//!   * `fade(d)`                -> shift every tile's alpha by d (scroll wheel)
//!   * `set_decay(pct)`         -> scale the natural per-generation erosion (100 = normal)
//!   * `static_fill()`          -> reseed the board with random static at half erosion
//!   * `clear()`                -> clear the board to fully transparent
//!
//! JS calls `frame_ptr` once, then `tick` every animation frame, and blits the
//! buffer to a `<canvas>` with `putImageData`.
//!
//! Every tile carries an alpha that live cells erode one step per generation
//! (opaque to fully transparent in 255 generations); once a neighbourhood has
//! faded, its grid lines fade with it and the page rendered beneath the canvas
//! shows through. Holding the left button erodes the alpha around the cursor,
//! the right button repairs it. Once a tile and 3 of its neighbours are wholly
//! transparent, the cell there is treated as alive every generation —
//! invisible, but feeding the life rule at the erosion frontier — until the
//! ground under it is healed back.
//!
//! A sparse field of green background stars — varied faint specks kept 8px
//! clear of the name and at least 16px apart — is scattered behind everything
//! on load, and tops itself up naturally over any ground a resize exposes.
//!
//! The sim opens by spelling "Andrew David McCall" in live cells (Menlo Bold
//! pre-rasterised to 16x32 bitmaps, integer-scaled to fit the viewport), holds
//! the name for a moment, then evolves it under B3/S23. Comets fly through
//! from the top-right toward the bottom-left, visible only as the trail of
//! live cells they birth, and ambient births — strongly biased to the cells
//! under the letters — keep the name ghosting back through the chaos.

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
const MAX_W: usize = 2560;
const MAX_H: usize = 1440;
/// 4-byte aligned so the per-frame background clear can store a whole RGBA
/// pixel per word (`align_to_mut::<u32>`) instead of four separate byte writes.
#[repr(align(4))]
#[allow(dead_code)] // read only through frame_ptr()'s raw cast
struct Frame([u8; MAX_W * MAX_H * 4]);
static mut FRAME: Frame = Frame([0; MAX_W * MAX_H * 4]);

/// Cell grids sized for the densest pitch the layout will ever pick.
const MIN_PITCH: usize = 3;
const MAX_GW: usize = MAX_W / MIN_PITCH;
const MAX_GH: usize = MAX_H / MIN_PITCH;
const MAX_CELLS: usize = MAX_GW * MAX_GH;
static mut CELLS: [u8; MAX_CELLS] = [0; MAX_CELLS];
static mut NEXT: [u8; MAX_CELLS] = [0; MAX_CELLS];
/// Which cells the name was stamped on — ambient births favour this region.
static mut TEXT_MASK: [u8; MAX_CELLS] = [0; MAX_CELLS];
/// Per-tile alpha. Live cells erode it; it sticks after they die, so ground
/// that life has burned through stays see-through until the mouse heals it.
static mut TILE_A: [u8; MAX_CELLS] = [0; MAX_CELLS];
/// Cells gone permanently alive: once a tile and 3 of its neighbours fully
/// erode, the cell there counts as alive every generation — until the ground
/// under it is healed, which makes it mortal again.
static mut PERMA: [u8; MAX_CELLS] = [0; MAX_CELLS];
/// Static background stars: 1 where a star sits, 0 elsewhere. Scattered once
/// on init and topped up on resize; never touched by the Life step.
static mut STARS: [u8; MAX_CELLS] = [0; MAX_CELLS];

/// Seconds the stamped name stays frozen before evolution begins.
const HOLD: f32 = 2.0;
/// Meteors start spawning just before the hold ends, so the first streak
/// visually ignites the name.
const SPAWN_START: f32 = 2.0;
/// Automaton generations per second the sim aims for. `target_tps` starts here
/// and only ratchets down when the frame can't keep up (see `MIN_TPS`); the
/// step interval is `1.0 / target_tps`.
const INIT_TPS: f32 = 12.0;
/// Floor the adaptive rate never drops below — one generation per second.
const MIN_TPS: f32 = 1.0;
/// Seconds of sustained overload that buy one tick/sec off the target rate.
const SLOW_WINDOW: f32 = 5.0;
/// Seconds of sustained headroom that win one tick/sec back — deliberately far
/// longer than SLOW_WINDOW so the rate crawls back up but drops fast.
const FAST_WINDOW: f32 = 20.0;
const MAX_METROIDS: usize = 5;

/// Base alpha a live cell's tile loses per generation. Interior cells —
/// ringed by live neighbours — lose up to 3x this, on a quadratic ramp, so
/// colony edges dissolve at the base rate while their cores burn through.
const DECAY: u8 = 3;
/// Alpha a mouse hold adds (heal) or removes (erode) per generation at the
/// brush centre; erasing bites harder than repairing restores.
const HOLD_HEAL: u8 = 48;
const HOLD_ERODE: u8 = 96;
/// Brush radius in tiles; strength falls off non-linearly to ~0 at the rim.
const HOLD_R: i32 = 3;

/// The outer 1/20th (5%) of the grid on every side self-heals each
/// generation.
const MARGIN_FRAC: usize = 20;
/// Alpha the margin regains per generation at the very border, fading
/// quadratically to ~0 at the band's inner line. Beats even 3x interior
/// decay right at the edge but loses to it midway in, so the erosion
/// frontier never settles there — it keeps wiggling inside the band.
const MARGIN_HEAL: u8 = 16;

const BG: [u8; 3] = [0x0c, 0x0a, 0x09]; // stone-950
const GRID_LINE: [u8; 3] = [0x1c, 0x19, 0x17]; // stone-900

/// Background stars scattered across empty ground at load. Drawn in the
/// darkest green a cell ever reaches (`cell_colour`'s oldest branch) at a
/// faint fixed alpha, so they read as a distant field behind the name rather
/// than as live cells.
const STAR_COLOUR: [u8; 3] = [0x15, 0x80, 0x3d]; // green-700
const STAR_ALPHA: u8 = 200;
/// Star field spacing, in framebuffer pixels: no star lands within
/// `STAR_WORD_PX` of the stamped name, and stars keep at least `STAR_MIN_PX`
/// between one another. Placement aims for roughly `STAR_TYP_PX` average
/// spacing, so the field stays sparse well above the hard minimum.
const STAR_WORD_PX: usize = 8;
const STAR_MIN_PX: usize = 16;
const STAR_TYP_PX: usize = 34;

/// A star type's brightness and shape: `alpha` (never above STAR_ALPHA) and a
/// 4x4 bitmap packed as four 4-bit rows, MSB = leftmost pixel, top row first.
/// Types range from a lone faint pixel through a bright filled square, so the
/// scattered field reads as varied points of depth.
fn star_kind(ty: u8) -> (u8, u16) {
    match ty {
        1 => (STAR_ALPHA, 0xFFFF), // bright filled 4x4 square
        2 => (160, 0x0660),        // small 2x2 dot
        3 => (STAR_ALPHA, 0x4E40), // 3px twinkle: a centred plus
        4 => (STAR_ALPHA, 0xA4A0), // 3px twinkle: the plus rotated to an X
        _ => (120, 0x0400),        // faint single pixel
    }
}

/// "Static" fill density: when the static button reseeds the board with noise,
/// a cell is born where `rand() % 16` lands under this — roughly 40% of the
/// grid, a dense field that reads as static before Life thins it out.
const STATIC_FILL: u32 = 6;

/// Cell colour by age: newborns flash bright lime; long-lived stable patterns
/// settle into a deep green that sits quietly against the background.
#[inline]
fn cell_colour(age: u8) -> [u8; 3] {
    match age {
        1 => [0xbe, 0xf2, 0x64],      // lime-300
        2..=4 => [0x84, 0xcc, 0x16],  // lime-500
        5..=11 => [0x22, 0xc5, 0x5e], // green-500
        _ => [0x15, 0x80, 0x3d],      // green-700
    }
}

// --- Text: embedded 16x32 bitmap font + viewport-fitting layout -------------

const GLYPH_W: usize = 16;
const GLYPH_H: usize = 32;
/// Vertical gap between lines, in cells, at glyph scale 1.
const LINE_GAP: usize = GLYPH_H / 8;

/// Menlo Bold pre-rasterised to 16x32 (MSB = leftmost pixel), trimmed to just
/// the characters of the name. Generated offline from the system font.
fn glyph(c: u8) -> [u16; GLYPH_H] {
    match c {
        b'A' => [
            0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x07C0, 0x07E0, 0x07E0, 0x0FE0, 0x0FE0,
            0x0EF0, 0x0EF0, 0x1E70, 0x1E78, 0x1E78, 0x1C78, 0x3FF8, 0x3FFC, 0x3FFC, 0x383C, 0x781C,
            0x781E, 0x781E, 0xF01E, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000,
        ],
        b'C' => [
            0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x03F8, 0x07FC, 0x0FFC, 0x1F0C, 0x1E04,
            0x3E00, 0x3C00, 0x3C00, 0x3C00, 0x3C00, 0x3C00, 0x3C00, 0x3C00, 0x3E00, 0x1E04, 0x1F0C,
            0x0FFC, 0x07FC, 0x03F8, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000,
        ],
        b'D' => [
            0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x3FC0, 0x3FF0, 0x3FF8, 0x3CF8, 0x3C7C,
            0x3C3C, 0x3C3C, 0x3C3C, 0x3C3E, 0x3C3E, 0x3C3E, 0x3C3C, 0x3C3C, 0x3C3C, 0x3C7C, 0x3CF8,
            0x3FF8, 0x3FF0, 0x3FC0, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000,
        ],
        b'M' => [
            0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x7C3E, 0x7C3E, 0x7C7E, 0x7E7E, 0x7E7E,
            0x7EFE, 0x76FE, 0x77FE, 0x77DE, 0x73DE, 0x73DE, 0x73DE, 0x701E, 0x701E, 0x701E, 0x701E,
            0x701E, 0x701E, 0x701E, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000,
        ],
        b'a' => [
            0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000,
            0x0FE0, 0x3FF8, 0x3FF8, 0x183C, 0x003C, 0x0FFC, 0x3FFC, 0x3FFC, 0x7C3C, 0x783C, 0x7C7C,
            0x7FFC, 0x3FFC, 0x1FBC, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000,
        ],
        b'c' => [
            0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000,
            0x03F8, 0x0FFC, 0x1FFC, 0x1F0C, 0x3E00, 0x3C00, 0x3C00, 0x3C00, 0x3C00, 0x3E00, 0x1F0C,
            0x1FFC, 0x0FFC, 0x03F0, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000,
        ],
        b'd' => [
            0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x003C, 0x003C, 0x003C, 0x003C, 0x003C, 0x003C,
            0x0F3C, 0x1FFC, 0x3FFC, 0x3C7C, 0x787C, 0x783C, 0x783C, 0x783C, 0x783C, 0x787C, 0x3C7C,
            0x3FFC, 0x1FFC, 0x0F3C, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000,
        ],
        b'e' => [
            0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000,
            0x07E0, 0x1FF0, 0x3FF8, 0x3E7C, 0x7C3C, 0x781E, 0x7FFE, 0x7FFE, 0x7FFE, 0x7800, 0x3C0C,
            0x3FFC, 0x1FFC, 0x07F8, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000,
        ],
        b'i' => [
            0x0000, 0x0000, 0x0000, 0x0000, 0x03C0, 0x03C0, 0x03C0, 0x03C0, 0x0000, 0x0000, 0x0000,
            0x1FC0, 0x1FC0, 0x1FC0, 0x03C0, 0x03C0, 0x03C0, 0x03C0, 0x03C0, 0x03C0, 0x03C0, 0x03C0,
            0x3FFE, 0x3FFE, 0x3FFE, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000,
        ],
        b'l' => [
            0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x7F80, 0x7F80, 0x7F80, 0x0780, 0x0780, 0x0780,
            0x0780, 0x0780, 0x0780, 0x0780, 0x0780, 0x0780, 0x0780, 0x0780, 0x0780, 0x0780, 0x07C0,
            0x07FC, 0x03FC, 0x01FC, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000,
        ],
        b'n' => [
            0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000,
            0x3DF0, 0x3FF8, 0x3FF8, 0x3E7C, 0x3C3C, 0x3C3C, 0x3C3C, 0x3C3C, 0x3C3C, 0x3C3C, 0x3C3C,
            0x3C3C, 0x3C3C, 0x3C3C, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000,
        ],
        b'r' => [
            0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000,
            0x0F7C, 0x0FFE, 0x0FFE, 0x0FC6, 0x0F00, 0x0F00, 0x0F00, 0x0F00, 0x0F00, 0x0F00, 0x0F00,
            0x0F00, 0x0F00, 0x0F00, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000,
        ],
        b'v' => [
            0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000,
            0x781E, 0x783C, 0x3C3C, 0x3C3C, 0x3C78, 0x1C78, 0x1E78, 0x1E70, 0x0EF0, 0x0FF0, 0x0FE0,
            0x07E0, 0x07E0, 0x07C0, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000,
        ],
        b'w' => [
            0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000,
            0xE00F, 0xE00E, 0xF00E, 0x700E, 0x73CE, 0x73CE, 0x73DE, 0x77DC, 0x7FDC, 0x3EFC, 0x3E7C,
            0x3E7C, 0x3E78, 0x3C78, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000,
        ],
        _ => [0; GLYPH_H],
    }
}

const TITLE: [&str; 3] = ["Andrew", "David", "McCall"];

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

/// Height of an n-line block in cells at glyph scale s.
fn block_height(n: usize, s: usize) -> usize {
    GLYPH_H * s * n + LINE_GAP * s * (n - 1)
}

/// Pick the pitch, glyph scale and word-wrapping that render the name biggest
/// while fitting 90% of the grid's width and 80% of its height. Coarse cells
/// (pitch 8) are tried first; small viewports fall back to finer pitches so a
/// phone in portrait still fits the stacked name.
fn plan_layout(w: usize, h: usize) -> Layout {
    for &pitch in &[8usize, 6, 5, 4, 3] {
        let gw = grid_dim(w, pitch);
        let gh = grid_dim(h, pitch);
        let max_chars = TITLE.iter().map(|l| l.len()).fold(1, usize::max);
        let s_w = (gw * 9 / 10) / (max_chars * GLYPH_W);
        let s_h = (gh * 8 / 10) / block_height(TITLE.len(), 1);
        let scale = s_w.min(s_h);
        if scale >= 1 {
            return Layout {
                pitch,
                scale,
                lines: &TITLE,
            };
        }
    }
    // Viewport too small for even the finest pitch — stamp anyway, clipped.
    Layout {
        pitch: MIN_PITCH,
        scale: 1,
        lines: &TITLE,
    }
}

fn font_px(g: &[u16; GLYPH_H], x: i32, y: i32) -> bool {
    (0..GLYPH_W as i32).contains(&x)
        && (0..GLYPH_H as i32).contains(&y)
        && (g[y as usize] >> (GLYPH_W as i32 - 1 - x)) & 1 == 1
}

/// Stamp one glyph as live cells, each font pixel becoming an s×s block.
/// At s ≥ 2 the four corner quadrants of each block follow the Scale2x rule,
/// clipping outer staircase corners and filling inner ones so scaled letters
/// read chunky-smooth instead of raw nearest-neighbour.
fn stamp_glyph(cells: &mut [u8], gw: usize, gh: usize, cx0: usize, cy0: usize, ch: u8, s: usize) {
    let g = glyph(ch);
    for fy in 0..GLYPH_H as i32 {
        for fx in 0..GLYPH_W as i32 {
            let e = font_px(&g, fx, fy);
            let up = font_px(&g, fx, fy - 1);
            let left = font_px(&g, fx - 1, fy);
            let right = font_px(&g, fx + 1, fy);
            let down = font_px(&g, fx, fy + 1);
            let quads = if s >= 2 {
                [
                    if left == up && up != right && left != down {
                        left
                    } else {
                        e
                    },
                    if up == right && up != left && right != down {
                        right
                    } else {
                        e
                    },
                    if left == down && left != up && down != right {
                        left
                    } else {
                        e
                    },
                    if down == right && left != down && up != right {
                        right
                    } else {
                        e
                    },
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
        let x = gw.saturating_sub(line.len() * GLYPH_W * s) / 2;
        for (i, &ch) in line.as_bytes().iter().enumerate() {
            stamp_glyph(cells, gw, gh, x + i * GLYPH_W * s, y, ch, s);
        }
        y += (GLYPH_H + LINE_GAP) * s;
    }
}

/// xorshift32 step, shared by the sim RNG and the star scatterer. Advances
/// `state` and returns the new value; `state` must never be zero.
#[inline]
fn xorshift(state: &mut u32) -> u32 {
    let mut x = *state;
    x ^= x << 13;
    x ^= x >> 17;
    x ^= x << 5;
    *state = x;
    x
}

/// True if any cell within Chebyshev distance `r` of (x, y) — a (2r+1)² square
/// clipped to the grid — is non-zero. Used to keep stars clear of the name and
/// of each other.
fn near(buf: &[u8], gw: usize, gh: usize, x: usize, y: usize, r: usize) -> bool {
    let y0 = y.saturating_sub(r);
    let y1 = (y + r).min(gh - 1);
    let x0 = x.saturating_sub(r);
    let x1 = (x + r).min(gw - 1);
    for ny in y0..=y1 {
        let row = ny * gw;
        for nx in x0..=x1 {
            if buf[row + nx] > 0 {
                return true;
            }
        }
    }
    false
}

/// Scatter background stars into empty ground, driving placement off `rng`.
/// Every candidate is rejected if it lands within `STAR_WORD_PX` of the
/// stamped name or `STAR_MIN_PX` of an existing star, so the field keeps its
/// spacing however dense the attempts get; each survivor takes a random type
/// (weighted toward the faint specks). Adds to whatever is already in `stars`:
/// empty on init, the remapped survivors on resize, so freshly exposed ground
/// fills in at the same density without disturbing the stars already placed.
fn scatter_stars(rng: &mut u32, stars: &mut [u8], mask: &[u8], gw: usize, gh: usize, pitch: usize) {
    if gw == 0 || gh == 0 {
        return;
    }
    // Pixel spacings rounded up to whole cells (at least one).
    let word_gap = STAR_WORD_PX.div_ceil(pitch).max(1);
    let min_gap = STAR_MIN_PX.div_ceil(pitch).max(1);
    let typ_gap = STAR_TYP_PX.div_ceil(pitch).max(min_gap);
    // One attempt per typical-spacing cell of area; min-gap rejection then
    // thins the field to its spacing-limited density in this single pass.
    let attempts = (gw * gh) / (typ_gap * typ_gap) + 1;
    for _ in 0..attempts {
        let x = xorshift(rng) as usize % gw;
        let y = xorshift(rng) as usize % gh;
        if near(mask, gw, gh, x, y, word_gap) || near(stars, gw, gh, x, y, min_gap) {
            continue;
        }
        // Weighted toward the faint specks, with the bright square rarest, so
        // the field looks like real depth rather than a uniform stipple.
        let ty = match xorshift(rng) % 16 {
            0..=6 => 1,   // faint single pixel
            7..=10 => 2,  // small 2x2 dot
            11..=12 => 3, // 3px twinkle (plus)
            13..=14 => 5, // 3px twinkle (X)
            _ => 4,       // bright 4x4 square
        };
        stars[y * gw + x] = ty;
    }
}

// --- Life ------------------------------------------------------------------

/// Live (age > 0) neighbours of a border cell, clamped to the grid so borders
/// stay dead (non-wrapping). Interior cells use `live_neighbours8` instead.
#[inline]
fn live_neighbours(buf: &[u8], gw: usize, gh: usize, x: usize, y: usize) -> u32 {
    let x1 = (x + 1).min(gw - 1);
    let y1 = (y + 1).min(gh - 1);
    let mut n = 0u32;
    for ny in y.saturating_sub(1)..=y1 {
        let base = ny * gw;
        for nx in x.saturating_sub(1)..=x1 {
            if (nx != x || ny != y) && buf[base + nx] > 0 {
                n += 1;
            }
        }
    }
    n
}

/// The eight neighbours of an interior cell `i` (row 1..gh-1, col 1..gw-1, all
/// in range), summed branch-free — no clamping, no centre-skip test.
#[inline]
fn live_neighbours8(buf: &[u8], gw: usize, i: usize) -> u32 {
    (buf[i - gw - 1] > 0) as u32
        + (buf[i - gw] > 0) as u32
        + (buf[i - gw + 1] > 0) as u32
        + (buf[i - 1] > 0) as u32
        + (buf[i + 1] > 0) as u32
        + (buf[i + gw - 1] > 0) as u32
        + (buf[i + gw] > 0) as u32
        + (buf[i + gw + 1] > 0) as u32
}

#[inline]
fn life_rule(age: u8, n: u32) -> u8 {
    match (age > 0, n) {
        (true, 2) | (true, 3) => age.saturating_add(1),
        (false, 3) => 1,
        _ => 0,
    }
}

/// One B3/S23 generation with dead (non-wrapping) borders. Cell values are
/// ages: 0 dead, else generations alive (saturating) — survivors grow older,
/// births start at 1. Interior rows split off their two edge columns so the
/// long middle run takes the branch-free eight-neighbour count.
fn step_life(cur: &[u8], next: &mut [u8], gw: usize, gh: usize) {
    for y in 0..gh {
        let row = y * gw;
        if y == 0 || y + 1 >= gh || gw < 3 {
            for x in 0..gw {
                next[row + x] = life_rule(cur[row + x], live_neighbours(cur, gw, gh, x, y));
            }
        } else {
            next[row] = life_rule(cur[row], live_neighbours(cur, gw, gh, 0, y));
            for x in 1..gw - 1 {
                let i = row + x;
                next[i] = life_rule(cur[i], live_neighbours8(cur, gw, i));
            }
            let x = gw - 1;
            next[row + x] = life_rule(cur[row + x], live_neighbours(cur, gw, gh, x, y));
        }
    }
}

/// Paint a straight stroke in cell space, stamping a square brush of radius
/// `r` cells at each step of a DDA walk — the interpolation that keeps fast
/// drags solid instead of dotted. Births start at age 1 (already-live cells
/// keep their age); kills clear outright.
#[allow(clippy::too_many_arguments)] // geometry primitive: each arg is distinct
fn paint_line(
    cells: &mut [u8],
    gw: usize,
    gh: usize,
    x0: f32,
    y0: f32,
    x1: f32,
    y1: f32,
    alive: bool,
    r: i32,
) {
    let dx = x1 - x0;
    let dy = y1 - y0;
    let len = dx.abs().max(dy.abs());
    let steps = if len < 1.0 {
        1
    } else {
        (len as i32 + 1).min(4096)
    };
    for i in 0..=steps {
        let t = i as f32 / steps as f32;
        // Floor via a large offset so the cast truncates toward -inf, keeping
        // brush edges stable when the stroke starts left of the grid.
        let cx = (x0 + dx * t + 4096.0) as i32 - 4096;
        let cy = (y0 + dy * t + 4096.0) as i32 - 4096;
        for by in (cy - r).max(0)..=(cy + r).min(gh as i32 - 1) {
            for bx in (cx - r).max(0)..=(cx + r).min(gw as i32 - 1) {
                let c = &mut cells[by as usize * gw + bx as usize];
                *c = if alive { (*c).max(1) } else { 0 };
            }
        }
    }
}

/// Re-shape a flat row-major grid buffer in place from (ogw, ogh) to
/// (gw, gh). Content keeps its grid coordinates: the overlap is preserved,
/// clipped cells drop, and newly exposed ground takes `fill`. Row 0 never
/// moves; when rows grow they are walked bottom-up so sources aren't
/// clobbered before they're read.
fn remap_grid(buf: &mut [u8], ogw: usize, ogh: usize, gw: usize, gh: usize, fill: u8) {
    let cw = ogw.min(gw);
    let ch = ogh.min(gh);
    if gw < ogw {
        for y in 1..ch {
            buf.copy_within(y * ogw..y * ogw + cw, y * gw);
        }
    } else if gw > ogw {
        for y in (1..ch).rev() {
            buf.copy_within(y * ogw..y * ogw + cw, y * gw);
        }
    }
    for y in 0..ch {
        buf[y * gw + cw..(y + 1) * gw].fill(fill);
    }
    buf[ch * gw..gh * gw].fill(fill);
}

/// Every tile under a live cell erodes each generation; dead tiles keep
/// whatever alpha they last had. Erosion scales with how buried the cell is:
/// 1x at the colony edge up to 3x when all 8 neighbours are alive, ramped
/// quadratically so the speed-up only kicks in well inside the frontier.
fn decay_tiles(cells: &[u8], tile_a: &mut [u8], gw: usize, gh: usize, pct: u32) {
    for y in 0..gh {
        let row = y * gw;
        let interior_row = y >= 1 && y + 1 < gh && gw >= 3;
        for x in 0..gw {
            let i = row + x;
            if cells[i] == 0 {
                continue;
            }
            let n = if interior_row && x >= 1 && x + 1 < gw {
                live_neighbours8(cells, gw, i)
            } else {
                live_neighbours(cells, gw, gh, x, y)
            };
            // Scale by `pct` (100 = normal); the static toggle passes 50 to
            // halve erosion. Round to nearest so a halved base of 3 stays 2,
            // not 1, and never rounds a live tile's loss down to nothing.
            let base = DECAY as u32 + (DECAY as u32 * 2 * n * n) / 64;
            let d = ((base * pct + 50) / 100).max(1);
            tile_a[i] = tile_a[i].saturating_sub(d as u8);
        }
    }
}

/// Regrow alpha in the outer margin of the grid. Heal strength ramps
/// quadratically from ~0 at the band's inner edge to MARGIN_HEAL at the
/// border, so the screen edge always wins back opacity while the band's
/// inner half stays contested by decay.
fn heal_margin(tile_a: &mut [u8], gw: usize, gh: usize) {
    let m = (gw.min(gh) / MARGIN_FRAC).max(1);
    for y in 0..gh {
        for x in 0..gw {
            let d = x.min(y).min(gw - 1 - x).min(gh - 1 - y);
            if d >= m {
                continue;
            }
            let f = (m - d) as u32;
            let heal = ((MARGIN_HEAL as u32 * f * f) / (m * m) as u32).max(1) as u8;
            tile_a[y * gw + x] = tile_a[y * gw + x].saturating_add(heal);
        }
    }
}

/// Mark cells whose tile and at least 3 of its 8 neighbours have fully
/// eroded. Marked cells are forced alive each generation, so wholly dissolved
/// ground keeps seeding the frontier even though nothing there renders. A
/// mark lasts only while its own tile stays fully eroded — healed ground goes
/// mortal again.
fn mark_perma(tile_a: &[u8], perma: &mut [u8], gw: usize, gh: usize) {
    for y in 0..gh {
        for x in 0..gw {
            let i = y * gw + x;
            if tile_a[i] > 0 {
                perma[i] = 0;
                continue;
            }
            if perma[i] > 0 {
                continue;
            }
            let mut n = 0u32;
            let x0 = x.saturating_sub(1);
            let x1 = (x + 1).min(gw - 1);
            for ny in y.saturating_sub(1)..=(y + 1).min(gh - 1) {
                let nrow = ny * gw;
                for nx in x0..=x1 {
                    if (nx != x || ny != y) && tile_a[nrow + nx] == 0 {
                        n += 1;
                    }
                }
            }
            if n >= 3 {
                perma[i] = 1;
            }
        }
    }
}

/// Adjust alpha in a disc of radius HOLD_R around (cx, cy). `heal` restores
/// toward opaque, otherwise erodes. Strength peaks under the cursor and drops
/// off quadratically in distance², so a hold sinks a smooth crater rather
/// than punching a flat-sided hole.
fn hold_brush(tile_a: &mut [u8], gw: usize, gh: usize, cx: i32, cy: i32, heal: bool) {
    let peak = if heal { HOLD_HEAL } else { HOLD_ERODE };
    let r2 = HOLD_R * HOLD_R;
    for dy in -HOLD_R..=HOLD_R {
        for dx in -HOLD_R..=HOLD_R {
            let d2 = dx * dx + dy * dy;
            let (x, y) = (cx + dx, cy + dy);
            if d2 > r2 || x < 0 || y < 0 || x as usize >= gw || y as usize >= gh {
                continue;
            }
            let f = (r2 + 1 - d2) as u32;
            let step = ((peak as u32 * f * f) / ((r2 + 1) * (r2 + 1)) as u32).max(1) as u8;
            let a = &mut tile_a[y as usize * gw + x as usize];
            *a = if heal {
                a.saturating_add(step)
            } else {
                a.saturating_sub(step)
            };
        }
    }
}

/// Nudge the target generation rate to what the frame budget can sustain.
///
/// A frame is *overloaded* when its banked backlog (`step_acc + dt`) would
/// overrun the 4-step-per-frame cap, meaning generations are being dropped:
/// every `SLOW_WINDOW` seconds of that spends one tick/sec off the target,
/// floored at `MIN_TPS`. A frame has *headroom* when its real delta is under
/// half the step interval — plenty of idle budget: every `FAST_WINDOW` seconds
/// of that (far longer, so the climb is very slow) wins one tick/sec back, up
/// to `INIT_TPS`. Frames that are neither hold the rate and keep both timers.
/// The two accumulators reset each other so intermittent lag never banks a
/// drop while the sim is mostly comfortable, nor vice versa. Returns the
/// updated `(target_tps, slow_acc, fast_acc)`.
fn ease_target_rate(
    target_tps: f32,
    mut slow_acc: f32,
    mut fast_acc: f32,
    step_acc: f32,
    dt: f32,
) -> (f32, f32, f32) {
    let step_dt = 1.0 / target_tps;
    let mut tps = target_tps;
    if step_acc + dt > step_dt * 4.0 {
        fast_acc = 0.0;
        if tps > MIN_TPS {
            slow_acc += dt;
            if slow_acc >= SLOW_WINDOW {
                slow_acc -= SLOW_WINDOW;
                tps = (tps - 1.0).max(MIN_TPS);
            }
        }
    } else if dt < step_dt * 0.5 {
        slow_acc = 0.0;
        if tps < INIT_TPS {
            fast_acc += dt;
            if fast_acc >= FAST_WINDOW {
                fast_acc -= FAST_WINDOW;
                tps = (tps + 1.0).min(INIT_TPS);
            }
        }
    }
    (tps, slow_acc, fast_acc)
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

const DEAD_METROID: Metroid = Metroid {
    x: 0.0,
    y: 0.0,
    vx: 0.0,
    vy: 0.0,
    active: false,
};

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
    hold_x: f32,
    hold_y: f32,
    /// 0 = none, 1 = right button (heal), 2 = left button (erode).
    hold_mode: u32,
    /// Natural erosion rate as a percent of normal (100 = default). The static
    /// reseed drops it to 50 to halve how fast live cells eat their alpha.
    decay_pct: u32,
    /// Target generations per second. Starts at INIT_TPS, ratchets down by 1
    /// per SLOW_WINDOW seconds of sustained overload (never below MIN_TPS) and
    /// climbs back up by 1 per FAST_WINDOW seconds of headroom, so the sim
    /// settles at whatever rate the machine can actually render.
    target_tps: f32,
    /// Accumulated real seconds spent overloaded (dropping generations). Each
    /// time it crosses SLOW_WINDOW it spends one tick/sec off `target_tps`.
    slow_acc: f32,
    /// Accumulated real seconds spent with idle frame budget. Each time it
    /// crosses FAST_WINDOW it wins one tick/sec back on `target_tps`.
    fast_acc: f32,
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
    hold_x: 0.0,
    hold_y: 0.0,
    hold_mode: 0,
    decay_pct: 100,
    target_tps: INIT_TPS,
    slow_acc: 0.0,
    fast_acc: 0.0,
};

impl Sim {
    fn rand(&mut self) -> u32 {
        xorshift(&mut self.rng)
    }

    fn rand_f(&mut self) -> f32 {
        (self.rand() >> 8) as f32 / 16_777_216.0 // [0, 1)
    }

    fn rand_range(&mut self, lo: f32, hi: f32) -> f32 {
        lo + (hi - lo) * self.rand_f()
    }

    /// (Re)start for a viewport: lay out and stamp the name, clear timers.
    /// Runs on first tick and on `reset()`; a viewport change on a live sim
    /// goes through `resize` instead.
    fn init(
        &mut self,
        w: usize,
        h: usize,
        cells: &mut [u8],
        mask: &mut [u8],
        tile_a: &mut [u8],
        perma: &mut [u8],
        stars: &mut [u8],
    ) {
        let lay = plan_layout(w, h);
        self.w = w;
        self.h = h;
        self.pitch = lay.pitch;
        self.gw = grid_dim(w, lay.pitch).min(MAX_GW);
        self.gh = grid_dim(h, lay.pitch).min(MAX_GH);
        self.ox = (w.saturating_sub(self.gw * self.pitch + 1)) / 3;
        self.oy = (h.saturating_sub(self.gh * self.pitch + 1)) / 3;
        self.t = 0.0;
        self.step_acc = 0.0;
        self.spawn_in = 0.0;
        self.metroids = [DEAD_METROID; MAX_METROIDS];
        mask.fill(0);
        tile_a.fill(255);
        perma.fill(0);
        stamp_text(mask, self.gw, self.gh, &lay);
        cells.fill(0);
        let n = self.gw * self.gh;
        cells[..n].copy_from_slice(&mask[..n]);
        stars[..n].fill(0);
        scatter_stars(&mut self.rng, stars, mask, self.gw, self.gh, self.pitch);
        self.ready = true;
    }

    /// Adapt a live sim to a new viewport without restarting. The grid keeps
    /// its pitch and every buffer keeps its content in grid coordinates:
    /// shrinking clips cells off the far edges, growing exposes fresh ground —
    /// dead, unmasked, fully opaque. Timers, meteors and the RNG run on.
    fn resize(
        &mut self,
        w: usize,
        h: usize,
        cells: &mut [u8],
        mask: &mut [u8],
        tile_a: &mut [u8],
        perma: &mut [u8],
        stars: &mut [u8],
    ) {
        let (ogw, ogh) = (self.gw, self.gh);
        self.w = w;
        self.h = h;
        self.gw = grid_dim(w, self.pitch).min(MAX_GW);
        self.gh = grid_dim(h, self.pitch).min(MAX_GH);
        self.ox = (w.saturating_sub(self.gw * self.pitch + 1)) / 3;
        self.oy = (h.saturating_sub(self.gh * self.pitch + 1)) / 3;
        for (buf, fill) in [
            (&mut *cells, 0u8),
            (&mut *mask, 0),
            (&mut *tile_a, 255),
            (&mut *perma, 0),
            (&mut *stars, 0),
        ] {
            remap_grid(buf, ogw, ogh, self.gw, self.gh, fill);
        }
        // Fresh ground exposed by a grow starts starless; scatter naturally
        // fills it in at the field's density, leaving the survivors in place.
        scatter_stars(&mut self.rng, stars, mask, self.gw, self.gh, self.pitch);
    }

    /// Spontaneous births, heavily biased to the cells under the name so it
    /// keeps ghosting back through the chaos. Each hit lands a small cluster
    /// rather than a lone cell, which would die before ever being drawn.
    fn ambient_births(&mut self, cells: &mut [u8], mask: &[u8]) {
        let n = self.gw * self.gh;
        for _ in 0..16 {
            let i = self.rand() as usize % n;
            let chance = if mask[i] > 0 { 256 } else { 3 }; // per 256
            if (self.rand() & 0xff) as usize >= chance {
                continue;
            }
            for _ in 0..4 {
                let cx = i % self.gw + self.rand() as usize % 3;
                let cy = i / self.gw + self.rand() as usize % 3;
                if cx < self.gw && cy < self.gh {
                    let c = &mut cells[cy * self.gw + cx];
                    *c = (*c).max(1);
                }
            }
        }
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
                    self.metroids[i] = Metroid {
                        x,
                        y,
                        vx,
                        vy,
                        active: true,
                    };
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
                // The comet has no sprite: the cells it births each frame are
                // the only thing you see, so keep the trail dense enough to read.
                let births = 2 + self.rand() % 3;
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

// --- Exports -----------------------------------------------------------------

#[no_mangle]
pub extern "C" fn frame_ptr() -> *mut u8 {
    addr_of_mut!(FRAME).cast()
}

/// Restart the simulation. The next `tick` re-lays-out for its viewport. Also
/// clears any half-rate erosion left by a static reseed.
#[no_mangle]
pub extern "C" fn reset() {
    let sim = unsafe { &mut *addr_of_mut!(SIM) };
    sim.ready = false;
    sim.decay_pct = 100;
}

/// Seed the PRNG (meteor timing/angles, trail scatter). Zero is remapped so
/// xorshift never locks up.
#[no_mangle]
pub extern "C" fn seed(s: u32) {
    unsafe { (*addr_of_mut!(SIM)).rng = if s == 0 { 0x9e37_79b9 } else { s } }
}

/// Report the mouse-hold point in framebuffer pixels. `mode` 1 heals tile
/// alpha (right button), 2 erodes it (left button), 0 clears the hold. The
/// effect is applied once per generation while the hold is active.
#[no_mangle]
pub extern "C" fn hold(x: f32, y: f32, mode: u32) {
    let sim = unsafe { &mut *addr_of_mut!(SIM) };
    sim.hold_x = x;
    sim.hold_y = y;
    sim.hold_mode = mode;
}

/// Shift every tile's alpha by `d`, clamped at both ends: positive restores
/// opacity, negative erodes it.
fn fade_tiles(tile_a: &mut [u8], d: i32) {
    let step = d.unsigned_abs().min(255) as u8;
    for a in tile_a.iter_mut() {
        *a = if d >= 0 {
            a.saturating_add(step)
        } else {
            a.saturating_sub(step)
        };
    }
}

/// Board-wide alpha shift driven by page scrolling: JS converts wheel travel
/// into `d` (positive = restore, negative = erode).
#[no_mangle]
pub extern "C" fn fade(d: i32) {
    let sim = unsafe { &mut *addr_of_mut!(SIM) };
    if !sim.ready {
        return;
    }
    let tile_a: &mut [u8] = unsafe { &mut *addr_of_mut!(TILE_A) };
    fade_tiles(&mut tile_a[..sim.gw * sim.gh], d);
}

/// Scale the natural per-generation erosion rate, as a percent of normal
/// (100 = default). JS passes 50 while the "static" overlay is on, so the
/// board dissolves half as fast. Clamped to a sane range.
#[no_mangle]
pub extern "C" fn set_decay(pct: u32) {
    let sim = unsafe { &mut *addr_of_mut!(SIM) };
    sim.decay_pct = pct.clamp(1, 400);
}

/// "Static" reseed: re-cover the board fully opaque, fill the grid with random
/// static (no name), skip the name-hold so Life runs at once, and halve the
/// erosion rate — a reset whose seed is noise instead of the name.
#[no_mangle]
pub extern "C" fn static_fill() {
    let sim = unsafe { &mut *addr_of_mut!(SIM) };
    if !sim.ready {
        return;
    }
    let cells: &mut [u8] = unsafe { &mut *addr_of_mut!(CELLS) };
    let tile_a: &mut [u8] = unsafe { &mut *addr_of_mut!(TILE_A) };
    let perma: &mut [u8] = unsafe { &mut *addr_of_mut!(PERMA) };
    let n = sim.gw * sim.gh;
    for c in cells[..n].iter_mut() {
        *c = (sim.rand() % 16 < STATIC_FILL) as u8;
    }
    tile_a[..n].fill(255); // reset the screen to full opacity
    perma[..n].fill(0);
    sim.t = HOLD; // past the name-hold, so the noise evolves immediately
    sim.step_acc = 0.0;
    sim.decay_pct = 50; // half the transparency loss from here on
}

/// Clear the board to fully transparent, revealing the whole page beneath at
/// once. Dead tiles keep this alpha, so it stays clear except where the margin
/// heals its edge band back.
#[no_mangle]
pub extern "C" fn clear() {
    let sim = unsafe { &mut *addr_of_mut!(SIM) };
    if !sim.ready {
        return;
    }
    let tile_a: &mut [u8] = unsafe { &mut *addr_of_mut!(TILE_A) };
    tile_a[..sim.gw * sim.gh].fill(0);
}

/// Stroke between two framebuffer-pixel points, so JS can join successive
/// pointer events into one continuous line. `alive != 0` births cells under
/// the stroke; `0` kills them. `radius` is the brush half-width in cells
/// (0 = single cell).
#[no_mangle]
pub extern "C" fn paint(x0: f32, y0: f32, x1: f32, y1: f32, alive: u32, radius: u32) {
    let sim = unsafe { &mut *addr_of_mut!(SIM) };
    if !sim.ready {
        return;
    }
    let cells: &mut [u8] = unsafe { &mut *addr_of_mut!(CELLS) };
    let p = sim.pitch as f32;
    let (ox, oy) = (sim.ox as f32, sim.oy as f32);
    #[rustfmt::skip]
    paint_line(
        cells, sim.gw, sim.gh,
        (x0 - ox) / p, (y0 - oy) / p,
        (x1 - ox) / p, (y1 - oy) / p,
        alive != 0, radius.min(16) as i32,
    );
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
    let mask: &mut [u8] = unsafe { &mut *addr_of_mut!(TEXT_MASK) };
    let tile_a: &mut [u8] = unsafe { &mut *addr_of_mut!(TILE_A) };
    let perma: &mut [u8] = unsafe { &mut *addr_of_mut!(PERMA) };
    let stars: &mut [u8] = unsafe { &mut *addr_of_mut!(STARS) };

    if !sim.ready {
        sim.init(width, height, cells, mask, tile_a, perma, stars);
    } else if sim.w != width || sim.h != height {
        sim.resize(width, height, cells, mask, tile_a, perma, stars);
    }
    sim.t += dt;

    let (gw, gh, pitch, ox, oy) = (sim.gw, sim.gh, sim.pitch, sim.ox as i32, sim.oy as i32);
    let n_cells = gw * gh;

    // Fixed-timestep generations (capped so a background-tab stall can't
    // spiral). During the hold the name stays frozen but still ages, ramping
    // its colour from bright lime down to deep green before evolution begins.
    // Backlog past the per-frame cap is dropped rather than banked, so a long
    // stall resumes at real time instead of fast-forwarding the missed frames.
    // Adapt the generation rate to the frame budget: overloaded frames ratchet
    // it down, idle ones very slowly win it back (see `ease_target_rate`). The
    // rate persists across resize/reset, so a slow device stays slow.
    (sim.target_tps, sim.slow_acc, sim.fast_acc) =
        ease_target_rate(sim.target_tps, sim.slow_acc, sim.fast_acc, sim.step_acc, dt);
    let step_dt = 1.0 / sim.target_tps;
    sim.step_acc = (sim.step_acc + dt).min(step_dt * 4.0);
    let mut steps = 0;
    while sim.step_acc >= step_dt && steps < 4 {
        sim.step_acc -= step_dt;
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
            sim.ambient_births(cells, mask);
        }
        decay_tiles(cells, tile_a, gw, gh, sim.decay_pct);
        heal_margin(tile_a, gw, gh);
        if sim.hold_mode != 0 {
            // Same floor-via-offset trick as paint_line for cursor positions
            // left/above the grid.
            let p = sim.pitch as f32;
            let cx = ((sim.hold_x - sim.ox as f32) / p + 4096.0) as i32 - 4096;
            let cy = ((sim.hold_y - sim.oy as f32) / p + 4096.0) as i32 - 4096;
            hold_brush(tile_a, sim.gw, sim.gh, cx, cy, sim.hold_mode == 1);
        }
        mark_perma(tile_a, perma, gw, gh);
        for i in 0..n_cells {
            if perma[i] > 0 {
                cells[i] = cells[i].max(1);
            }
        }
    }

    sim.update_metroids(dt, cells);

    // Render into the framebuffer as packed little-endian RGBA words. FRAME is
    // 4-aligned and its length is a multiple of 4, so the whole buffer is one
    // clean u32 run: background, grid lines and cells each store a full pixel
    // per instruction instead of four separate bytes.
    let fb = unsafe { core::slice::from_raw_parts_mut(frame_ptr(), width * height * 4) };
    let (pre, fb, post) = unsafe { fb.align_to_mut::<u32>() };
    debug_assert!(pre.is_empty() && post.is_empty());

    fb.fill(u32::from_le_bytes([BG[0], BG[1], BG[2], 0xff]));

    // Grid lines fade with the ground: each segment takes the max alpha of the
    // (up to) two tiles it separates, so the grid vanishes over fully eroded
    // neighbourhoods. Segments overlap one pixel at intersections; whichever
    // draws last wins, invisible at 1px. Every segment sits inside the buffer
    // (ox + gw*pitch + 1 <= width, likewise height), so these index directly.
    let grid_px = |a: u8| u32::from_le_bytes([GRID_LINE[0], GRID_LINE[1], GRID_LINE[2], a]);
    let tile = |cx: usize, cy: usize| tile_a[cy * gw + cx];
    let (ox, oy) = (ox as usize, oy as usize);
    for j in 0..=gh {
        let row = (oy + j * pitch) * width + ox;
        for cx in 0..gw {
            let above = if j > 0 { tile(cx, j - 1) } else { 0 };
            let below = if j < gh { tile(cx, j) } else { 0 };
            let px = grid_px(above.max(below));
            let base = row + cx * pitch;
            for k in 0..=pitch {
                fb[base + k] = px;
            }
        }
    }
    for i in 0..=gw {
        let col = ox + i * pitch;
        for cy in 0..gh {
            let left = if i > 0 { tile(i - 1, cy) } else { 0 };
            let right = if i < gw { tile(i, cy) } else { 0 };
            let px = grid_px(left.max(right));
            let mut idx = (oy + cy * pitch) * width + col;
            for _ in 0..=pitch {
                fb[idx] = px;
                idx += width;
            }
        }
    }

    // Cells: skip opaque dead ground (the background already shows there);
    // everything else fills its pitch-1 square interior, also in-bounds.
    // A dead tile carrying a star draws instead a small centred green speck,
    // never wider than 4px, over whatever the ground under it shows.
    let cell_px = pitch - 1;
    // Every star pattern lives in a 4x4 box, centred in the cell (clipped on
    // the smallest pitches where the interior is under 4px).
    let star_box = cell_px.min(4);
    let star_off = (cell_px - star_box) / 2;
    for cy in 0..gh {
        let y0 = (oy + cy * pitch + 1) * width + ox + 1;
        for cx in 0..gw {
            let idx = cy * gw + cx;
            let age = cells[idx];
            let a = tile_a[idx];
            let sty = if age == 0 { stars[idx] } else { 0 };
            if age == 0 && a == 255 && sty == 0 {
                continue;
            }
            // Base interior: live cells and eroding ground paint the whole
            // square; an intact star tile leaves the opaque background showing.
            if age > 0 || a < 255 {
                let c = if age > 0 { cell_colour(age) } else { BG };
                let px = u32::from_le_bytes([c[0], c[1], c[2], a]);
                let mut row = y0 + cx * pitch;
                for _ in 0..cell_px {
                    for rx in 0..cell_px {
                        fb[row + rx] = px;
                    }
                    row += width;
                }
            }
            // Star speck: its type sets shape and brightness, but it never
            // outshines the ground it sits on, so erosion reveals the page
            // through it too.
            if sty > 0 {
                let (ka, pat) = star_kind(sty);
                let px =
                    u32::from_le_bytes([STAR_COLOUR[0], STAR_COLOUR[1], STAR_COLOUR[2], a.min(ka)]);
                let base = y0 + cx * pitch + star_off * width + star_off;
                for sy in 0..star_box {
                    let row = base + sy * width;
                    for sx in 0..star_box {
                        if (pat >> ((3 - sy) * 4 + (3 - sx))) & 1 == 1 {
                            fb[row + sx] = px;
                        }
                    }
                }
            }
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
        assert_eq!(
            alive_set(&next, gw, gh),
            vec![(1, 1), (1, 2), (2, 1), (2, 2)]
        );
    }

    #[test]
    fn layout_fits_desktop_and_phone() {
        for (w, h) in [
            (1920usize, 1080usize),
            (390, 844),
            (768, 1024),
            (2560usize.min(MAX_W), 1080),
        ] {
            let lay = plan_layout(w, h);
            let gw = grid_dim(w, lay.pitch);
            let gh = grid_dim(h, lay.pitch);
            assert!(lay.scale >= 1, "{w}x{h} got scale 0");
            let max_chars = lay.lines.iter().map(|l| l.len()).max().unwrap();
            assert!(
                max_chars * GLYPH_W * lay.scale <= gw,
                "{w}x{h} overflows width"
            );
            assert!(
                block_height(lay.lines.len(), lay.scale) <= gh,
                "{w}x{h} overflows height"
            );
        }
        // Desktop should render the name big: letters at least 32 cells tall.
        let lay = plan_layout(1920, 1080);
        assert!(GLYPH_H * lay.scale >= 32, "desktop letters too small");
    }

    #[test]
    fn paint_stroke_is_gap_free_and_erases() {
        let (gw, gh) = (30, 20);
        let mut cells = vec![0u8; gw * gh];
        paint_line(&mut cells, gw, gh, 2.0, 3.0, 27.0, 15.0, true, 1);
        let alive = alive_set(&cells, gw, gh);
        assert!(!alive.is_empty());
        // A fast diagonal drag must leave a solid line: every column the
        // stroke crosses holds at least the brush's width of cells.
        for x in 3..=26 {
            let col = alive.iter().filter(|&&(ax, _)| ax == x).count();
            assert!(col >= 3, "column {x} too thin: {col} cells");
        }
        // Erasing along the same path with a wider brush kills everything.
        paint_line(&mut cells, gw, gh, 2.0, 3.0, 27.0, 15.0, false, 2);
        assert!(alive_set(&cells, gw, gh).is_empty());
    }

    #[test]
    fn remap_grid_clips_and_expands() {
        // 3x2 grid grown to 5x4: content pins to the top-left, new ground
        // takes the fill value.
        let mut buf = vec![0u8; 5 * 4];
        buf[..6].copy_from_slice(&[1, 2, 3, 4, 5, 6]);
        remap_grid(&mut buf, 3, 2, 5, 4, 9);
        #[rustfmt::skip]
        assert_eq!(
            buf,
            [1, 2, 3, 9, 9,
             4, 5, 6, 9, 9,
             9, 9, 9, 9, 9,
             9, 9, 9, 9, 9]
        );
        // Shrink to 2x3: the overlap survives the round trip, the rest drops.
        remap_grid(&mut buf, 5, 4, 2, 3, 7);
        assert_eq!(buf[..6], [1, 2, 4, 5, 9, 9]);
    }

    /// Drives the real exports end to end: after the hold phase plus a couple
    /// hundred generations, live cells must have eroded some tiles, and the
    /// rendered framebuffer must carry non-opaque alpha for the page beneath
    /// to show through. Runs alone against the shared statics — the only test
    /// that touches them.
    #[test]
    fn tick_erodes_alpha_into_framebuffer() {
        let (w, h) = (320usize, 200usize);
        seed(1);
        reset();
        for _ in 0..400 {
            tick(w, h, 0.05); // 20 simulated seconds ≈ 240 generations
        }
        let fb = unsafe { core::slice::from_raw_parts(frame_ptr(), w * h * 4) };
        let faded = fb.chunks_exact(4).filter(|px| px[3] < 0xff).count();
        assert!(faded > 0, "no framebuffer pixel ever lost alpha");
        // A mid-run viewport change must clip/expand the live board, not
        // restart it: ground eroded at the old size still reads through at
        // the new one (a restart would render fully opaque).
        let (w2, h2) = (400usize, 260usize);
        tick(w2, h2, 0.0);
        let fb = unsafe { core::slice::from_raw_parts(frame_ptr(), w2 * h2 * 4) };
        let faded = fb.chunks_exact(4).filter(|px| px[3] < 0xff).count();
        assert!(faded > 0, "resize wiped the eroded ground");
        reset();
    }

    #[test]
    fn tiles_decay_only_under_live_cells() {
        let (gw, gh) = (3, 3);
        let mut cells = vec![0u8; gw * gh];
        let mut tile_a = vec![255u8; gw * gh];
        cells[4] = 1;
        for _ in 0..255 {
            decay_tiles(&cells, &mut tile_a, gw, gh, 100);
        }
        assert_eq!(tile_a[4], 0, "live tile fully transparent after 255 gens");
        assert!(tile_a.iter().enumerate().all(|(i, &a)| i == 4 || a == 255));
        // Saturates at zero and dead tiles never recover on their own.
        decay_tiles(&cells, &mut tile_a, gw, gh, 100);
        cells[4] = 0;
        decay_tiles(&cells, &mut tile_a, gw, gh, 100);
        assert_eq!(tile_a[4], 0);
    }

    #[test]
    fn fade_tiles_shifts_and_clamps() {
        let mut tile_a = vec![0u8, 100, 250];
        fade_tiles(&mut tile_a, 10);
        assert_eq!(tile_a, vec![10, 110, 255]);
        fade_tiles(&mut tile_a, -15);
        assert_eq!(tile_a, vec![0, 95, 240]);
    }

    #[test]
    fn margin_heals_strongest_at_border() {
        let (gw, gh) = (40, 40);
        let mut tile_a = vec![100u8; gw * gh];
        heal_margin(&mut tile_a, gw, gh);
        // m = 40/20 = 2: the border row gains full MARGIN_HEAL, one row in a
        // quarter of it, two rows in nothing.
        assert_eq!(tile_a[20], 100 + MARGIN_HEAL);
        assert_eq!(tile_a[gw + 20], 100 + MARGIN_HEAL / 4);
        assert_eq!(tile_a[2 * gw + 20], 100, "inside the band untouched");
        // The very border must out-heal even 3x interior decay so the screen
        // edge never dissolves for good.
        assert!(MARGIN_HEAL > 3 * DECAY);
    }

    #[test]
    fn interior_tiles_decay_faster_than_edges() {
        let (gw, gh) = (3, 3);
        let cells = vec![1u8; gw * gh];
        let mut tile_a = vec![255u8; gw * gh];
        decay_tiles(&cells, &mut tile_a, gw, gh, 100);
        // Centre has 8 live neighbours: 3x decay. Corners (3 neighbours) take
        // just the base rate — the quadratic ramp still rounds to zero there.
        assert_eq!(255 - tile_a[4], 3 * DECAY);
        assert_eq!(255 - tile_a[0], DECAY);
        // Side cells (5 neighbours) land between the two.
        assert!(tile_a[0] > tile_a[1] && tile_a[1] > tile_a[4]);
    }

    #[test]
    fn decay_rate_scales_and_never_stalls() {
        let (gw, gh) = (3, 3);
        let cells = vec![1u8; gw * gh]; // centre sees all 8 neighbours
                                        // 100% reproduces the unscaled loss; 50% roughly halves it.
        let mut full = vec![255u8; gw * gh];
        decay_tiles(&cells, &mut full, gw, gh, 100);
        assert_eq!(255 - full[4], 3 * DECAY);
        let mut half = vec![255u8; gw * gh];
        decay_tiles(&cells, &mut half, gw, gh, 50);
        // Full centre loss is 9; halved and rounded to nearest gives 5, still
        // strictly gentler than the unscaled rate.
        assert_eq!(255 - half[4], 5);
        assert!(255 - half[4] < 255 - full[4]);
        // A live tile always loses at least one step, however low the percent.
        let mut trickle = vec![255u8; gw * gh];
        decay_tiles(&cells, &mut trickle, gw, gh, 1);
        assert_eq!(
            255 - trickle[0],
            1,
            "erosion never fully stalls on a live tile"
        );
    }

    #[test]
    fn perma_needs_own_tile_and_three_neighbours_transparent() {
        let (gw, gh) = (4, 4);
        let mut tile_a = vec![255u8; gw * gh];
        let mut perma = vec![0u8; gw * gh];
        for (x, y) in [(1, 1), (0, 0), (1, 0), (2, 0)] {
            tile_a[y * gw + x] = 0;
        }
        mark_perma(&tile_a, &mut perma, gw, gh);
        // (1,1) and (1,0) each see 3 transparent neighbours; the corner (0,0)
        // and edge (2,0) only 2; (2,1) has 3 but its own tile is opaque.
        let got: Vec<_> = (0..gh)
            .flat_map(|y| (0..gw).map(move |x| (x, y)))
            .filter(|&(x, y)| perma[y * gw + x] > 0)
            .collect();
        assert_eq!(got, vec![(1, 0), (1, 1)]);
        // Healing a marked tile clears its mark: the cell goes mortal again.
        tile_a[gw + 1] = 1;
        mark_perma(&tile_a, &mut perma, gw, gh);
        assert_eq!(perma[gw + 1], 0, "healed tile unmarked");
        assert_eq!(perma[1], 1, "still-eroded tile stays marked");
    }

    #[test]
    fn hold_brush_heals_erodes_and_clips() {
        let (gw, gh) = (9, 9);
        let mut tile_a = vec![100u8; gw * gh];
        hold_brush(&mut tile_a, gw, gh, 4, 4, true);
        let at = |t: &[u8], x: usize, y: usize| t[y * gw + x];
        // Full strength under the cursor, fading with distance out to HOLD_R;
        // beyond the rim nothing changes.
        assert_eq!(at(&tile_a, 4, 4), 100 + HOLD_HEAL);
        let ring: Vec<u8> = (4..=8).map(|x| at(&tile_a, x, 4)).collect();
        assert!(ring.windows(2).all(|w| w[0] > w[1]), "falloff monotonic");
        assert_eq!(ring[4], 100, "tile beyond radius untouched");
        // Non-linear: the drop from centre to 1 out is gentler than 1 to 2.
        assert!(ring[0] - ring[1] < ring[1] - ring[2]);
        // Erasing bites harder than repairing: one erode outweighs one heal.
        hold_brush(&mut tile_a, gw, gh, 4, 4, false);
        assert_eq!(at(&tile_a, 4, 4), 100 + HOLD_HEAL - HOLD_ERODE);
        // Erode undoes the heal and saturates at fully transparent.
        for _ in 0..20 {
            hold_brush(&mut tile_a, gw, gh, 4, 4, false);
        }
        assert_eq!(at(&tile_a, 4, 4), 0);
        // A corner hold clips its out-of-bounds tiles; healing caps at 255.
        for _ in 0..20 {
            hold_brush(&mut tile_a, gw, gh, 0, 0, true);
        }
        assert_eq!(tile_a[0], 255);
        // A hold far off-grid touches nothing and must not panic.
        let before = tile_a.clone();
        hold_brush(&mut tile_a, gw, gh, -5, -5, true);
        assert_eq!(tile_a, before);
    }

    #[test]
    fn target_rate_eases_down_under_overload_and_crawls_back_with_headroom() {
        let step_dt = 1.0 / INIT_TPS;
        // A frame that is neither overloaded nor idle holds the rate and both
        // timers (dt == step_dt: too big for headroom, too small to overload).
        assert_eq!(
            ease_target_rate(INIT_TPS, 0.0, 0.0, 0.0, step_dt),
            (INIT_TPS, 0.0, 0.0)
        );
        // One overloaded frame (backlog past the 4-step cap) banks its dt but
        // can't drop the rate until a full SLOW_WINDOW has accrued.
        let big = step_dt * 5.0;
        let (tps, slow, _) = ease_target_rate(INIT_TPS, 0.0, 0.0, 0.0, big);
        assert_eq!(tps, INIT_TPS, "one slow frame is not enough");
        assert_eq!(slow, big);
        // Feed overloaded frames until SLOW_WINDOW is crossed: exactly one
        // tick/sec comes off, and the leftover carries into the next window.
        let (mut tps, mut slow, mut fast) = (INIT_TPS, 0.0f32, 0.0f32);
        let mut steps = 0;
        while tps == INIT_TPS {
            (tps, slow, fast) = ease_target_rate(tps, slow, fast, 0.0, 1.0);
            steps += 1;
        }
        assert_eq!(tps, INIT_TPS - 1.0);
        assert!((steps as f32) >= SLOW_WINDOW, "dropped too early");
        assert!(
            slow < SLOW_WINDOW,
            "leftover overload should carry, not reset"
        );
        // It ratchets all the way to MIN_TPS and then stops — no runaway.
        let mut tps = MIN_TPS + 1.0;
        for _ in 0..10_000 {
            let sd = 1.0 / tps;
            (tps, ..) = ease_target_rate(tps, SLOW_WINDOW, 0.0, 0.0, sd * 5.0);
        }
        assert_eq!(tps, MIN_TPS);
        // At the floor an overloaded frame changes nothing.
        let sd = 1.0 / MIN_TPS;
        assert_eq!(
            ease_target_rate(MIN_TPS, 0.0, 0.0, 0.0, sd * 9.0),
            (MIN_TPS, 0.0, 0.0)
        );

        // Climb-back: from a lowered rate, frames with ample headroom (dt well
        // under half the step interval) win one tick/sec back — but only after
        // a full FAST_WINDOW, which is far longer than the SLOW_WINDOW drop.
        let start = INIT_TPS - 3.0;
        let (mut tps, mut slow, mut fast) = (start, 0.0f32, 0.0f32);
        let mut secs = 0.0f32;
        while tps == start {
            let sd = 1.0 / tps;
            (tps, slow, fast) = ease_target_rate(tps, slow, fast, 0.0, sd * 0.25);
            secs += sd * 0.25;
        }
        assert_eq!(tps, start + 1.0, "headroom wins back exactly one tick/sec");
        assert!(secs >= FAST_WINDOW, "climbed back too soon");
        assert!(
            FAST_WINDOW > SLOW_WINDOW,
            "climb must be slower than the drop"
        );
        // Headroom stops climbing once back at INIT_TPS — no overshoot.
        let sd = 1.0 / INIT_TPS;
        assert_eq!(
            ease_target_rate(INIT_TPS, 0.0, FAST_WINDOW, 0.0, sd * 0.25),
            (INIT_TPS, 0.0, FAST_WINDOW)
        );
        // An overloaded frame wipes any banked headroom, and a headroom frame
        // wipes any banked overload, so brief blips never tip the rate.
        let (_, _, fast) = ease_target_rate(INIT_TPS - 1.0, 0.0, 3.0, 0.0, step_dt * 5.0);
        assert_eq!(fast, 0.0, "overload clears headroom credit");
        let sd = 1.0 / (INIT_TPS - 1.0);
        let (_, slow, _) = ease_target_rate(INIT_TPS - 1.0, 3.0, 0.0, 0.0, sd * 0.25);
        assert_eq!(slow, 0.0, "headroom clears overload credit");
    }

    #[test]
    fn stars_scatter_spaced_clear_of_name_and_varied() {
        let (gw, gh, pitch) = (200usize, 120usize, 8usize);
        let mut mask = vec![0u8; gw * gh];
        for y in 50..70 {
            for x in 80..120 {
                mask[y * gw + x] = 1; // a name-shaped block in the middle
            }
        }
        let mut stars = vec![0u8; gw * gh];
        let mut rng = 0x1234_5678u32;
        scatter_stars(&mut rng, &mut stars, &mask, gw, gh, pitch);

        let pts: Vec<(usize, usize)> = (0..gh)
            .flat_map(|y| (0..gw).map(move |x| (x, y)))
            .filter(|&(x, y)| stars[y * gw + x] > 0)
            .collect();
        assert!(pts.len() > 20, "scattered too few stars: {}", pts.len());

        let word_gap = STAR_WORD_PX.div_ceil(pitch).max(1);
        for &(x, y) in &pts {
            assert!(
                !near(&mask, gw, gh, x, y, word_gap),
                "star at {:?} sits within {STAR_WORD_PX}px of the name",
                (x, y)
            );
        }
        // Every pair clears the 16px minimum (Chebyshev distance × pitch).
        for i in 0..pts.len() {
            for j in i + 1..pts.len() {
                let cheb = pts[i].0.abs_diff(pts[j].0).max(pts[i].1.abs_diff(pts[j].1));
                assert!(
                    cheb * pitch >= STAR_MIN_PX,
                    "stars {:?} and {:?} only {}px apart",
                    pts[i],
                    pts[j],
                    cheb * pitch
                );
            }
        }
        // The field mixes types, and each renders inside a 4x4 box.
        let mut kinds = [0u32; 6];
        for &(x, y) in &pts {
            let ty = stars[y * gw + x];
            kinds[ty as usize] += 1;
            let (a, pat) = star_kind(ty);
            assert!(a <= STAR_ALPHA && pat != 0);
        }
        assert!(
            kinds[1..].iter().filter(|&&c| c > 0).count() >= 2,
            "expected multiple star types, got {kinds:?}"
        );
        // A second pass (the resize top-up) only adds; it never moves a star.
        let before = stars.clone();
        scatter_stars(&mut rng, &mut stars, &mask, gw, gh, pitch);
        assert!(
            before.iter().zip(&stars).all(|(&b, &a)| b == 0 || b == a),
            "top-up disturbed an existing star"
        );
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
        let advance = GLYPH_W * lay.scale;
        assert!(min_x.abs_diff(gw - 1 - max_x) <= advance);
        assert!(min_y.abs_diff(gh - 1 - max_y) <= advance);
    }
}
