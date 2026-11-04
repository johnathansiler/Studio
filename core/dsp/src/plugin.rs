//! One insert or instrument on the shared contract. `process` does not allocate.

use crate::color::SatBank;
use crate::contract::{AudioBlock, ControlLayout, MidiBlock, NativePlugin, PluginLayout};
use crate::dynamics::{CompBank, Vocal};
use crate::eq::CONTROLS as EQ_CONTROLS;
use crate::eqkind::EqBank;
use crate::limit::LimitBank;
use crate::modfx::ModBank;
use crate::space::SpaceBank;
use crate::state::{read_controls, read_named, write_controls, write_named};
use crate::synth::{Note, Synth};
use crate::tune::Tune;

const MAX_PARAMS: usize = 64;

pub const PLUGIN_TUNE: u32 = 0;
pub const PLUGIN_EQ: u32 = 1;
pub const PLUGIN_COMP: u32 = 2;
pub const PLUGIN_VOCAL: u32 = 3;
pub const PLUGIN_SAT: u32 = 4;
pub const PLUGIN_REVERB: u32 = 5;
pub const PLUGIN_DELAY: u32 = 6;
pub const PLUGIN_MOD: u32 = 7;
pub const PLUGIN_LIMIT: u32 = 8;
pub const PLUGIN_SYNTH: u32 = 9;
pub const PLUGIN_SCALER: u32 = 10;

const TUNE_KEYS: &[&str] = &[
    "retune", "humanize", "flex", "amount", "transpose", "formant", "mode", "root", "scaleIndex", "minHz", "maxHz", "mask", "custom", "bypassMask", "a4", "hq", "color", "vibrato", "holdMidi", "n0", "n1", "n2", "n3", "n4", "n5", "n6", "n7", "n8", "n9", "n10", "n11",
];
const TUNE_DEFAULTS: &[f64] = &[
    0.95, 0.05, 0.0, 0.85, 0.0, 0.0, 1.0, -1.0, -1.0, 80.0, 1000.0, 0.0, 0.0, 0.0, 440.0, 0.0, 0.0, 0.0, -1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0,
];
const COMP_KEYS: &[&str] = &[
    "kind", "threshold", "ratio", "attack", "release", "knee", "makeup", "mix", "releaseMode", "fetIn", "fetOut", "fetRatio", "fetAtk", "fetRel", "optoPeak", "optoGain", "busThresh", "busRatio", "busAtk", "busRel", "hpf", "busMakeup", "variTime", "variIn", "variOut", "variColor", "bands", "x1", "x2", "x3", "x4",
];
const COMP_DEFAULTS: &[f64] = &[
    0.0, 0.0, 1.0, 10.0, 120.0, 0.0, 0.0, 1.0, 1.0, 0.0, 0.0, 0.0, 0.2, 300.0, 0.35, 6.0, -8.0, 1.0, 2.0, 4.0, 80.0, 0.0, 1.0, 0.0, 0.0, 0.35, 4.0, 120.0, 500.0, 2000.0, 6000.0,
];
const VOCAL_KEYS: &[&str] = &["kind", "freq", "threshold", "amount", "gate", "gateRatio", "gateAtk", "gateRel", "hold", "range"];
const VOCAL_DEFAULTS: &[f64] = &[0.0, 6500.0, -18.0, 0.0, -80.0, 1.0, 5.0, 80.0, 20.0, 40.0];
const SAT_KEYS: &[&str] = &[
    "kind", "drive", "tone", "mix", "speed", "bias", "wow", "bump", "hiss", "tube", "color", "clipMode", "ceiling", "gain", "bass", "mid", "treble", "presence", "master", "cab",
];
const SAT_DEFAULTS: &[f64] = &[
    0.0, 0.0, 8000.0, 1.0, 1.0, 0.4, 0.15, 0.4, 0.0, 0.0, 0.0, 0.0, -0.3, 0.35, 0.5, 0.5, 0.5, 0.5, 0.65, 1.0,
];
const REVERB_KEYS: &[&str] = &["kind", "mode", "size", "decay", "damp", "mix", "ir"];
const REVERB_DEFAULTS: &[f64] = &[0.0, 2.0, 0.6, 0.7, 0.4, 0.0, 0.0];
const DELAY_KEYS: &[&str] = &["kind", "sync", "division", "time", "feedback", "pingpong", "filter", "mix", "wow", "drive", "clock"];
const DELAY_DEFAULTS: &[f64] = &[0.0, 1.0, 0.375, 250.0, 0.35, 1.0, 5000.0, 0.0, 0.25, 0.0, 0.45];
const MOD_KEYS: &[&str] = &["kind", "rate", "depth", "mix", "width", "delay", "mode", "feedback", "speed", "semis", "harmony", "harmonyMix"];
const MOD_DEFAULTS: &[f64] = &[0.0, 0.4, 0.4, 0.0, 0.5, 18.0, 0.0, 0.4, 0.0, 0.0, 7.0, 0.0];
const LIMIT_KEYS: &[&str] = &["kind", "threshold", "release", "ceiling", "lookahead", "releaseMode", "target", "width", "bass", "low", "high", "bits", "shape"];
const LIMIT_DEFAULTS: &[f64] = &[0.0, 0.0, 50.0, -0.1, 5.0, 1.0, -14.0, 1.0, 120.0, 1.0, 1.0, 24.0, 0.0];

enum Body {
    Tune(Tune),
    Eq(EqBank),
    Comp(CompBank),
    Vocal(Vocal),
    Sat(SatBank),
    Reverb(SpaceBank),
    Delay(SpaceBank),
    Mod(ModBank),
    Limit(LimitBank),
    Synth(Synth),
    Scaler,
}

pub struct CuePlugin {
    body: Body,
    params: [f64; MAX_PARAMS],
    count: usize,
    keys: &'static [&'static str],
    code: u32,
    sample_rate: f64,
    pub tempo: f64,
    pub eco: bool,
    pub offline: bool,
    pub scale_root: i32,
    intervals: [i32; 24],
    interval_len: usize,
    cents: [f64; 24],
    cent_len: usize,
    notes: [Note; 32],
    note_len: usize,
    pub     side_frames: usize,
    other: Vec<f32>,
    prepared: bool,
    latency: u32,
}

impl CuePlugin {
    pub fn new(code: u32, sample_rate: f64) -> Self {
        let rate = if sample_rate > 0.0 { sample_rate } else { 48_000.0 };
        let (body, keys, defaults) = match code {
            PLUGIN_TUNE => (Body::Tune(Tune::new(rate)), TUNE_KEYS, TUNE_DEFAULTS),
            PLUGIN_COMP => (Body::Comp(CompBank::new()), COMP_KEYS, COMP_DEFAULTS),
            PLUGIN_VOCAL => (Body::Vocal(Vocal::new(rate, 8192)), VOCAL_KEYS, VOCAL_DEFAULTS),
            PLUGIN_SAT => (Body::Sat(SatBank::new(rate)), SAT_KEYS, SAT_DEFAULTS),
            PLUGIN_REVERB => (Body::Reverb(SpaceBank::new(rate)), REVERB_KEYS, REVERB_DEFAULTS),
            PLUGIN_DELAY => (Body::Delay(SpaceBank::new(rate)), DELAY_KEYS, DELAY_DEFAULTS),
            PLUGIN_MOD => (Body::Mod(ModBank::new(rate)), MOD_KEYS, MOD_DEFAULTS),
            PLUGIN_LIMIT => (Body::Limit(LimitBank::new(rate)), LIMIT_KEYS, LIMIT_DEFAULTS),
            PLUGIN_SYNTH => (Body::Synth(Synth::new()), &[][..], &[][..]),
            PLUGIN_SCALER => (Body::Scaler, &[][..], &[][..]),
            _ => {
                let mut eq = EqBank::new(rate);
                eq.prepare_clean(rate, 8192);
                (Body::Eq(eq), &[][..], &[][..])
            }
        };
        let mut plugin = Self {
            body,
            params: [0.0; MAX_PARAMS],
            count: if code == PLUGIN_EQ { EQ_CONTROLS.len() } else { defaults.len() },
            keys,
            code: if matches!(code, PLUGIN_TUNE | PLUGIN_COMP | PLUGIN_VOCAL | PLUGIN_SAT | PLUGIN_REVERB | PLUGIN_DELAY | PLUGIN_MOD | PLUGIN_LIMIT | PLUGIN_SYNTH | PLUGIN_SCALER) { code } else { PLUGIN_EQ },
            sample_rate: rate,
            tempo: 120.0,
            eco: false,
            offline: false,
            scale_root: 0,
            intervals: [0, 2, 4, 5, 7, 9, 11, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
            interval_len: 7,
            cents: [0.0; 24],
            cent_len: 0,
            notes: [Note { offset: 0, pitch: 0.0, vel: 0.0 }; 32],
            note_len: 0,
            side_frames: 0,
            other: vec![0.0; 8192],
            prepared: true,
            latency: 0,
        };
        if plugin.code == PLUGIN_EQ {
            for (index, control) in EQ_CONTROLS.iter().enumerate() {
                plugin.params[index] = control.default_value;
            }
        } else {
            for (index, value) in defaults.iter().enumerate() {
                plugin.params[index] = *value;
            }
        }
        plugin
    }

    pub fn set_scale_len(&mut self, intervals: usize, cents: usize) {
        self.interval_len = intervals.min(self.intervals.len());
        self.cent_len = cents.min(self.cents.len());
    }

    pub fn set_interval(&mut self, index: usize, interval: i32) {
        if index < self.intervals.len() {
            self.intervals[index] = interval;
            self.interval_len = self.interval_len.max(index + 1);
        }
    }

    pub fn set_cents(&mut self, index: usize, cents: f64) {
        if index < self.cents.len() {
            self.cents[index] = cents;
            self.cent_len = self.cent_len.max(index + 1);
        }
    }

    pub fn note(&mut self, pitch: f64, vel: f64) {
        if let Body::Synth(synth) = &mut self.body {
            synth.note(pitch, vel);
        }
    }

    pub fn push_note(&mut self, offset: u32, pitch: f64, vel: f64) {
        if self.note_len >= self.notes.len() {
            return;
        }
        self.notes[self.note_len] = Note { offset, pitch, vel };
        self.note_len += 1;
    }

    pub fn process(&mut self, left: &mut [f32], right: &mut [f32], side: &[f32], frames: usize) {
        if !self.prepared || frames == 0 {
            return;
        }
        let frames = frames.min(left.len()).min(right.len());
        let sidechain = if self.side_frames > 0 { Some(side) } else { None };
        let params = &self.params[..self.count.max(1)];
        let rate = self.sample_rate;
        let eco = self.eco;
        let offline = self.offline;
        let tempo = self.tempo;
        let scale_root = self.scale_root;
        let interval_len = self.interval_len;
        let cent_len = self.cent_len;
        let note_len = self.note_len;
        let mut queued = [Note { offset: 0, pitch: 0.0, vel: 0.0 }; 32];
        queued[..note_len].copy_from_slice(&self.notes[..note_len]);
        self.latency = match &mut self.body {
            Body::Tune(tune) => {
                tune.process(left, right, frames, params, rate, offline, eco, scale_root, &self.intervals[..interval_len], &self.cents[..cent_len]);
                tune.latency
            }
            Body::Eq(eq) => eq.process(left, right, frames, params, rate, eco, offline),
            Body::Comp(comp) => {
                comp.process(left, right, frames, params, rate, eco, sidechain);
                0
            }
            Body::Vocal(vocal) => {
                vocal.process(left, right, frames, params, rate, sidechain);
                0
            }
            Body::Sat(sat) => {
                sat.process(left, right, frames, params, rate, eco, offline);
                sat.latency
            }
            Body::Reverb(space) => {
                space.process_reverb(left, right, frames, params, rate, eco);
                0
            }
            Body::Delay(space) => {
                space.process_delay(left, right, frames, params, rate, tempo);
                0
            }
            Body::Mod(modfx) => {
                modfx.process(left, right, frames, params, rate, eco);
                modfx.latency
            }
            Body::Limit(limit) => {
                limit.process(left, right, frames, params, rate, offline);
                limit.latency
            }
            Body::Synth(synth) => {
                synth.process(left, right, frames, rate, &queued[..note_len]);
                0
            }
            Body::Scaler => 0,
        };
        self.note_len = 0;
    }
}

impl NativePlugin for CuePlugin {
    fn prepare(&mut self, sample_rate: f64, _max_block_size: usize) {
        let rate = if sample_rate > 0.0 { sample_rate } else { 48_000.0 };
        if (rate - self.sample_rate).abs() > 0.1 {
            let code = self.code;
            let params = self.params;
            let count = self.count;
            *self = Self::new(code, rate);
            self.params = params;
            self.count = count;
        }
        self.sample_rate = rate;
        self.prepared = true;
    }
    fn release(&mut self) {
        self.prepared = false;
    }
    fn reset(&mut self) {
        match &mut self.body {
            Body::Tune(tune) => tune.reset(),
            Body::Eq(eq) => eq.reset(),
            Body::Comp(comp) => comp.reset(),
            Body::Vocal(vocal) => vocal.reset(),
            Body::Sat(sat) => sat.reset(),
            Body::Reverb(space) | Body::Delay(space) => space.reset(),
            Body::Mod(modfx) => modfx.reset(),
            Body::Limit(limit) => limit.reset(),
            Body::Synth(synth) => synth.reset(),
            Body::Scaler => {}
        }
        self.latency = 0;
    }
    fn process_block(&mut self, audio: &mut AudioBlock<'_>, midi: &MidiBlock<'_>) {
        let frames = audio.num_samples.min(audio.channels[0].len());
        for event in midi.events.iter().take(midi.num_events as usize) {
            let status = event.status & 0xf0;
            if status == 0x90 && event.data2 > 0 {
                self.push_note(event.sample_offset, event.data1 as f64, event.data2 as f64 / 127.0);
            } else if status == 0x80 || status == 0x90 {
                self.push_note(event.sample_offset, event.data1 as f64, 0.0);
            }
        }
        let channels = audio.num_channels;
        if channels > 1 {
            let (left, right) = audio.channels.split_at_mut(1);
            self.process(left[0], right[0], &[], frames);
        } else {
            let frames = frames.min(self.other.len());
            self.other[..frames].copy_from_slice(&audio.channels[0][..frames]);
            let other = &mut self.other;
            // Split the copy off the plugin before processing.
            let mut dry = [0.0f32; 8192];
            let n = frames.min(dry.len());
            dry[..n].copy_from_slice(&other[..n]);
            self.process(audio.channels[0], &mut dry[..n], &[], n);
        }
    }
    fn set_parameter(&mut self, param_id: u32, value: f64) {
        let index = param_id as usize;
        if index < self.count {
            self.params[index] = if value.is_finite() { value } else { 0.0 };
        }
    }
    fn get_parameter(&self, param_id: u32) -> f64 {
        self.params.get(param_id as usize).copied().unwrap_or(0.0)
    }
    fn num_parameters(&self) -> u32 {
        self.count as u32
    }
    fn latency_in_samples(&self) -> u32 {
        self.latency
    }
    fn get_state(&self) -> Vec<u8> {
        let mut buffer = [0u8; 16384];
        let length = if self.code == PLUGIN_EQ {
            write_controls(&mut buffer, EQ_CONTROLS, &self.params)
        } else {
            write_named(&mut buffer, self.keys, &self.params)
        };
        buffer[..length].to_vec()
    }
    fn set_state(&mut self, data: &[u8]) -> bool {
        if self.code == PLUGIN_EQ {
            read_controls(data, EQ_CONTROLS, &mut self.params)
        } else {
            read_named(data, self.keys, &mut self.params)
        }
    }
    fn layout(&self) -> &'static PluginLayout {
        &EQ_LAYOUT_FALLBACK
    }
}

const EQ_LAYOUT_FALLBACK: PluginLayout = PluginLayout {
    id: "cue",
    name: "CueHarbor",
    version: "2",
    controls: &[],
};

#[allow(dead_code)]
fn _layout_anchor(control: &ControlLayout) -> u32 {
    control.param_id
}
