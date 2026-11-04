//! Saturator kinds: soft clip, tape, sum, oxide, clip, and amp.

use crate::amp::Amp;
use crate::biquad::{design_biquad, tick, Biquad, BiquadKind};
use crate::resample::Oversampler;
use crate::shaper::{shaper_latency_samples, AnalogShaper, SoftShaper};
use crate::smooth::SampleGlide;
use crate::util::{clamp, js_round, param, read_frac, store};

pub struct SatBank {
    tone: Biquad,
    tone_freq: f64,
    soft: [SoftShaper; 2],
    drive: SampleGlide,
    mix: SampleGlide,
    tape_shapers: [AnalogShaper; 2],
    bump: [Biquad; 2],
    hiss: [Biquad; 2],
    delay: [Vec<f32>; 2],
    write: usize,
    phase: f64,
    seed: i64,
    bump_key: (i32, i64),
    bump_ready: bool,
    sum_shapers: [AnalogShaper; 2],
    oxide_eco: Oversampler,
    oxide_full: Oversampler,
    oxide_full_on: bool,
    clip_eco: Oversampler,
    clip_full: Oversampler,
    clip_full_on: bool,
    amp: Amp,
    scratch_l: Vec<f32>,
    scratch_r: Vec<f32>,
    pub latency: u32,
}

impl SatBank {
    pub fn new(sample_rate: f64) -> Self {
        Self {
            tone: design_biquad(BiquadKind::Lowpass, sample_rate, 8000.0, 0.7, 0.0),
            tone_freq: f64::NAN,
            soft: [SoftShaper::new(), SoftShaper::new()],
            drive: SampleGlide::default(),
            mix: SampleGlide::default(),
            tape_shapers: [AnalogShaper::new(4), AnalogShaper::new(4)],
            bump: [
                design_biquad(BiquadKind::Peaking, sample_rate, 55.0, 0.8, 0.0),
                design_biquad(BiquadKind::Peaking, sample_rate, 55.0, 0.8, 0.0),
            ],
            hiss: [
                design_biquad(BiquadKind::Highpass, sample_rate, 2000.0, 0.7, 0.0),
                design_biquad(BiquadKind::Lowpass, sample_rate, 8000.0, 0.7, 0.0),
            ],
            delay: [vec![0.0; 256], vec![0.0; 256]],
            write: 0,
            phase: 0.0,
            seed: 19,
            bump_key: (0, 0),
            bump_ready: false,
            sum_shapers: [AnalogShaper::new(4), AnalogShaper::new(4)],
            oxide_eco: Oversampler::new(2, 32),
            oxide_full: Oversampler::new(4, 48),
            oxide_full_on: false,
            clip_eco: Oversampler::new(2, 32),
            clip_full: Oversampler::new(4, 48),
            clip_full_on: false,
            amp: Amp::new(sample_rate),
            scratch_l: vec![0.0; 8192],
            scratch_r: vec![0.0; 8192],
            latency: 0,
        }
    }

    pub fn reset(&mut self) {
        self.tone.clear_state();
        self.soft[0].reset();
        self.soft[1].reset();
        self.drive.reset();
        self.mix.reset();
        self.delay[0].fill(0.0);
        self.delay[1].fill(0.0);
        self.write = 0;
        self.phase = 0.0;
        self.seed = 19;
        self.bump_ready = false;
        for filter in self.bump.iter_mut().chain(self.hiss.iter_mut()) {
            filter.clear_state();
        }
        self.tape_shapers[0].force_factor(4);
        self.tape_shapers[1].force_factor(4);
        self.sum_shapers[0].force_factor(4);
        self.sum_shapers[1].force_factor(4);
        self.oxide_eco.reset();
        self.oxide_full.reset();
        self.clip_eco.reset();
        self.clip_full.reset();
        self.oxide_full_on = false;
        self.clip_full_on = false;
        self.amp.reset();
        self.latency = 0;
    }

    pub fn process(&mut self, left: &mut [f32], right: &mut [f32], frames: usize, values: &[f64], sample_rate: f64, eco: bool, offline: bool) {
        let kind = js_round(param(values, 0, 0.0)).clamp(0.0, 5.0) as i32;
        self.latency = 0;
        match kind {
            1 => self.tape(left, right, frames, values, sample_rate, eco),
            2 => self.sum(left, right, frames, values, sample_rate, eco),
            3 => self.oxide(left, right, frames, values, offline),
            4 => self.clip(left, right, frames, values, offline),
            5 => self.amp.process(left, right, frames, values, sample_rate, eco),
            _ => self.soft(left, right, frames, values, sample_rate),
        }
    }

    fn soft(&mut self, left: &mut [f32], right: &mut [f32], frames: usize, values: &[f64], sample_rate: f64) {
        let freq = param(values, 2, 8000.0);
        if freq != self.tone_freq {
            let next = design_biquad(BiquadKind::Lowpass, sample_rate, freq, 0.7, 0.0);
            self.tone.copy_coeffs(&next);
            self.tone_freq = freq;
        }
        let drive_target = clamp(param(values, 1, 0.0), 0.0, 1.0);
        let mix_target = clamp(param(values, 3, 1.0), 0.0, 1.0);
        self.drive.prepare(sample_rate);
        self.mix.prepare(sample_rate);
        let neutral = drive_target <= 0.0001 && (!self.drive.settled() || self.drive.peek() <= 0.0001);
        self.latency = if drive_target <= 0.0001 { 0 } else { shaper_latency_samples() };
        for i in 0..frames {
            let drive = self.drive.next(drive_target);
            let mix = self.mix.next(mix_target);
            let shape = 1.0 + drive * 8.0;
            for channel in 0..2 {
                let buffer = if channel == 0 { &mut *left } else { &mut *right };
                let dry = buffer[i] as f64;
                let bent = if neutral { dry } else { self.soft[channel].shape(dry, drive, shape) };
                let filtered = if neutral { dry } else { tick(&mut self.tone, bent) };
                buffer[i] = store(dry * (1.0 - mix) + filtered * mix);
            }
        }
    }

    fn tape(&mut self, left: &mut [f32], right: &mut [f32], frames: usize, values: &[f64], sample_rate: f64, eco: bool) {
        let factor = if eco { 2 } else { 4 };
        if self.tape_shapers[0].factor != factor {
            self.tape_shapers[0].force_factor(factor);
            self.tape_shapers[1].force_factor(factor);
        }
        let speed = js_round(param(values, 4, 1.0)).clamp(0.0, 2.0) as i32;
        let speeds = [7.5, 15.0, 30.0];
        let bump_hz = 55.0 * (speeds[speed as usize] / 15.0);
        let bump_db = clamp(param(values, 7, 0.4), 0.0, 1.0) * 6.0;
        let key = (speed, (bump_db * 1_000_000.0).round() as i64);
        if !self.bump_ready || key != self.bump_key {
            let next = design_biquad(BiquadKind::Peaking, sample_rate, bump_hz, 0.9, bump_db);
            self.bump[0].copy_coeffs(&next);
            self.bump[1].copy_coeffs(&next);
            self.bump_key = key;
            self.bump_ready = true;
        }
        let bias = clamp(param(values, 5, 0.4), 0.0, 1.0);
        let rolloff = 6000.0 * (speeds[speed as usize] / 15.0) * (1.15 - bias * 0.5);
        let mut lowpass = [
            design_biquad(BiquadKind::Lowpass, sample_rate, rolloff, 0.7, 0.0),
            design_biquad(BiquadKind::Lowpass, sample_rate, rolloff, 0.7, 0.0),
        ];
        let wow = clamp(param(values, 6, 0.15), 0.0, 1.0);
        let drive = 0.15 + clamp(param(values, 1, 0.35), 0.0, 1.0) * 0.7;
        let hiss_level = if eco { 0.0 } else { clamp(param(values, 8, 0.0), 0.0, 1.0) * 0.004 };
        for i in 0..frames {
            let dry_l = left[i] as f64;
            let dry_r = right[i] as f64;
            self.phase += (2.0 * std::f64::consts::PI * (0.6 + wow * 2.0)) / sample_rate;
            let flutter = self.phase.sin() * wow * 8.0;
            self.delay[0][self.write] = dry_l as f32;
            self.delay[1][self.write] = dry_r as f32;
            let read_at = self.write as f64 - 24.0 - flutter;
            let colored_l = self.tape_shapers[0].oversample(read_frac(&self.delay[0], read_at), drive);
            let colored_r = self.tape_shapers[1].oversample(read_frac(&self.delay[1], read_at), drive);
            self.seed = (self.seed * 16807) % 2147483647;
            let noise = (self.seed as f64 / 2147483647.0) * 2.0 - 1.0;
            let high = tick(&mut self.hiss[0], noise * hiss_level);
            let hissed = tick(&mut self.hiss[1], high);
            let bumped_l = tick(&mut lowpass[0], tick(&mut self.bump[0], colored_l)) + hissed;
            let bumped_r = tick(&mut lowpass[1], tick(&mut self.bump[1], colored_r)) + hissed;
            left[i] = store(bumped_l);
            right[i] = store(bumped_r);
            self.write = (self.write + 1) % self.delay[0].len();
        }
    }

    fn sum(&mut self, left: &mut [f32], right: &mut [f32], frames: usize, values: &[f64], sample_rate: f64, eco: bool) {
        let _ = sample_rate;
        let factor = if eco { 2 } else { 4 };
        if self.sum_shapers[0].factor != factor {
            self.sum_shapers[0].force_factor(factor);
            self.sum_shapers[1].force_factor(factor);
        }
        let tube = param(values, 9, 0.0) >= 0.5;
        let drive = clamp(param(values, 1, 0.3), 0.0, 1.0) * if tube { 1.0 } else { 0.55 };
        let makeup = 1.0 / (1.0 + drive * 0.35);
        for i in 0..frames {
            let bend = |sample: f64| if tube { sample + 0.45 * sample * sample } else { sample };
            let wet_l = self.sum_shapers[0].oversample(bend(left[i] as f64), drive) * makeup;
            let wet_r = self.sum_shapers[1].oversample(bend(right[i] as f64), drive) * makeup;
            left[i] = store(wet_l);
            right[i] = store(wet_r);
        }
    }

    fn oxide(&mut self, left: &mut [f32], right: &mut [f32], frames: usize, values: &[f64], offline: bool) {
        if offline != self.oxide_full_on {
            if offline {
                self.oxide_full.reset();
            } else {
                self.oxide_eco.reset();
            }
            self.oxide_full_on = offline;
        }
        let drive = clamp(param(values, 1, 0.0), 0.0, 1.0);
        let tube = param(values, 10, 0.0) >= 0.5;
        let mix = clamp(param(values, 3, 1.0), 0.0, 1.0);
        let norm = (1.0 + drive * 6.0).tanh().max(0.2);
        let frames = frames.min(self.scratch_l.len());
        let (wet_l, wet_r) = (&mut self.scratch_l, &mut self.scratch_r);
        if offline {
            self.oxide_full.process(&left[..frames], &mut wet_l[..frames], |sample| shape_oxide(sample, drive, tube));
            self.oxide_full.process(&right[..frames], &mut wet_r[..frames], |sample| shape_oxide(sample, drive, tube));
            self.latency = self.oxide_full.latency() as u32;
        } else {
            self.oxide_eco.process(&left[..frames], &mut wet_l[..frames], |sample| shape_oxide(sample, drive, tube));
            self.oxide_eco.process(&right[..frames], &mut wet_r[..frames], |sample| shape_oxide(sample, drive, tube));
            self.latency = 0;
        }
        for i in 0..frames {
            let dry_l = left[i] as f64;
            let dry_r = right[i] as f64;
            left[i] = store(dry_l * (1.0 - mix) + (wet_l[i] as f64 / norm) * mix);
            right[i] = store(dry_r * (1.0 - mix) + (wet_r[i] as f64 / norm) * mix);
        }
    }

    fn clip(&mut self, left: &mut [f32], right: &mut [f32], frames: usize, values: &[f64], offline: bool) {
        if offline != self.clip_full_on {
            if offline {
                self.clip_full.reset();
            } else {
                self.clip_eco.reset();
            }
            self.clip_full_on = offline;
        }
        let ceiling = crate::util::db_to_gain(param(values, 12, -0.3));
        let drive = 1.0 + clamp(param(values, 1, 0.0), 0.0, 1.0) * 8.0;
        let hard = param(values, 11, 0.0) >= 0.5;
        let frames = frames.min(self.scratch_l.len());
        let shape = |sample: f64| {
            let driven = sample * drive;
            if hard { clamp(driven, -ceiling, ceiling) } else { (driven / ceiling.max(1e-6)).tanh() * ceiling }
        };
        if offline {
            self.clip_full.process(&left[..frames], &mut self.scratch_l[..frames], shape);
            self.clip_full.process(&right[..frames], &mut self.scratch_r[..frames], shape);
            self.latency = self.clip_full.latency() as u32;
        } else {
            self.clip_eco.process(&left[..frames], &mut self.scratch_l[..frames], shape);
            self.clip_eco.process(&right[..frames], &mut self.scratch_r[..frames], shape);
            self.latency = 0;
        }
        for i in 0..frames {
            left[i] = store(self.scratch_l[i] as f64);
            right[i] = store(self.scratch_r[i] as f64);
        }
    }
}

fn shape_oxide(sample: f64, drive: f64, tube: bool) -> f64 {
    let driven = sample * (1.0 + drive * 6.0);
    if tube {
        (driven + 0.2 * driven * driven.abs()).tanh()
    } else {
        driven.tanh()
    }
}
