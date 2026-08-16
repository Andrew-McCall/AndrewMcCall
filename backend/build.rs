//! Generates TypeScript bindings for the serialized views the frontend reads.
//!
//! Every `#[derive(Ts)]` struct and enum under `src/` gets one `.ts` file in
//! `bindings/`, which is a small npm package the frontend depends on by path
//! (`file:../backend/bindings`). The bindings are committed, and a plain
//! `cargo build` rewrites them — so a field added to a response type shows up
//! as a frontend type error rather than as `undefined` at runtime.
//!
//! Only the types the frontend actually consumes carry the derive. Internal
//! shapes (`ErrorBody`, `CreatedUser`, the notes `/meta` views) deliberately
//! don't: a binding nothing imports is just another file to keep in step.

use ts_typegen_build::{Config, OptionalStyle, Preset};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    Config::new()
        .scan("src")
        .output("bindings")
        // `uuid::Uuid` and the `chrono` types all serialize as strings.
        .preset(Preset::Common)
        // Applies only to fields serde omits entirely — the ones carrying
        // `skip_serializing_if`, like `PostJson::book_review`. Those keys are
        // *absent*, never null, so `field?: T` describes the wire correctly
        // where the default `field?: T | null` would promise a null we never
        // write. A plain `Option<T>` is untouched by this and stays
        // `field: T | null`, which is exactly what serde puts on the wire.
        .optional_style(OptionalStyle::Question)
        .run()
}
