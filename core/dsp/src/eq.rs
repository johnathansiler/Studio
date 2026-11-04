//! Five-band stereo EQ. Same bands, in the same order, as `src/audio/plugins/eq.ts`:
//! highpass, low shelf, peaking mid, high shelf, lowpass. Each channel has its own
//! filter memory. Coefficients update once per block from the smoothed parameters,
//! which is how the TypeScript processor is called.

use crate::biquad::{design_biquad, sanitize, tick, Biquad, BiquadKind};
use crate::contract::{AudioBlock, ControlLayout, MidiBlock, NativePlugin, PluginLayout};
use crate::smooth::ParamSmoother;
use crate::state::{read_state, write_state};

/// Live EQ manifest (`coreCatalog.ts`), in order. `kind` is the model switch.
/// This port sounds like the clean five-band processor in `eq.ts`. The other
/// model knobs are stored so ids and state match; `dispatch.ts` is not ported.
pub const CONTROLS: &[ControlLayout] = &[
    control(0, "kind", "Kind", 0.0, 7.0, 0.0, "", false),
    control(1, "hp", "HP", 20.0, 1000.0, 20.0, "Hz", true),
    control(2, "lp", "LP", 1000.0, 20000.0, 20000.0, "Hz", true),
    control(3, "lowF", "Low", 40.0, 800.0, 180.0, "Hz", true),
    control(4, "lowG", "Low", -18.0, 12.0, 0.0, "dB", true),
    control(5, "lowQ", "Q", 0.2, 8.0, 0.7, "", true),
    control(6, "midF", "Mid", 200.0, 8000.0, 1500.0, "Hz", true),
    control(7, "midG", "Mid", -18.0, 12.0, 0.0, "dB", true),
    control(8, "midQ", "Q", 0.2, 8.0, 1.0, "", true),
    control(9, "highF", "High", 1000.0, 16000.0, 8000.0, "Hz", true),
    control(10, "highG", "High", -18.0, 12.0, 0.0, "dB", true),
    control(11, "highQ", "Q", 0.2, 8.0, 0.7, "", true),
    control(12, "phase", "Phase", 0.0, 1.0, 1.0, "", true),
    control(13, "pLow", "Low", 0.0, 3.0, 2.0, "", true),
    control(14, "pBoost", "Boost", 0.0, 1.0, 0.0, "", true),
    control(15, "pAtten", "Atten", 0.0, 1.0, 0.0, "", true),
    control(16, "pHigh", "High", 0.0, 6.0, 4.0, "", true),
    control(17, "pAir", "Air", 0.0, 1.0, 0.0, "", true),
    control(18, "pWidth", "Width", 0.0, 1.0, 0.5, "", true),
    control(19, "pCut", "Cut", 0.0, 1.0, 0.0, "", true),
    control(20, "pCutF", "Cut freq", 0.0, 2.0, 1.0, "", true),
    control(21, "preHp", "HP", 0.0, 4.0, 0.0, "", true),
    control(22, "preLow", "Low", 0.0, 3.0, 2.0, "", true),
    control(23, "preLowG", "Low", -16.0, 16.0, 0.0, "dB", true),
    control(24, "preMid", "Mid", 0.0, 5.0, 2.0, "", true),
    control(25, "preMidG", "Mid", -18.0, 18.0, 0.0, "dB", true),
    control(26, "preHigh", "High", 0.0, 1.0, 0.0, "", true),
    control(27, "preHighG", "High", -16.0, 16.0, 0.0, "dB", true),
    control(28, "preDrive", "Drive", 0.0, 1.0, 0.0, "", true),
    control(29, "curve", "Curve", 0.0, 1.0, 0.0, "", true),
    control(30, "lfF", "LF", 0.0, 3.0, 1.0, "", true),
    control(31, "lfG", "LF", -15.0, 15.0, 0.0, "dB", true),
    control(32, "lmfF", "LMF", 0.0, 3.0, 1.0, "", true),
    control(33, "lmfG", "LMF", -15.0, 15.0, 0.0, "dB", true),
    control(34, "hmfF", "HMF", 0.0, 3.0, 2.0, "", true),
    control(35, "hmfG", "HMF", -15.0, 15.0, 0.0, "dB", true),
    control(36, "hfF", "HF", 0.0, 3.0, 2.0, "", true),
    control(37, "hfG", "HF", -15.0, 15.0, 0.0, "dB", true),
    control(38, "tiltF", "Freq", 0.0, 10.0, 5.0, "", true),
    control(39, "tiltG", "Gain", -12.0, 12.0, 0.0, "dB", true),
    control(40, "f0", "Low", 40.0, 500.0, 120.0, "Hz", true),
    control(41, "g0", "Low", -18.0, 18.0, 0.0, "dB", true),
    control(42, "q0", "Q", 0.2, 12.0, 0.7, "", true),
    control(43, "f1", "Mid", 200.0, 8000.0, 1500.0, "Hz", true),
    control(44, "g1", "Mid", -18.0, 18.0, 0.0, "dB", true),
    control(45, "q1", "Q", 0.2, 12.0, 1.0, "", true),
    control(46, "f2", "High", 1000.0, 16000.0, 8000.0, "Hz", true),
    control(47, "g2", "High", -18.0, 18.0, 0.0, "dB", true),
    control(48, "q2", "Q", 0.2, 12.0, 0.7, "", true),
    control(49, "dynamic", "Dynamic", 0.0, 1.0, 0.0, "", true),
    control(50, "focusThresh", "Thresh", -48.0, 0.0, -18.0, "dB", true),
    control(51, "linear", "Linear", 0.0, 1.0, 0.0, "", true),
    control(52, "dynF", "Freq", 80.0, 12000.0, 3000.0, "Hz", true),
    control(53, "dynQ", "Q", 0.4, 6.0, 1.2, "", true),
    control(54, "dynThresh", "Thresh", -48.0, 0.0, -24.0, "dB", true),
    control(55, "dynG", "Gain", -12.0, 12.0, 0.0, "dB", true),
    control(56, "dynA", "Attack", 1.0, 40.0, 10.0, "ms", true),
    control(57, "dynR", "Release", 10.0, 300.0, 80.0, "ms", true),
];

pub const EQ_PARAMS: usize = CONTROLS.len();

const STATE_CAP: usize = 16384;

const HP: usize = 1;
const LP: usize = 2;
const LOW_F: usize = 3;
const LOW_G: usize = 4;
const LOW_Q: usize = 5;
const MID_F: usize = 6;
const MID_G: usize = 7;
const MID_Q: usize = 8;
const HIGH_F: usize = 9;
const HIGH_G: usize = 10;
const HIGH_Q: usize = 11;

const LAYOUT: PluginLayout = PluginLayout {
    id: "eq",
    name: "EQ",
    version: "2",
    controls: CONTROLS,
};

const fn control(
    param_id: u32,
    key: &'static str,
    name: &'static str,
    min: f64,
    max: f64,
    default_value: f64,
    unit: &'static str,
    automatable: bool,
) -> ControlLayout {
    ControlLayout {
        param_id,
        key,
        name,
        min,
        max,
        default_value,
        unit,
        automatable,
    }
}

pub struct EqProcessor {
    sample_rate: f64,
    prepared: bool,
    has_design: bool,
    smoother: ParamSmoother,
    /// Values last written into the coefficient banks.
    used: [f64; EQ_PARAMS],
    filters: [Biquad; 10],
}

impl Default for EqProcessor {
    fn default() -> Self {
        Self::new()
    }
}

impl EqProcessor {
    pub fn new() -> Self {
        let mut eq = Self {
            sample_rate: 48_000.0,
            prepared: false,
            has_design: false,
            smoother: ParamSmoother::new(),
            used: [0.0; EQ_PARAMS],
            filters: [Biquad::default(); 10],
        };
        eq.smoother.prepare(EQ_PARAMS, eq.sample_rate);
        for (index, control) in CONTROLS.iter().enumerate() {
            eq.smoother.snap(index, control.default_value);
            eq.used[index] = control.default_value;
        }
        eq
    }

    pub fn is_prepared(&self) -> bool {
        self.prepared
    }

    /// Use these values for the next block. The live chain already smoothed them.
    pub fn snap_parameters(&mut self, values: &[f64]) {
        for (index, value) in values.iter().enumerate().take(EQ_PARAMS) {
            self.smoother.snap(index, *value);
        }
    }

    fn snap_targets(&mut self) {
        for index in 0..EQ_PARAMS {
            self.smoother.snap(index, self.smoother.target(index));
        }
        self.has_design = false;
    }

    fn clear_filters(&mut self) {
        for filter in &mut self.filters {
            filter.clear_state();
        }
    }

    fn design(&mut self) {
        let rate = self.sample_rate;
        let hp = self.smoother.current(HP);
        let lp = self.smoother.current(LP);
        let low_f = self.smoother.current(LOW_F);
        let low_g = self.smoother.current(LOW_G);
        let low_q = self.smoother.current(LOW_Q);
        let mid_f = self.smoother.current(MID_F);
        let mid_g = self.smoother.current(MID_G);
        let mid_q = self.smoother.current(MID_Q);
        let high_f = self.smoother.current(HIGH_F);
        let high_g = self.smoother.current(HIGH_G);
        let high_q = self.smoother.current(HIGH_Q);
        let next = [
            design_biquad(BiquadKind::Highpass, rate, hp, 0.7, 0.0),
            design_biquad(BiquadKind::Lowshelf, rate, low_f, low_q, low_g),
            design_biquad(BiquadKind::Peaking, rate, mid_f, mid_q, mid_g),
            design_biquad(BiquadKind::Highshelf, rate, high_f, high_q, high_g),
            design_biquad(BiquadKind::Lowpass, rate, lp, 0.7, 0.0),
        ];
        for (index, filter) in next.iter().enumerate() {
            self.filters[index].copy_coeffs(filter);
            self.filters[index + 5].copy_coeffs(filter);
        }
        for index in 0..EQ_PARAMS {
            self.used[index] = self.smoother.current(index);
        }
        self.has_design = true;
    }

    fn smooth_block(&mut self, frames: usize) -> bool {
        let mut changed = !self.has_design;
        for index in 0..EQ_PARAMS {
            let next = if CONTROLS[index].automatable {
                self.smoother.next_block(index, frames)
            } else {
                let target = self.smoother.target(index);
                self.smoother.snap(index, target);
                target
            };
            if !self.has_design || next != self.used[index] {
                changed = true;
            }
        }
        changed
    }

    fn render(&mut self, samples: &mut [f32], bank: usize, frames: usize) {
        for index in 0..frames {
            let mut sample = samples[index] as f64;
            for band in 0..5 {
                sample = tick(&mut self.filters[bank + band], sample);
            }
            samples[index] = sanitize(sample) as f32;
        }
    }
}

impl NativePlugin for EqProcessor {
    fn prepare(&mut self, sample_rate: f64, _max_block_size: usize) {
        self.sample_rate = if sample_rate > 0.0 {
            sample_rate
        } else {
            48_000.0
        };
        self.smoother.prepare(EQ_PARAMS, self.sample_rate);
        self.snap_targets();
        self.clear_filters();
        self.prepared = true;
    }

    fn release(&mut self) {
        self.prepared = false;
    }

    fn reset(&mut self) {
        self.clear_filters();
        self.snap_targets();
    }

    fn process_block(&mut self, audio: &mut AudioBlock<'_>, _midi: &MidiBlock<'_>) {
        if !self.prepared || audio.num_channels == 0 {
            return;
        }
        let mut frames = audio.num_samples.min(audio.channels[0].len());
        if audio.num_channels > 1 {
            frames = frames.min(audio.channels[1].len());
        }
        if frames == 0 {
            return;
        }
        if self.smooth_block(frames) {
            self.design();
        }
        let channels = audio.num_channels.min(2);
        self.render(audio.channels[0], 0, frames);
        if channels > 1 {
            self.render(audio.channels[1], 5, frames);
        }
    }

    fn set_parameter(&mut self, param_id: u32, value: f64) {
        self.smoother.set_target(param_id as usize, value);
    }

    fn get_parameter(&self, param_id: u32) -> f64 {
        self.smoother.target(param_id as usize)
    }

    fn num_parameters(&self) -> u32 {
        EQ_PARAMS as u32
    }

    fn latency_in_samples(&self) -> u32 {
        0
    }

    fn get_state(&self) -> Vec<u8> {
        let mut values = [0.0; EQ_PARAMS];
        for index in 0..EQ_PARAMS {
            values[index] = self.smoother.target(index);
        }
        let mut buffer = [0u8; STATE_CAP];
        let length = write_state(&mut buffer, &values);
        buffer[..length].to_vec()
    }

    fn set_state(&mut self, data: &[u8]) -> bool {
        let mut values = [0.0; EQ_PARAMS];
        for index in 0..EQ_PARAMS {
            values[index] = self.smoother.target(index);
        }
        if !read_state(data, &mut values) {
            return false;
        }
        for index in 0..EQ_PARAMS {
            self.smoother.snap(index, values[index]);
        }
        self.has_design = false;
        true
    }

    fn layout(&self) -> &'static PluginLayout {
        &LAYOUT
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::contract::{NativePlugin, EMPTY_MIDI};

    fn sine(frames: usize, freq: f64, amp: f32, rate: f64) -> Vec<f32> {
        (0..frames)
            .map(|index| {
                (2.0 * std::f64::consts::PI * freq * index as f64 / rate).sin() as f32 * amp
            })
            .collect()
    }

    fn rms(samples: &[f32]) -> f64 {
        if samples.is_empty() {
            return 0.0;
        }
        let sum: f64 = samples
            .iter()
            .map(|sample| (*sample as f64) * (*sample as f64))
            .sum();
        (sum / samples.len() as f64).sqrt()
    }

    #[test]
    fn silence_stays_silent_and_latency_is_zero() {
        let mut eq = EqProcessor::new();
        eq.prepare(48_000.0, 128);
        assert_eq!(eq.latency_in_samples(), 0);
        let mut left = vec![0f32; 256];
        let mut right = vec![0f32; 256];
        let mut audio = AudioBlock {
            channels: [&mut left, &mut right],
            num_channels: 2,
            num_samples: 256,
        };
        eq.process_block(&mut audio, &EMPTY_MIDI);
        assert!(left.iter().all(|sample| *sample == 0.0));
        assert!(right.iter().all(|sample| *sample == 0.0));
    }

    #[test]
    fn mid_boost_raises_a_tone_at_the_center() {
        let mut flat = EqProcessor::new();
        let mut boosted = EqProcessor::new();
        flat.prepare(48_000.0, 512);
        boosted.prepare(48_000.0, 512);
        boosted.set_parameter(MID_G as u32, 6.0);
        boosted.set_state(&boosted.get_state());
        let input = sine(2400, 1500.0, 0.2, 48_000.0);
        let mut flat_l = input.clone();
        let mut flat_r = input.clone();
        let mut boost_l = input.clone();
        let mut boost_r = input.clone();
        let mut flat_audio = AudioBlock {
            channels: [&mut flat_l, &mut flat_r],
            num_channels: 2,
            num_samples: input.len(),
        };
        let mut boost_audio = AudioBlock {
            channels: [&mut boost_l, &mut boost_r],
            num_channels: 2,
            num_samples: input.len(),
        };
        flat.process_block(&mut flat_audio, &EMPTY_MIDI);
        boosted.process_block(&mut boost_audio, &EMPTY_MIDI);
        assert!(rms(&boost_l) > rms(&flat_l) * 1.4);
    }

    #[test]
    fn midi_does_not_change_the_eq() {
        let mut with_midi = EqProcessor::new();
        let mut plain = EqProcessor::new();
        with_midi.prepare(48_000.0, 64);
        plain.prepare(48_000.0, 64);
        let input = sine(64, 440.0, 0.3, 48_000.0);
        let mut left_a = input.clone();
        let mut right_a = input.clone();
        let mut left_b = input.clone();
        let mut right_b = input.clone();
        let event = [crate::MidiEvent {
            sample_offset: 4,
            status: 0x90,
            data1: 60,
            data2: 100,
        }];
        let midi = MidiBlock {
            events: &event,
            num_events: 1,
        };
        let mut audio_a = AudioBlock {
            channels: [&mut left_a, &mut right_a],
            num_channels: 2,
            num_samples: 64,
        };
        let mut audio_b = AudioBlock {
            channels: [&mut left_b, &mut right_b],
            num_channels: 2,
            num_samples: 64,
        };
        with_midi.process_block(&mut audio_a, &midi);
        plain.process_block(&mut audio_b, &EMPTY_MIDI);
        assert_eq!(left_a, left_b);
    }

    #[test]
    fn state_round_trip_and_rejects_the_wrong_version() {
        let mut eq = EqProcessor::new();
        eq.set_parameter(HP as u32, 90.0);
        eq.set_parameter(MID_G as u32, 2.5);
        let bytes = eq.get_state();
        let text = std::str::from_utf8(&bytes).unwrap();
        assert!(text.contains("\"v\":1"));
        assert!(text.contains("\"hp\":90"));
        eq.set_parameter(HP as u32, 20.0);
        eq.set_parameter(MID_G as u32, 0.0);
        assert!(eq.set_state(&bytes));
        assert_eq!(eq.get_parameter(HP as u32), 90.0);
        assert_eq!(eq.get_parameter(MID_G as u32), 2.5);
        assert!(!eq.set_state(br#"{"v":2,"params":{"hp":400}}"#));
        assert_eq!(eq.get_parameter(HP as u32), 90.0);
        assert!(eq.set_state(br#"{"v":1,"params":{"lowG":-1.5}}"#));
        assert_eq!(eq.get_parameter(LOW_G as u32), -1.5);
        assert_eq!(eq.get_parameter(HP as u32), 90.0);
    }

    #[test]
    fn layout_json_lists_every_control() {
        let mut buffer = [0u8; 16384];
        let length = crate::state::write_layout(&mut buffer);
        assert!(length > 0, "layout json did not fit");
        let text = std::str::from_utf8(&buffer[..length]).unwrap();
        assert!(text.starts_with("{\"id\":\"eq\""));
        for control in CONTROLS {
            assert!(text.contains(&format!("\"key\":\"{}\"", control.key)));
        }
    }

    #[test]
    fn unprepared_process_leaves_the_buffer_alone() {
        let mut eq = EqProcessor::new();
        let mut left = vec![0.25f32; 8];
        let mut right = vec![-0.25f32; 8];
        let mut audio = AudioBlock {
            channels: [&mut left, &mut right],
            num_channels: 2,
            num_samples: 8,
        };
        eq.process_block(&mut audio, &EMPTY_MIDI);
        assert_eq!(left[0], 0.25);
        assert_eq!(right[0], -0.25);
    }
}
