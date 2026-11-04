//! Shared DSP core for the web (WASM), a native app, and a DAW plugin.
//!
//! `process_block` does not allocate. Block-sized buffers are reserved in
//! `prepare`. Parameters glide with the same 10 ms curve as `glideValue`.

mod amp;
mod biquad;
mod color;
mod contract;
mod dynamics;
mod eq;
mod eqkind;
mod limit;
mod modfx;
mod plugin;
mod psola;
mod resample;
mod shaper;
mod smooth;
mod space;
mod state;
mod synth;
mod tune;
mod util;

#[cfg(target_arch = "wasm32")]
#[allow(private_interfaces)]
mod wasm;

pub use biquad::{design_biquad, sanitize, Biquad, BiquadKind};
pub use contract::{
    AudioBlock, ControlLayout, MidiBlock, MidiEvent, NativePlugin, PluginLayout, EMPTY_MIDI,
};
pub use eq::{EqProcessor, EQ_PARAMS};
pub use plugin::{CuePlugin, PLUGIN_COMP, PLUGIN_DELAY, PLUGIN_EQ, PLUGIN_LIMIT, PLUGIN_MOD, PLUGIN_REVERB, PLUGIN_SAT, PLUGIN_SCALER, PLUGIN_SYNTH, PLUGIN_TUNE, PLUGIN_VOCAL};
pub use smooth::{glide_block, glide_sample, sample_alpha, ParamSmoother, SampleGlide};
