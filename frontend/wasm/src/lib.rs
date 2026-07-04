//! Dependency-free, `no_std` WASM game core.
//!
//! The framebuffer and game state are fixed statics living in wasm bss, so the
//! module needs no allocator and no wasm-bindgen glue — just three exports:
//!
//!   * `frame_ptr()`            -> pointer to the RGBA framebuffer
//!   * `tick(w, h, dt)`         -> advance game state by `dt` seconds and render
//!   * `reset()`                -> restart game state (call when (re)shown)
//!
//! JS calls `frame_ptr` once, then `tick` every animation frame, and blits the
//! buffer to a `<canvas>` with `putImageData`.

#![no_std]

use core::panic::PanicInfo;
use core::ptr::addr_of_mut;

#[panic_handler]
fn panic(_: &PanicInfo) -> ! {
    core::arch::wasm32::unreachable()
}

/// Max backing resolution the framebuffer supports. It is a zero-initialised
/// static (wasm bss), so it costs nothing in the compiled binary and lets us
/// skip a heap allocator entirely. JS must never pass a larger `w`/`h`.
const MAX_W: usize = 1920;
const MAX_H: usize = 1080;
static mut FRAME: [u8; MAX_W * MAX_H * 4] = [0; MAX_W * MAX_H * 4];

// --- Game state (persists across ticks) -----------------------------------

const BOX: f32 = 56.0;

struct Game {
    x: f32,
    y: f32,
    vx: f32,
    vy: f32,
    ready: bool,
}

static mut GAME: Game = Game {
    x: 0.0,
    y: 0.0,
    vx: 0.0,
    vy: 0.0,
    ready: false,
};

#[no_mangle]
pub extern "C" fn frame_ptr() -> *mut u8 {
    addr_of_mut!(FRAME).cast()
}

/// Restart game state. The next `tick` re-centres the entity for its viewport.
#[no_mangle]
pub extern "C" fn reset() {
    unsafe { (*addr_of_mut!(GAME)).ready = false }
}

/// Advance the simulation by `dt` seconds, then render into the framebuffer.
#[no_mangle]
pub extern "C" fn tick(width: usize, height: usize, dt: f32) {
    if width == 0 || height == 0 || width > MAX_W || height > MAX_H {
        return;
    }
    let g = unsafe { &mut *addr_of_mut!(GAME) };
    let w = width as f32;
    let h = height as f32;

    if !g.ready {
        g.x = (w - BOX) * 0.5;
        g.y = (h - BOX) * 0.5;
        g.vx = 220.0;
        g.vy = 170.0;
        g.ready = true;
    }

    // Integrate + bounce off the walls.
    g.x += g.vx * dt;
    g.y += g.vy * dt;
    if g.x < 0.0 {
        g.x = 0.0;
        g.vx = -g.vx;
    } else if g.x + BOX > w {
        g.x = w - BOX;
        g.vx = -g.vx;
    }
    if g.y < 0.0 {
        g.y = 0.0;
        g.vy = -g.vy;
    } else if g.y + BOX > h {
        g.y = h - BOX;
        g.vy = -g.vy;
    }

    // Render: clear to stone-950, then draw a lime-500 box.
    let fb = unsafe { core::slice::from_raw_parts_mut(frame_ptr(), width * height * 4) };
    for px in fb.chunks_exact_mut(4) {
        px[0] = 0x0c;
        px[1] = 0x0a;
        px[2] = 0x09;
        px[3] = 0xff;
    }

    let x0 = g.x as usize;
    let y0 = g.y as usize;
    let x1 = (x0 + BOX as usize).min(width);
    let y1 = (y0 + BOX as usize).min(height);
    for y in y0..y1 {
        let row = y * width;
        for x in x0..x1 {
            let i = (row + x) * 4;
            fb[i] = 0x84;
            fb[i + 1] = 0xcc;
            fb[i + 2] = 0x16;
            fb[i + 3] = 0xff;
        }
    }
}
