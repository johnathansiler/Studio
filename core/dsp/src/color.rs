//! Saturator kinds: soft clip, tape, sum, oxide, clip, and amp.

use crate::amp::Amp;
use crate::biquad::{design_biquad, tick, Biquad, BiquadKind};
use crate::resample::Oversampler;
use crate::shaper::{shaper_latency_samples, soft_sample_rate, AnalogShaper, SoftShaper};
use crate::smooth::SampleGlide;

const SAT_FADE: u32 = 128;
use crate::util::{clamp, js_round, param, read_frac, store};

pub struct SatBank {
    tone: [Biquad; 2],
    tone_target: Biquad,
    tone_freq: f64,
    tone_ready: bool,
    tone_move: bool,
    sat_warm: u32,
    sat_fade: u32,
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
    tape_lp: [Biquad; 2],
    tape_rolloff: f64,
    tape_rate: f64,
    dc_x: [f64; 2],
    dc_y: [f64; 2],
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
            tone: [
                design_biquad(BiquadKind::Lowpass, soft_sample_rate(sample_rate), 8000.0, 0.7, 0.0),
                design_biquad(BiquadKind::Lowpass, soft_sample_rate(sample_rate), 8000.0, 0.7, 0.0),
            ],
            tone_target: design_biquad(BiquadKind::Lowpass, soft_sample_rate(sample_rate), 8000.0, 0.7, 0.0),
            tone_freq: f64::NAN,
            tone_ready: false,
            tone_move: false,
            sat_warm: 0,
            sat_fade: 0,
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
            tape_lp: [
                design_biquad(BiquadKind::Lowpass, sample_rate, 8000.0, 0.7, 0.0),
                design_biquad(BiquadKind::Lowpass, sample_rate, 8000.0, 0.7, 0.0),
            ],
            tape_rolloff: f64::NAN,
            tape_rate: f64::NAN,
            dc_x: [0.0; 2],
            dc_y: [0.0; 2],
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
        for filter in &mut self.tone {
            filter.clear_state();
        }
        self.soft[0].reset();
        self.soft[1].reset();
        self.drive.reset();
        self.mix.reset();
        self.sat_warm = 0;
        self.sat_fade = 0;
        self.tone_ready = false;
        self.tone_move = false;
        self.tone_freq = f64::NAN;
        self.tape_lp[0].clear_state();
        self.tape_lp[1].clear_state();
        self.dc_x = [0.0; 2];
        self.dc_y = [0.0; 2];
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
            let next = design_biquad(BiquadKind::Lowpass, soft_sample_rate(sample_rate), freq, 0.7, 0.0);
            self.tone_target.copy_coeffs(&next);
            self.tone_freq = freq;
            if !self.tone_ready {
                self.tone[0].copy_coeffs(&self.tone_target);
                self.tone[1].copy_coeffs(&self.tone_target);
                self.tone_ready = true;
                self.tone_move = false;
            } else {
                self.tone_move = true;
            }
        }
        let drive_target = clamp(param(values, 1, 0.0), 0.0, 1.0);
        let mix_target = clamp(param(values, 3, 1.0), 0.0, 1.0);
        self.drive.prepare(sample_rate);
        self.mix.prepare(sample_rate);
        let rate = if sample_rate > 0.0 { sample_rate } else { 48_000.0 };
        let alpha = 1.0 - (-1.0 / (0.008 * rate)).exp();
        let latency = shaper_latency_samples();
        self.latency = if drive_target <= 0.0001 { 0 } else { latency };
        for i in 0..frames {
            if self.tone_move {
                let target = self.tone_target;
                self.tone_move = !slew_tone(&mut self.tone, &target, alpha);
            }
            let drive = self.drive.next(drive_target);
            let mix = self.mix.next(mix_target);
            let want = drive_target > 0.0001 || drive > 0.0001;
            let mut wet = [0.0; 2];
            if want || self.sat_fade > 0 {
                let shape = 1.0 + drive * 8.0;
                let dry = [left[i] as f64, right[i] as f64];
                for channel in 0..2 {
                    wet[channel] = self.soft[channel].shape(dry[channel], drive, shape, &mut self.tone[channel]);
                }
                if self.sat_warm < 1_000_000 {
                    self.sat_warm += 1;
                }
                if self.sat_warm > latency {
                    self.sat_fade = if want {
                        self.sat_fade.saturating_add(1).min(SAT_FADE)
                    } else {
                        self.sat_fade.saturating_sub(1)
                    };
                }
            } else if self.sat_warm != 0 {
                self.soft[0].reset();
                self.soft[1].reset();
                for filter in &mut self.tone {
                    filter.clear_state();
                }
                self.sat_warm = 0;
                self.sat_fade = 0;
            }
            let open = self.sat_fade as f64 / SAT_FADE as f64;
            let amount = open * mix;
            left[i] = store(left[i] as f64 * (1.0 - amount) + wet[0] * amount);
            right[i] = store(right[i] as f64 * (1.0 - amount) + wet[1] * amount);
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
        if !self.tape_rolloff.is_finite()
            || !self.tape_rate.is_finite()
            || (self.tape_rolloff - rolloff).abs() > 1e-4
            || (self.tape_rate - sample_rate).abs() > 0.1
        {
            let next = design_biquad(BiquadKind::Lowpass, sample_rate, rolloff, 0.7, 0.0);
            self.tape_lp[0].copy_coeffs(&next);
            self.tape_lp[1].copy_coeffs(&next);
            self.tape_rolloff = rolloff;
            self.tape_rate = sample_rate;
        }
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
            let bumped_l = tick(&mut self.tape_lp[0], tick(&mut self.bump[0], colored_l)) + hissed;
            let bumped_r = tick(&mut self.tape_lp[1], tick(&mut self.bump[1], colored_r)) + hissed;
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
        let dc_rate = (-2.0 * std::f64::consts::PI * 8.0 / sample_rate).exp();
        for i in 0..frames {
            let bend = |sample: f64| if tube { sample + 0.45 * sample * sample } else { sample };
            let wet_l = self.sum_shapers[0].oversample(bend(left[i] as f64), drive) * makeup;
            let wet_r = self.sum_shapers[1].oversample(bend(right[i] as f64), drive) * makeup;
            left[i] = store(block_dc(&mut self.dc_x[0], &mut self.dc_y[0], wet_l, dc_rate));
            right[i] = store(block_dc(&mut self.dc_x[1], &mut self.dc_y[1], wet_r, dc_rate));
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

fn slew_tone(tone: &mut [Biquad; 2], target: &Biquad, alpha: f64) -> bool {
    let mut err: f64 = 0.0;
    for filter in tone.iter_mut() {
        filter.b0 += (target.b0 - filter.b0) * alpha;
        filter.b1 += (target.b1 - filter.b1) * alpha;
        filter.b2 += (target.b2 - filter.b2) * alpha;
        filter.a1 += (target.a1 - filter.a1) * alpha;
        filter.a2 += (target.a2 - filter.a2) * alpha;
        err = err
            .max((target.b0 - filter.b0).abs())
            .max((target.b1 - filter.b1).abs())
            .max((target.b2 - filter.b2).abs())
            .max((target.a1 - filter.a1).abs())
            .max((target.a2 - filter.a2).abs());
    }
    if err < 1e-8 {
        tone[0].copy_coeffs(target);
        tone[1].copy_coeffs(target);
        true
    } else {
        false
    }
}

fn block_dc(prev_x: &mut f64, prev_y: &mut f64, sample: f64, rate: f64) -> f64 {
    let y = sample - *prev_x + rate * *prev_y;
    *prev_x = sample;
    *prev_y = if y.is_finite() && y.abs() >= 1e-15 { y } else { 0.0 };
    *prev_y
}

fn shape_oxide(sample: f64, drive: f64, tube: bool) -> f64 {
    let driven = sample * (1.0 + drive * 6.0);
    if tube {
        (driven + 0.2 * driven * driven.abs()).tanh()
    } else {
        driven.tanh()
    }
}
