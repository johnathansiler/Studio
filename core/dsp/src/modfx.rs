//! Modulation inserts: chorus, double, ensemble, phase, rotor, and pitch shift.

use crate::psola::Psola;
use crate::smooth::SampleGlide;
use crate::tune::tune_latency;
use crate::util::{clamp, js_or, js_round, param, read_at, read_frac, store};

pub struct ModBank {
    chorus: Vec<f32>,
    chorus_write: usize,
    chorus_phase: f64,
    double: [Vec<f32>; 2],
    double_write: usize,
    double_phase: f64,
    ensemble: [Vec<f32>; 2],
    ensemble_write: usize,
    ensemble_phase: f64,
    phase: [(f64, f64); 8],
    phase_lfo: f64,
    phase_fb: f64,
    rotor_horn: Vec<f32>,
    rotor_drum: Vec<f32>,
    rotor_write: usize,
    horn_phase: f64,
    drum_phase: f64,
    lead: Psola,
    harm: Psola,
    scratch_l: Vec<f32>,
    scratch_r: Vec<f32>,
    dry_l: Vec<f32>,
    dry_r: Vec<f32>,
    mix: SampleGlide,
    pub latency: u32,
    rate: f64,
}

impl ModBank {
    pub fn new(sample_rate: f64) -> Self {
        Self {
            chorus: vec![0.0; (sample_rate * 0.04).ceil().max(8.0) as usize],
            chorus_write: 0,
            chorus_phase: 0.0,
            double: [line(0.05, sample_rate), line(0.05, sample_rate)],
            double_write: 0,
            double_phase: 0.0,
            ensemble: [line(0.05, sample_rate), line(0.05, sample_rate)],
            ensemble_write: 0,
            ensemble_phase: 0.0,
            phase: [(0.0, 0.0); 8],
            phase_lfo: 0.0,
            phase_fb: 0.0,
            rotor_horn: line(0.03, sample_rate),
            rotor_drum: line(0.04, sample_rate),
            rotor_write: 0,
            horn_phase: 0.0,
            drum_phase: 0.0,
            lead: Psola::new(sample_rate, 0),
            harm: Psola::new(sample_rate, 0),
            scratch_l: vec![0.0; 8192],
            scratch_r: vec![0.0; 8192],
            dry_l: vec![0.0; 8192],
            dry_r: vec![0.0; 8192],
            mix: SampleGlide::default(),
            latency: 0,
            rate: sample_rate,
        }
    }
    pub fn reset(&mut self) {
        self.chorus.fill(0.0);
        self.chorus_write = 0;
        self.chorus_phase = 0.0;
        self.double[0].fill(0.0);
        self.double[1].fill(0.0);
        self.double_write = 0;
        self.double_phase = 0.0;
        self.ensemble[0].fill(0.0);
        self.ensemble[1].fill(0.0);
        self.ensemble_write = 0;
        self.ensemble_phase = 0.0;
        self.phase = [(0.0, 0.0); 8];
        self.phase_lfo = 0.0;
        self.phase_fb = 0.0;
        self.rotor_horn.fill(0.0);
        self.rotor_drum.fill(0.0);
        self.rotor_write = 0;
        self.horn_phase = 0.0;
        self.drum_phase = 0.0;
        self.lead.reset();
        self.harm.reset();
        self.mix.reset();
        self.latency = 0;
    }

    pub fn process(&mut self, left: &mut [f32], right: &mut [f32], frames: usize, values: &[f64], sample_rate: f64, eco: bool) {
        let kind = js_round(param(values, 0, 0.0)).clamp(0.0, 5.0) as i32;
        self.latency = 0;
        match kind {
            1 => self.double(left, right, frames, values, sample_rate),
            2 => self.ensemble(left, right, frames, values, sample_rate),
            3 => self.phaser(left, right, frames, values, sample_rate, eco),
            4 => self.rotor(left, right, frames, values, sample_rate),
            5 => self.shift(left, right, frames, values, sample_rate, eco),
            _ => self.chorus(left, right, frames, values, sample_rate),
        }
    }

    fn chorus(&mut self, left: &mut [f32], right: &mut [f32], frames: usize, values: &[f64], sample_rate: f64) {
        let mix = clamp(param(values, 3, 0.0), 0.0, 1.0);
        let rate = clamp(param(values, 1, 0.4), 0.05, 5.0);
        let depth = clamp(param(values, 2, 0.4), 0.0, 1.0) * sample_rate * 0.008;
        let base = sample_rate * 0.012;
        let length = self.chorus.len();
        for i in 0..frames {
            let dry_l = left[i] as f64;
            let dry_r = right[i] as f64;
            self.chorus[self.chorus_write] = ((dry_l + dry_r) * 0.5) as f32;
            self.chorus_phase += (rate * std::f64::consts::PI * 2.0) / sample_rate;
            let wet_l = read_at(&self.chorus, self.chorus_write, base + (0.5 + 0.5 * self.chorus_phase.sin()) * depth);
            let wet_r = read_at(&self.chorus, self.chorus_write, base + (0.5 + 0.5 * (self.chorus_phase + 2.0).sin()) * depth);
            left[i] = store(dry_l * (1.0 - mix) + wet_l * mix);
            right[i] = store(dry_r * (1.0 - mix) + wet_r * mix);
            self.chorus_write = (self.chorus_write + 1) % length;
        }
    }

    fn double(&mut self, left: &mut [f32], right: &mut [f32], frames: usize, values: &[f64], sample_rate: f64) {
        let mix = clamp(param(values, 3, 0.0), 0.0, 1.0);
        let width = clamp(param(values, 4, 0.5), 0.0, 1.0);
        let length = self.double[0].len();
        let base = clamp((param(values, 5, 18.0) / 1000.0) * sample_rate, 1.0, length as f64 - 2.0);
        let depth = clamp(param(values, 2, 0.3), 0.0, 1.0) * sample_rate * 0.003;
        for i in 0..frames {
            let dry_l = left[i] as f64;
            let dry_r = right[i] as f64;
            self.double[0][self.double_write] = dry_l as f32;
            self.double[1][self.double_write] = dry_r as f32;
            self.double_phase += (0.35 * std::f64::consts::PI * 2.0) / sample_rate;
            let tap_l = read_at(&self.double[0], self.double_write, base + self.double_phase.sin() * depth);
            let tap_r = read_at(&self.double[1], self.double_write, base * 1.3 + self.double_phase.cos() * depth);
            let mid = (dry_l + dry_r) * 0.5;
            let side = (dry_l - dry_r) * 0.5 * (1.0 + width);
            left[i] = store(dry_l * (1.0 - mix) + ((mid + side) * 0.7 + tap_r * 0.5) * mix);
            right[i] = store(dry_r * (1.0 - mix) + ((mid - side) * 0.7 + tap_l * 0.5) * mix);
            self.double_write = (self.double_write + 1) % length;
        }
    }

    fn ensemble(&mut self, left: &mut [f32], right: &mut [f32], frames: usize, values: &[f64], sample_rate: f64) {
        let rate = clamp(param(values, 1, 0.4), 0.05, 4.0);
        let depth = clamp(param(values, 2, 0.4), 0.0, 1.0);
        let wide = param(values, 6, 0.0) >= 0.5;
        let amount = clamp(param(values, 3, 0.4), 0.0, 1.0);
        let length = self.ensemble[0].len();
        for i in 0..frames {
            self.ensemble_phase += (2.0 * std::f64::consts::PI * rate) / sample_rate;
            let dry_l = left[i] as f64;
            let dry_r = right[i] as f64;
            self.ensemble[0][self.ensemble_write] = dry_l as f32;
            self.ensemble[1][self.ensemble_write] = dry_r as f32;
            let a = read_frac(&self.ensemble[0], self.ensemble_write as f64 - (220.0 + self.ensemble_phase.sin() * depth * 80.0));
            let b = read_frac(&self.ensemble[1], self.ensemble_write as f64 - (280.0 + (self.ensemble_phase + 2.1).sin() * depth * 90.0));
            let side = if wide { (a - b) * 0.8 } else { 0.0 };
            left[i] = store(dry_l * (1.0 - amount) + (a + side) * amount);
            right[i] = store(dry_r * (1.0 - amount) + (b - side) * amount);
            self.ensemble_write = (self.ensemble_write + 1) % length;
        }
    }

    fn phaser(&mut self, left: &mut [f32], right: &mut [f32], frames: usize, values: &[f64], sample_rate: f64, eco: bool) {
        let rate = clamp(param(values, 1, 0.3), 0.02, 4.0);
        let depth = clamp(param(values, 2, 0.6), 0.0, 1.0);
        let feedback = clamp(param(values, 7, 0.4), 0.0, 0.9);
        let amount = clamp(param(values, 3, 0.5), 0.0, 1.0);
        let count = if eco { 4 } else { 6 };
        let mut fb = 0.0;
        for i in 0..frames {
            self.phase_lfo += (2.0 * std::f64::consts::PI * rate) / sample_rate;
            let lfo = 0.5 + 0.5 * self.phase_lfo.sin();
            let a = 0.2 + lfo * depth * 0.75;
            let dry_l = left[i] as f64;
            let dry_r = right[i] as f64;
            let mut wet = dry_l + fb * feedback;
            for stage in 0..count {
                wet = allpass(wet, a, &mut self.phase[stage]);
            }
            fb = wet;
            left[i] = store(dry_l * (1.0 - amount) + wet * amount);
            right[i] = store(dry_r * (1.0 - amount) + wet * amount);
        }
    }

    fn rotor(&mut self, left: &mut [f32], right: &mut [f32], frames: usize, values: &[f64], sample_rate: f64) {
        let fast = param(values, 8, 0.0) >= 0.5;
        let horn_rate = if fast { 6.2 } else { 0.8 };
        let drum_rate = if fast { 5.4 } else { 0.7 };
        let amount = clamp(param(values, 3, 0.7), 0.0, 1.0);
        for i in 0..frames {
            self.horn_phase += (2.0 * std::f64::consts::PI * horn_rate) / sample_rate;
            self.drum_phase += (2.0 * std::f64::consts::PI * drum_rate) / sample_rate;
            let dry_l = left[i] as f64;
            let dry_r = right[i] as f64;
            let mono = (dry_l + dry_r) * 0.5;
            let horn_len = self.rotor_horn.len();
            let drum_len = self.rotor_drum.len();
            self.rotor_horn[self.rotor_write % horn_len] = mono as f32;
            self.rotor_drum[self.rotor_write % drum_len] = mono as f32;
            let horn_tap = read_frac(&self.rotor_horn, self.rotor_write as f64 - (180.0 + self.horn_phase.sin() * 40.0));
            let drum_tap = read_frac(&self.rotor_drum, self.rotor_write as f64 - (240.0 + self.drum_phase.sin() * 20.0));
            let horn_amp = 0.6 + 0.4 * self.horn_phase.sin();
            let drum_amp = 0.75 + 0.25 * self.drum_phase.sin();
            let wet_l = horn_tap * horn_amp + drum_tap * drum_amp;
            let wet_r = horn_tap * (1.2 - horn_amp) + drum_tap * (1.1 - drum_amp * 0.5);
            left[i] = store(dry_l * (1.0 - amount) + wet_l * amount);
            right[i] = store(dry_r * (1.0 - amount) + wet_r * amount);
            self.rotor_write += 1;
        }
    }

    fn shift(&mut self, left: &mut [f32], right: &mut [f32], frames: usize, values: &[f64], sample_rate: f64, eco: bool) {
        self.mix.prepare(sample_rate);
        let mix_target = clamp(param(values, 3, 0.0), 0.0, 1.0);
        if mix_target <= 0.001 && (!self.mix.settled() || self.mix.peek() <= 0.001) {
            self.latency = 0;
            for i in 0..frames {
                left[i] = store(left[i] as f64);
                right[i] = store(right[i] as f64);
            }
            return;
        }
        self.latency = tune_latency(sample_rate);
        let frames = frames.min(self.scratch_l.len());
        let semis = param(values, 9, 0.0);
        let harmony = js_or(param(values, 10, 7.0), 7.0);
        let harmony_mix = clamp(param(values, 11, 0.0), 0.0, 1.0);
        let hop = if eco { 256.0 } else { 128.0 };
        self.dry_l[..frames].copy_from_slice(&left[..frames]);
        self.dry_r[..frames].copy_from_slice(&right[..frames]);
        self.lead.process(left, right, frames, |frame| shift_hz(frame.hz, frame.confidence, semis), sample_rate, 50.0, 1600.0, hop, 0.0);
        if harmony_mix > 0.001 {
            self.scratch_l[..frames].copy_from_slice(&self.dry_l[..frames]);
            self.scratch_r[..frames].copy_from_slice(&self.dry_r[..frames]);
            self.harm.process(&mut self.scratch_l, &mut self.scratch_r, frames, |frame| shift_hz(frame.hz, frame.confidence, harmony), sample_rate, 50.0, 1600.0, hop, 0.0);
        }
        for i in 0..frames {
            let mix = self.mix.next(mix_target);
            let dry_l = self.dry_l[i] as f64;
            let dry_r = self.dry_r[i] as f64;
            let shifted_l = left[i] as f64;
            let shifted_r = right[i] as f64;
            let (wet_l, wet_r) = if harmony_mix > 0.001 {
                (shifted_l * (1.0 - harmony_mix) + self.scratch_l[i] as f64 * harmony_mix, shifted_r * (1.0 - harmony_mix) + self.scratch_r[i] as f64 * harmony_mix)
            } else {
                (shifted_l, shifted_r)
            };
            left[i] = store(dry_l * (1.0 - mix) + wet_l * mix);
            right[i] = store(dry_r * (1.0 - mix) + wet_r * mix);
        }
    }
}

fn shift_hz(hz: f64, confidence: f64, semis: f64) -> f64 {
    if hz <= 0.0 || confidence < 0.65 {
        return 0.0;
    }
    clamp(hz * 2f64.powf(semis / 12.0), 40.0, 2000.0)
}

fn allpass(x: f64, a: f64, state: &mut (f64, f64)) -> f64 {
    let y = -a * x + state.0 + a * state.1;
    state.0 = x;
    state.1 = y;
    y
}

fn line(seconds: f64, sample_rate: f64) -> Vec<f32> {
    vec![0.0; (seconds * sample_rate).ceil().max(8.0) as usize]
}
