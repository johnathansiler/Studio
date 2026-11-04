//! Host-agnostic plugin contract. Field names follow `src/audio/core/contract.ts`.
//!
//! The audio callback may call `process_block`, `set_parameter`, and `get_parameter`.
//! Those do not allocate. `prepare` is where block-sized memory is reserved.
//! `get_state` / `set_state` are for the control thread; `get_state` returns an
//! owned buffer.

/// Channel 0 is left. The host owns the sample memory.
pub struct AudioBlock<'a> {
    pub channels: [&'a mut [f32]; 2],
    pub num_channels: usize,
    pub num_samples: usize,
}

/// One MIDI event at a sample offset inside the current block.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MidiEvent {
    pub sample_offset: u32,
    pub status: u8,
    pub data1: u8,
    pub data2: u8,
}

pub struct MidiBlock<'a> {
    pub events: &'a [MidiEvent],
    pub num_events: u32,
}

pub const EMPTY_MIDI: MidiBlock<'static> = MidiBlock {
    events: &[],
    num_events: 0,
};

#[derive(Clone, Copy, Debug)]
pub struct ControlLayout {
    pub param_id: u32,
    pub key: &'static str,
    pub name: &'static str,
    pub min: f64,
    pub max: f64,
    pub default_value: f64,
    pub unit: &'static str,
    pub automatable: bool,
}

#[derive(Clone, Copy, Debug)]
pub struct PluginLayout {
    pub id: &'static str,
    pub name: &'static str,
    pub version: &'static str,
    pub controls: &'static [ControlLayout],
}

pub trait NativePlugin {
    fn prepare(&mut self, sample_rate: f64, max_block_size: usize);
    fn release(&mut self);
    fn reset(&mut self);
    fn process_block(&mut self, audio: &mut AudioBlock<'_>, midi: &MidiBlock<'_>);
    fn set_parameter(&mut self, param_id: u32, value: f64);
    fn get_parameter(&self, param_id: u32) -> f64;
    fn num_parameters(&self) -> u32;
    fn latency_in_samples(&self) -> u32;
    fn get_state(&self) -> Vec<u8>;
    fn set_state(&mut self, data: &[u8]) -> bool;
    fn layout(&self) -> &'static PluginLayout;
}
