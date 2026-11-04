//! Shared DSP core for the web (WASM), a native app, and a DAW plugin.
//!
//! `process_block` does not allocate. Block-sized buffers are reserved in
//! `prepare`. Parameters glide with the same 10 ms curve as `glideValue`.

mod biquad;
mod contract;
mod eq;
mod smooth;
mod state;

#[cfg(target_arch = "wasm32")]
#[allow(private_interfaces)]
mod wasm;

pub use biquad::{design_biquad, sanitize, Biquad, BiquadKind};
pub use contract::{
    AudioBlock, ControlLayout, MidiBlock, MidiEvent, NativePlugin, PluginLayout, EMPTY_MIDI,
};
pub use eq::{EqProcessor, EQ_PARAMS};
pub use smooth::{glide_block, glide_sample, sample_alpha, ParamSmoother};
