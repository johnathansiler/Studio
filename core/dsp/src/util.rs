//! Helpers shared with the TypeScript processors in `src/audio/plugins`.

use crate::biquad::sanitize;

pub fn clamp(value: f64, min: f64, max: f64) -> f64 {
    if !value.is_finite() {
        min
    } else {
        value.clamp(min, max)
    }
}

/// `Math.round`: half goes toward +infinity.
pub fn js_round(value: f64) -> f64 {
    if !value.is_finite() {
        return value;
    }
    (value + 0.5).floor()
}

pub fn js_or(value: f64, fallback: f64) -> f64 {
    if value == 0.0 || !value.is_finite() {
        fallback
    } else {
        value
    }
}

pub fn coeff(ms: f64, sample_rate: f64) -> f64 {
    let samples = ((ms / 1000.0) * sample_rate).max(1.0);
    1.0 - (-1.0 / samples).exp()
}

pub fn db_to_gain(db: f64) -> f64 {
    10f64.powf(db / 20.0)
}

pub fn gain_to_db(gain: f64) -> f64 {
    let abs = gain.abs();
    if abs < 1e-8 {
        -160.0
    } else {
        20.0 * abs.log10()
    }
}

pub fn param(values: &[f64], index: usize, default: f64) -> f64 {
    values
        .get(index)
        .copied()
        .filter(|value| value.is_finite())
        .unwrap_or(default)
}

pub fn store(sample: f64) -> f32 {
    sanitize(sample) as f32
}

pub fn read_frac(line: &[f32], at: f64) -> f64 {
    let length = line.len();
    if length == 0 {
        return 0.0;
    }
    let len = length as f64;
    let wrapped = ((at % len) + len) % len;
    let index = wrapped.floor() as usize % length;
    let frac = wrapped - index as f64;
    let next = (index + 1) % length;
    let a = line[index] as f64;
    let b = line[next] as f64;
    a * (1.0 - frac) + b * frac
}

pub fn read_at(line: &[f32], write: usize, delay: f64) -> f64 {
    let length = line.len();
    if length == 0 {
        return 0.0;
    }
    let index = write as f64 - delay;
    let i0 = index.floor() as i64;
    let frac = index - i0 as f64;
    let a = line[floor_index(i0, length)] as f64;
    let b = line[floor_index(i0 + 1, length)] as f64;
    a + (b - a) * frac
}

pub fn read_int(line: &[f32], at: f64) -> f64 {
    let length = line.len();
    if length == 0 {
        return 0.0;
    }
    line[floor_index(at.floor() as i64, length)] as f64
}

fn floor_index(index: i64, length: usize) -> usize {
    let len = length as i64;
    let mut wrapped = index % len;
    if wrapped < 0 {
        wrapped += len;
    }
    wrapped as usize
}

pub fn write_stereo(left: &mut [f32], right: &mut [f32], index: usize, l: f64, r: f64) {
    if index < left.len() {
        left[index] = store(l);
    }
    if index < right.len() {
        right[index] = store(r);
    }
}

pub fn sample_at(channel: &[f32], index: usize, fallback: f64) -> f64 {
    channel.get(index).copied().unwrap_or(fallback as f32) as f64
}
