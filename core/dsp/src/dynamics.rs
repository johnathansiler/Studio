//! Dynamics inserts: VCA compressor, FET, opto, bus, vari-mu, glue, multiband,
//! gate, de-esser, and the vocal kind switch.

use crate::biquad::{design_biquad, tick, Biquad, BiquadKind};
use crate::shaper::AnalogShaper;
use crate::smooth::SampleGlide;
use crate::util::{clamp, coeff, db_to_gain, gain_to_db, js_or, js_round, param, write_stereo};

const FET_RATIOS: [f64; 5] = [4.0, 8.0, 12.0, 20.0, 20.0];
const BUS_RATIOS: [f64; 3] = [2.0, 4.0, 10.0];
const BUS_ATTACKS: [f64; 6] = [0.1, 0.3, 1.0, 3.0, 10.0, 30.0];
const BUS_RELEASES: [f64; 5] = [100.0, 300.0, 600.0, 1200.0, 0.0];
const VARI_TIMES: [(f64, f64, f64); 6] = [
    (0.2, 300.0, 300.0),
    (0.2, 800.0, 800.0),
    (0.4, 2000.0, 2000.0),
    (0.8, 5000.0, 5000.0),
    (0.2, 300.0, 2000.0),
    (0.4, 800.0, 5000.0),
];
const VU_DBFS: f64 = -18.0;

fn step_pick(index: f64, values: &[f64]) -> f64 {
    let at = js_round(index).clamp(0.0, (values.len() - 1) as f64) as usize;
    values[at]
}

fn fet_reduction(over_db: f64, ratio_index: f64) -> f64 {
    let slot = js_round(ratio_index).clamp(0.0, 4.0) as usize;
    let ratio = FET_RATIOS[slot];
    let knee = 1.5;
    if over_db <= -knee {
        return 0.0;
    }
    let mut over = over_db;
    if over < knee {
        let soft = over + knee;
        over = (soft * soft) / (4.0 * knee);
    }
    let mut reduction = over.max(0.0) * (1.0 - 1.0 / ratio);
    if js_round(ratio_index) >= 4.0 && over_db > 2.0 {
        reduction += (4.0_f64).min((over_db - 2.0) * 0.35);
    }
    reduction
}

fn vca_reduction(over_db: f64, ratio_index: f64) -> f64 {
    let ratio = BUS_RATIOS[js_round(ratio_index).clamp(0.0, 2.0) as usize];
    if over_db <= 0.0 {
        0.0
    } else {
        over_db * (1.0 - 1.0 / ratio)
    }
}

fn vari_reduction(over_db: f64) -> f64 {
    let knee = 8.0;
    if over_db <= -knee / 2.0 {
        return 0.0;
    }
    let soft = over_db + knee / 2.0;
    let bent = if soft < knee { (soft * soft) / (2.0 * knee) } else { over_db };
    bent.max(0.0) * (1.0 - 1.0 / 4.0)
}

pub struct CompBank {
    env: f64,
    fet_env: f64,
    bus_env: f64,
    glue_env: f64,
    mix: SampleGlide,
    fast: f64,
    slow: f64,
    vari_fast: f64,
    vari_slow: f64,
    shapers: [AnalogShaper; 2],
    vari_shapers: [AnalogShaper; 2],
    side: [Biquad; 2],
    hpf: f64,
    bands_env: [f64; 5],
    filters: [[Biquad; 4]; 2],
    split: [f64; 4],
    split_ready: bool,
}

impl CompBank {
    pub fn new() -> Self {
        Self {
            env: 0.0,
            fet_env: 0.0,
            bus_env: 0.0,
            glue_env: 0.0,
            mix: SampleGlide::default(),
            fast: 0.0,
            slow: 0.0,
            vari_fast: 0.0,
            vari_slow: 0.0,
            shapers: [AnalogShaper::new(4), AnalogShaper::new(4)],
            vari_shapers: [AnalogShaper::new(4), AnalogShaper::new(4)],
            side: [
                design_biquad(BiquadKind::Highpass, 48_000.0, 80.0, 0.7, 0.0),
                design_biquad(BiquadKind::Highpass, 48_000.0, 80.0, 0.7, 0.0),
            ],
            hpf: -1.0,
            bands_env: [0.0; 5],
            filters: [[Biquad::default(); 4]; 2],
            split: [0.0; 4],
            split_ready: false,
        }
    }

    pub fn reset(&mut self) {
        self.env = 0.0;
        self.fet_env = 0.0;
        self.bus_env = 0.0;
        self.glue_env = 0.0;
        self.fast = 0.0;
        self.slow = 0.0;
        self.vari_fast = 0.0;
        self.vari_slow = 0.0;
        self.mix.reset();
        self.bands_env = [0.0; 5];
        self.hpf = -1.0;
        self.split_ready = false;
        for filter in &mut self.side {
            filter.clear_state();
        }
        for bank in &mut self.filters {
            for filter in bank {
                filter.clear_state();
            }
        }
        self.shapers[0].force_factor(4);
        self.shapers[1].force_factor(4);
        self.vari_shapers[0].force_factor(4);
        self.vari_shapers[1].force_factor(4);
    }

    pub fn process(
        &mut self,
        left: &mut [f32],
        right: &mut [f32],
        frames: usize,
        values: &[f64],
        sample_rate: f64,
        eco: bool,
        sidechain: Option<&[f32]>,
    ) -> u32 {
        let kind = js_round(param(values, 0, 0.0)).clamp(0.0, 6.0) as i32;
        match kind {
            1 => self.fet(left, right, frames, values, sample_rate, eco),
            2 => self.opto(left, right, frames, values, sample_rate),
            3 => self.bus(left, right, frames, values, sample_rate),
            4 => self.vari(left, right, frames, values, sample_rate, eco),
            5 => self.glue(left, right, frames, values, sample_rate),
            6 => self.multi(left, right, frames, values, sample_rate),
            _ => self.vca(left, right, frames, values, sample_rate, sidechain),
        }
        0
    }

    fn vca(&mut self, left: &mut [f32], right: &mut [f32], frames: usize, values: &[f64], sample_rate: f64, sidechain: Option<&[f32]>) {
        let attack = coeff(js_or(param(values, 3, 10.0), 10.0), sample_rate);
        let release = coeff(js_or(param(values, 4, 80.0), 80.0), sample_rate);
        let mix_target = clamp(param(values, 7, 1.0), 0.0, 1.0);
        self.mix.prepare(sample_rate);
        let threshold = param(values, 1, 0.0);
        let knee = param(values, 5, 0.0).max(0.0);
        let ratio = param(values, 2, 1.0).max(1.0);
        let makeup = param(values, 6, 0.0);
        for i in 0..frames {
            let mix = self.mix.next(mix_target);
            let dry_l = left.get(i).copied().unwrap_or(0.0) as f64;
            let dry_r = right.get(i).copied().unwrap_or(dry_l as f32) as f64;
            let detector = if let Some(side) = sidechain {
                (side.get(i.min(side.len().saturating_sub(1))).copied().unwrap_or(0.0) as f64).abs()
            } else {
                dry_l.abs().max(dry_r.abs())
            };
            let rate = if detector > self.env { attack } else { release };
            self.env += (detector - self.env) * rate;
            let db = gain_to_db(self.env);
            let mut over = db - threshold;
            if knee > 0.0 && over > -knee / 2.0 && over < knee / 2.0 {
                let soft = over + knee / 2.0;
                over = (soft * soft) / (2.0 * knee);
            }
            let reduction = if over > 0.0 { over * (1.0 - 1.0 / ratio) } else { 0.0 };
            let wet = db_to_gain(-reduction + makeup);
            write_stereo(left, right, i, dry_l * (1.0 - mix) + dry_l * wet * mix, dry_r * (1.0 - mix) + dry_r * wet * mix);
        }
    }

    fn fet(&mut self, left: &mut [f32], right: &mut [f32], frames: usize, values: &[f64], sample_rate: f64, eco: bool) {
        let factor = if eco { 2 } else { 4 };
        if self.shapers[0].factor != factor {
            self.shapers[0].force_factor(factor);
            self.shapers[1].force_factor(factor);
        }
        let in_gain = db_to_gain(param(values, 9, 0.0));
        let out_gain = db_to_gain(param(values, 10, 0.0));
        let attack = coeff(clamp(param(values, 12, 0.2), 0.02, 0.8), sample_rate);
        let drive = if js_round(param(values, 11, 0.0)) >= 4.0 { 0.45 } else { 0.12 };
        let release_base = clamp(param(values, 13, 300.0), 50.0, 1100.0);
        for i in 0..frames {
            let dry_l = left[i] as f64 * in_gain;
            let dry_r = right[i] as f64 * in_gain;
            let detector = gain_to_db(dry_l.abs().max(dry_r.abs()));
            let target = fet_reduction(detector - VU_DBFS, param(values, 11, 0.0));
            let release_ms = release_base / (1.0 + self.fet_env.max(0.0) / 8.0);
            let rate = if target > self.fet_env { attack } else { coeff(release_ms, sample_rate) };
            self.fet_env += (target - self.fet_env) * rate;
            let reduced = db_to_gain(-self.fet_env);
            let colored_l = self.shapers[0].oversample(dry_l * reduced, drive) * out_gain;
            let colored_r = self.shapers[1].oversample(dry_r * reduced, drive) * out_gain;
            write_stereo(left, right, i, colored_l, colored_r);
        }
    }

    fn opto(&mut self, left: &mut [f32], right: &mut [f32], frames: usize, values: &[f64], sample_rate: f64) {
        let reduction = clamp(param(values, 14, 0.35), 0.0, 1.0);
        let threshold = VU_DBFS + (1.0 - reduction) * 24.0;
        let makeup = db_to_gain(param(values, 15, 6.0));
        let attack = coeff(10.0, sample_rate);
        let release_fast = coeff(60.0, sample_rate);
        let release_slow = coeff(5000.0, sample_rate);
        for i in 0..frames {
            let dry_l = left[i] as f64;
            let dry_r = right[i] as f64;
            let detector = gain_to_db(dry_l.abs().max(dry_r.abs()));
            let target = (detector - threshold).max(0.0) * 0.6;
            let fast_target = target * 0.7;
            let slow_target = target * 0.3;
            self.fast += (fast_target - self.fast) * if fast_target > self.fast { attack } else { release_fast };
            self.slow += (slow_target - self.slow) * if slow_target > self.slow { attack * 0.35 } else { release_slow };
            let gain = db_to_gain(-(self.fast + self.slow)) * makeup;
            write_stereo(left, right, i, dry_l * gain, dry_r * gain);
        }
    }

    fn bus(&mut self, left: &mut [f32], right: &mut [f32], frames: usize, values: &[f64], sample_rate: f64) {
        let freq = clamp(param(values, 20, 80.0), 20.0, 400.0);
        if freq != self.hpf {
            let next = design_biquad(BiquadKind::Highpass, sample_rate, freq, 0.7, 0.0);
            self.side[0].copy_coeffs(&next);
            self.side[1].copy_coeffs(&next);
            self.hpf = freq;
        }
        let threshold = param(values, 16, -8.0);
        let makeup = db_to_gain(param(values, 21, 0.0));
        let attack = coeff(step_pick(param(values, 18, 2.0), &BUS_ATTACKS), sample_rate);
        let release_index = js_round(param(values, 19, 4.0));
        let auto = release_index >= (BUS_RELEASES.len() - 1) as f64;
        for i in 0..frames {
            let dry_l = left[i] as f64;
            let dry_r = right[i] as f64;
            let det_l = tick(&mut self.side[0], dry_l);
            let det_r = tick(&mut self.side[1], dry_r);
            let detector = gain_to_db(det_l.abs().max(det_r.abs()));
            let target = vca_reduction(detector - threshold, param(values, 17, 1.0));
            let release_ms = if auto {
                100.0 + self.bus_env * 12.0
            } else {
                step_pick(release_index, &BUS_RELEASES)
            };
            let rate = if target > self.bus_env { attack } else { coeff(release_ms.max(40.0), sample_rate) };
            self.bus_env += (target - self.bus_env) * rate;
            let gain = db_to_gain(-self.bus_env) * makeup;
            write_stereo(left, right, i, dry_l * gain, dry_r * gain);
        }
    }

    fn vari(&mut self, left: &mut [f32], right: &mut [f32], frames: usize, values: &[f64], sample_rate: f64, eco: bool) {
        let factor = if eco { 2 } else { 4 };
        if self.vari_shapers[0].factor != factor {
            self.vari_shapers[0].force_factor(factor);
            self.vari_shapers[1].force_factor(factor);
        }
        let timing = VARI_TIMES[js_round(param(values, 22, 1.0)).clamp(0.0, 5.0) as usize];
        let attack = coeff(timing.0, sample_rate);
        let release = coeff(timing.1, sample_rate);
        let slow_release = coeff(timing.2, sample_rate);
        let input_gain = db_to_gain(param(values, 23, 0.0));
        let output_gain = db_to_gain(param(values, 24, 0.0));
        let drive = clamp(param(values, 25, 0.35), 0.0, 1.0);
        for i in 0..frames {
            let dry_l = left[i] as f64;
            let dry_r = right[i] as f64;
            let left_s = dry_l * input_gain;
            let right_s = dry_r * input_gain;
            let target = vari_reduction(gain_to_db(dry_l.abs().max(dry_r.abs()) * input_gain) - VU_DBFS);
            let fast_target = target * 0.65;
            let slow_target = target * 0.35;
            self.vari_fast += (fast_target - self.vari_fast) * if fast_target > self.vari_fast { attack } else { release };
            self.vari_slow += (slow_target - self.vari_slow) * if slow_target > self.vari_slow { attack } else { slow_release };
            let gain = db_to_gain(-(self.vari_fast + self.vari_slow));
            write_stereo(
                left,
                right,
                i,
                self.vari_shapers[0].oversample(left_s * gain, drive) * output_gain,
                self.vari_shapers[1].oversample(right_s * gain, drive) * output_gain,
            );
        }
    }

    fn glue(&mut self, left: &mut [f32], right: &mut [f32], frames: usize, values: &[f64], sample_rate: f64) {
        let attack = coeff(js_or(param(values, 3, 10.0), 10.0), sample_rate);
        let mode = js_round(param(values, 8, 1.0));
        let release_ms = if mode <= 0.0 {
            30.0
        } else if mode >= 2.0 {
            200.0
        } else {
            js_or(param(values, 4, 100.0), 100.0)
        };
        let release = coeff(release_ms, sample_rate);
        let mix = clamp(param(values, 7, 1.0), 0.0, 1.0);
        let threshold = param(values, 1, -12.0);
        let ratio = js_or(param(values, 2, 2.0), 2.0);
        let makeup = param(values, 6, 0.0);
        for i in 0..frames {
            let dry_l = left[i] as f64;
            let dry_r = right[i] as f64;
            let detector = dry_l.abs().max(dry_r.abs());
            let rate = if detector > self.glue_env { attack } else { release };
            self.glue_env += (detector - self.glue_env) * rate;
            let gain = compress_level(self.glue_env, threshold, ratio, makeup);
            write_stereo(left, right, i, dry_l * (1.0 - mix) + dry_l * gain * mix, dry_r * (1.0 - mix) + dry_r * gain * mix);
        }
    }

    fn multi(&mut self, left: &mut [f32], right: &mut [f32], frames: usize, values: &[f64], sample_rate: f64) {
        let count = js_round(js_or(param(values, 26, 4.0), 4.0)).clamp(3.0, 5.0) as usize;
        let freqs = [
            js_or(param(values, 27, 120.0), 120.0),
            js_or(param(values, 28, 500.0), 500.0),
            js_or(param(values, 29, 2000.0), 2000.0),
            js_or(param(values, 30, 6000.0), 6000.0),
        ];
        let used = count - 1;
        let mut changed = !self.split_ready;
        for index in 0..used {
            if freqs[index] != self.split[index] {
                changed = true;
            }
        }
        if changed {
            for bank in &mut self.filters {
                for index in 0..used {
                    let next = design_biquad(BiquadKind::Lowpass, sample_rate, freqs[index], 0.707, 0.0);
                    bank[index].copy_coeffs(&next);
                }
            }
            self.split = freqs;
            self.split_ready = true;
        }
        let attack = coeff(js_or(param(values, 3, 10.0), 10.0), sample_rate);
        let release = coeff(js_or(param(values, 4, 80.0), 80.0), sample_rate);
        let threshold = param(values, 1, -18.0);
        let ratio = js_or(param(values, 2, 1.0), 1.0);
        let makeup = param(values, 6, 0.0);
        for i in 0..frames {
            let sources = [left[i] as f64, right[i] as f64];
            let mut outs = [0.0; 2];
            for channel in 0..2 {
                let mut rest = sources[channel];
                let mut mixed = 0.0;
                for band in 0..count {
                    let piece = if band < count - 1 {
                        let low = tick(&mut self.filters[channel][band], rest);
                        rest -= low;
                        low
                    } else {
                        rest
                    };
                    let detector = piece.abs();
                    let rate = if detector > self.bands_env[band] { attack } else { release };
                    self.bands_env[band] += (detector - self.bands_env[band]) * rate;
                    mixed += piece * compress_level(self.bands_env[band], threshold, ratio, makeup);
                }
                outs[channel] = mixed;
            }
            write_stereo(left, right, i, outs[0], outs[1]);
        }
    }
}

fn compress_level(level: f64, threshold: f64, ratio: f64, makeup: f64) -> f64 {
    let over = gain_to_db(level) - threshold;
    let reduction = if over > 0.0 { over * (1.0 - 1.0 / ratio.max(1.0)) } else { 0.0 };
    db_to_gain(-reduction + makeup)
}

pub struct Gate {
    env: f64,
    hold: i32,
    open: bool,
}

impl Gate {
    pub fn new() -> Self {
        Self { env: 1.0, hold: 0, open: false }
    }
    pub fn reset(&mut self) {
        self.env = 1.0;
        self.hold = 0;
        self.open = false;
    }
    pub fn process(&mut self, left: &mut [f32], right: &mut [f32], frames: usize, threshold_db: f64, ratio: f64, attack_ms: f64, release_ms: f64, hold_ms: f64, range_db: f64, sample_rate: f64, sidechain: Option<&[f32]>) {
        let open_c = coeff(attack_ms, sample_rate);
        let close_c = coeff(release_ms, sample_rate);
        let threshold = db_to_gain(threshold_db);
        let range = db_to_gain(-range_db.abs());
        let ratio = ratio.max(1.0);
        let hold_samples = js_round((hold_ms / 1000.0) * sample_rate) as i32;
        let close_at = threshold * 0.7;
        for i in 0..frames {
            let dry_l = left.get(i).copied().unwrap_or(0.0) as f64;
            let dry_r = right.get(i).copied().unwrap_or(dry_l as f32) as f64;
            let detector = if let Some(side) = sidechain {
                let last = side.len().saturating_sub(1);
                (side.get(i.min(last)).copied().unwrap_or(0.0) as f64).abs()
            } else {
                dry_l.abs().max(dry_r.abs())
            };
            if detector >= threshold {
                self.open = true;
            } else if detector < close_at {
                self.open = false;
            }
            if self.open {
                self.hold = hold_samples;
            } else if self.hold > 0 {
                self.hold -= 1;
            }
            let below = if self.hold > 0 || self.open {
                1.0
            } else if detector < threshold {
                clamp(if threshold > 0.0 { detector / threshold } else { 1.0 }, 0.0, 1.0)
            } else {
                1.0
            };
            let expanded = if below >= 1.0 { 1.0 } else { range.max(below.powf(ratio - 1.0)) };
            let rate = if expanded > self.env { open_c } else { close_c };
            self.env += (expanded - self.env) * rate;
            write_stereo(left, right, i, dry_l * self.env, dry_r * self.env);
        }
    }
}

pub struct Deesser {
    band: [Biquad; 2],
    env: f64,
    freq: f64,
}

impl Deesser {
    pub fn new(sample_rate: f64) -> Self {
        Self {
            band: [
                design_biquad(BiquadKind::Bandpass, sample_rate, 6500.0, 2.0, 0.0),
                design_biquad(BiquadKind::Bandpass, sample_rate, 6500.0, 2.0, 0.0),
            ],
            env: 0.0,
            freq: f64::NAN,
        }
    }
    pub fn reset(&mut self) {
        self.env = 0.0;
        for filter in &mut self.band {
            filter.clear_state();
        }
    }
    pub fn process(&mut self, left: &mut [f32], right: &mut [f32], frames: usize, freq: f64, threshold_db: f64, amount: f64, sample_rate: f64) {
        if freq != self.freq {
            let next = design_biquad(BiquadKind::Bandpass, sample_rate, freq, 2.2, 0.0);
            self.band[0].copy_coeffs(&next);
            self.band[1].copy_coeffs(&next);
            self.freq = freq;
        }
        let amount = clamp(amount, 0.0, 1.0);
        let threshold = db_to_gain(threshold_db);
        let follow = coeff(8.0, sample_rate);
        for i in 0..frames {
            let dry_l = left[i] as f64;
            let dry_r = right[i] as f64;
            let band_l = tick(&mut self.band[0], dry_l);
            let band_r = tick(&mut self.band[1], dry_r);
            let ess = band_l.abs().max(band_r.abs());
            self.env += (ess - self.env) * follow;
            let over = if self.env > threshold && threshold > 0.0 {
                clamp((self.env - threshold) / threshold, 0.0, 1.0)
            } else {
                0.0
            };
            let cut = amount * over;
            write_stereo(left, right, i, dry_l - band_l * cut, dry_r - band_r * cut);
        }
    }
}

pub struct Vocal {
    gate: Gate,
    ess: Deesser,
    mid_l: Vec<f32>,
    mid_r: Vec<f32>,
}

impl Vocal {
    pub fn new(sample_rate: f64, max_block: usize) -> Self {
        Self {
            gate: Gate::new(),
            ess: Deesser::new(sample_rate),
            mid_l: vec![0.0; max_block.max(1)],
            mid_r: vec![0.0; max_block.max(1)],
        }
    }
    pub fn reset(&mut self) {
        self.gate.reset();
        self.ess.reset();
    }
    pub fn process(&mut self, left: &mut [f32], right: &mut [f32], frames: usize, values: &[f64], sample_rate: f64, sidechain: Option<&[f32]>) {
        let kind = js_round(param(values, 0, 0.0)) as i32;
        let gate_threshold = if kind == 1 { -80.0 } else { param(values, 4, -80.0) };
        let gate_ratio = if kind == 1 { 1.0 } else { param(values, 5, 1.0) };
        let amount = if kind == 2 { 0.0 } else { param(values, 3, 0.0) };
        let gate_open = gate_threshold <= -79.0 && gate_ratio <= 1.01;
        let ess_off = amount <= 0.0001;
        if gate_open && ess_off {
            return;
        }
        if gate_open {
            self.ess.process(left, right, frames, param(values, 1, 6500.0), param(values, 2, -18.0), amount, sample_rate);
            return;
        }
        let frames = frames.min(self.mid_l.len());
        if ess_off {
            self.gate.process(left, right, frames, gate_threshold, gate_ratio, param(values, 6, 5.0), param(values, 7, 80.0), param(values, 8, 20.0), param(values, 9, 40.0), sample_rate, sidechain);
            return;
        }
        self.mid_l[..frames].copy_from_slice(&left[..frames]);
        self.mid_r[..frames].copy_from_slice(&right[..frames]);
        self.gate.process(&mut self.mid_l, &mut self.mid_r, frames, gate_threshold, gate_ratio, param(values, 6, 5.0), param(values, 7, 80.0), param(values, 8, 20.0), param(values, 9, 40.0), sample_rate, sidechain);
        left[..frames].copy_from_slice(&self.mid_l[..frames]);
        right[..frames].copy_from_slice(&self.mid_r[..frames]);
        self.ess.process(left, right, frames, param(values, 1, 6500.0), param(values, 2, -18.0), amount, sample_rate);
    }
}
