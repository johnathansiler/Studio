//! Biquad design and tick. Formulas are copied from `designBiquad` / `tickBiquad`
//! in `src/audio/plugins/dsp.ts` so a settled EQ can match that processor.

#[derive(Clone, Copy, Debug)]
pub struct Biquad {
    pub b0: f64,
    pub b1: f64,
    pub b2: f64,
    pub a1: f64,
    pub a2: f64,
    pub x1: f64,
    pub x2: f64,
    pub y1: f64,
    pub y2: f64,
}

impl Default for Biquad {
    fn default() -> Self {
        Self {
            b0: 1.0,
            b1: 0.0,
            b2: 0.0,
            a1: 0.0,
            a2: 0.0,
            x1: 0.0,
            x2: 0.0,
            y1: 0.0,
            y2: 0.0,
        }
    }
}

impl Biquad {
    pub fn clear_state(&mut self) {
        self.x1 = 0.0;
        self.x2 = 0.0;
        self.y1 = 0.0;
        self.y2 = 0.0;
    }

    pub fn copy_coeffs(&mut self, next: &Biquad) {
        self.b0 = next.b0;
        self.b1 = next.b1;
        self.b2 = next.b2;
        self.a1 = next.a1;
        self.a2 = next.a2;
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BiquadKind {
    Peaking,
    Lowpass,
    Highpass,
    Lowshelf,
    Highshelf,
    Bandpass,
}

pub fn design_biquad(
    kind: BiquadKind,
    sample_rate: f64,
    freq: f64,
    q: f64,
    gain_db: f64,
) -> Biquad {
    let fs = sample_rate.max(1.0);
    let f = clamp(freq, 1.0, fs * 0.49);
    let qq = clamp(q, 0.05, 24.0);
    let a = 10f64.powf(gain_db / 40.0);
    let w0 = (2.0 * std::f64::consts::PI * f) / fs;
    let cos = w0.cos();
    let sin = w0.sin();
    let octave = (2.0 / std::f64::consts::LN_2) * (1.0 / (2.0 * qq)).asinh();
    let warp = (w0 / sin.max(1e-4)).min(2.2);
    let alpha = if kind == BiquadKind::Peaking {
        sin * ((std::f64::consts::LN_2 / 2.0) * octave * warp).sinh()
    } else {
        sin / (2.0 * qq)
    };
    let (b0, b1, b2, a0, a1, a2) = match kind {
        BiquadKind::Lowpass => {
            let b0 = (1.0 - cos) / 2.0;
            let b1 = 1.0 - cos;
            let b2 = (1.0 - cos) / 2.0;
            (b0, b1, b2, 1.0 + alpha, -2.0 * cos, 1.0 - alpha)
        }
        BiquadKind::Highpass => {
            let b0 = (1.0 + cos) / 2.0;
            let b1 = -(1.0 + cos);
            let b2 = (1.0 + cos) / 2.0;
            (b0, b1, b2, 1.0 + alpha, -2.0 * cos, 1.0 - alpha)
        }
        BiquadKind::Bandpass => (alpha, 0.0, -alpha, 1.0 + alpha, -2.0 * cos, 1.0 - alpha),
        BiquadKind::Peaking => (
            1.0 + alpha * a,
            -2.0 * cos,
            1.0 - alpha * a,
            1.0 + alpha / a,
            -2.0 * cos,
            1.0 - alpha / a,
        ),
        BiquadKind::Lowshelf => {
            let beta = a.sqrt() / qq;
            (
                a * (a + 1.0 - (a - 1.0) * cos + beta * sin),
                2.0 * a * (a - 1.0 - (a + 1.0) * cos),
                a * (a + 1.0 - (a - 1.0) * cos - beta * sin),
                a + 1.0 + (a - 1.0) * cos + beta * sin,
                -2.0 * (a - 1.0 + (a + 1.0) * cos),
                a + 1.0 + (a - 1.0) * cos - beta * sin,
            )
        }
        BiquadKind::Highshelf => {
            let beta = a.sqrt() / qq;
            (
                a * (a + 1.0 + (a - 1.0) * cos + beta * sin),
                -2.0 * a * (a - 1.0 + (a + 1.0) * cos),
                a * (a + 1.0 + (a - 1.0) * cos - beta * sin),
                a + 1.0 - (a - 1.0) * cos + beta * sin,
                2.0 * (a - 1.0 - (a + 1.0) * cos),
                a + 1.0 - (a - 1.0) * cos - beta * sin,
            )
        }
    };
    Biquad {
        b0: b0 / a0,
        b1: b1 / a0,
        b2: b2 / a0,
        a1: a1 / a0,
        a2: a2 / a0,
        ..Biquad::default()
    }
}

#[inline]
pub fn tick(filter: &mut Biquad, x: f64) -> f64 {
    let y = filter.b0 * x + filter.b1 * filter.x1 + filter.b2 * filter.x2
        - filter.a1 * filter.y1
        - filter.a2 * filter.y2;
    filter.x2 = filter.x1;
    filter.x1 = x;
    filter.y2 = filter.y1;
    filter.y1 = y;
    y
}

/// Flush non-finite samples and denormals. Filter state keeps the raw value,
/// matching `sanitize` which is applied only when the sample is stored.
pub fn sanitize(sample: f64) -> f64 {
    if !sample.is_finite() || sample.abs() < 1e-15 {
        0.0
    } else {
        sample
    }
}

fn clamp(value: f64, min: f64, max: f64) -> f64 {
    if !value.is_finite() {
        min
    } else {
        value.clamp(min, max)
    }
}
