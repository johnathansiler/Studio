#![allow(semicolon_in_expressions_from_non_local_macros)]

//! Skeleton VST3 and CLAP shell. It hosts the same EQ as `cueharbor-dsp`.
//! Remote talk and record stays a later step. This binary does not link into the web app.
//!
//! nih-plug itself is ISC. CLAP is MIT. The VST3 feature links `vst3-sys`, which is GPLv3,
//! so a VST3 build of this shell is a GPLv3 binary. `--no-default-features` builds CLAP only.

use std::num::NonZeroU32;
use std::sync::Arc;

use cueharbor_dsp::{AudioBlock, EqProcessor, NativePlugin, EMPTY_MIDI};
use nih_plug::prelude::*;

const PARAMS: usize = 11;
/// Clean-band ids inside the live EQ manifest. `kind` is 0, so HP starts at 1.
const CORE_INDEX: [u32; PARAMS] = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];

struct CueHarborEq {
    params: Arc<EqParams>,
    eq: EqProcessor,
    scratch: Vec<f32>,
    applied: [f32; PARAMS],
}

#[derive(Params)]
struct EqParams {
    #[id = "hp"]
    pub hp: FloatParam,
    #[id = "lp"]
    pub lp: FloatParam,
    #[id = "lowF"]
    pub low_f: FloatParam,
    #[id = "lowG"]
    pub low_g: FloatParam,
    #[id = "lowQ"]
    pub low_q: FloatParam,
    #[id = "midF"]
    pub mid_f: FloatParam,
    #[id = "midG"]
    pub mid_g: FloatParam,
    #[id = "midQ"]
    pub mid_q: FloatParam,
    #[id = "highF"]
    pub high_f: FloatParam,
    #[id = "highG"]
    pub high_g: FloatParam,
    #[id = "highQ"]
    pub high_q: FloatParam,
}

fn hertz(name: &str, default: f32, min: f32, max: f32) -> FloatParam {
    FloatParam::new(name, default, FloatRange::Linear { min, max })
        .with_smoother(SmoothingStyle::None)
        .with_unit(" Hz")
}

fn decibel(name: &str, default: f32, min: f32, max: f32) -> FloatParam {
    FloatParam::new(name, default, FloatRange::Linear { min, max })
        .with_smoother(SmoothingStyle::None)
        .with_unit(" dB")
}

fn plain(name: &str, default: f32, min: f32, max: f32) -> FloatParam {
    FloatParam::new(name, default, FloatRange::Linear { min, max })
        .with_smoother(SmoothingStyle::None)
}

impl Default for EqParams {
    fn default() -> Self {
        Self {
            hp: hertz("HP", 20.0, 20.0, 1000.0),
            lp: hertz("LP", 20000.0, 1000.0, 20000.0),
            low_f: hertz("Low", 180.0, 40.0, 800.0),
            low_g: decibel("Low", 0.0, -18.0, 12.0),
            low_q: plain("Q", 0.7, 0.2, 8.0),
            mid_f: hertz("Mid", 1500.0, 200.0, 8000.0),
            mid_g: decibel("Mid", 0.0, -18.0, 12.0),
            mid_q: plain("Q", 1.0, 0.2, 8.0),
            high_f: hertz("High", 8000.0, 1000.0, 16000.0),
            high_g: decibel("High", 0.0, -18.0, 12.0),
            high_q: plain("Q", 0.7, 0.2, 8.0),
        }
    }
}

impl Default for CueHarborEq {
    fn default() -> Self {
        Self {
            params: Arc::new(EqParams::default()),
            eq: EqProcessor::new(),
            scratch: Vec::new(),
            applied: [f32::NAN; PARAMS],
        }
    }
}

impl CueHarborEq {
    fn values(&self) -> [f32; PARAMS] {
        [
            self.params.hp.value(),
            self.params.lp.value(),
            self.params.low_f.value(),
            self.params.low_g.value(),
            self.params.low_q.value(),
            self.params.mid_f.value(),
            self.params.mid_g.value(),
            self.params.mid_q.value(),
            self.params.high_f.value(),
            self.params.high_g.value(),
            self.params.high_q.value(),
        ]
    }

    fn sync_params(&mut self) {
        let values = self.values();
        for (index, value) in values.iter().enumerate() {
            if *value != self.applied[index] {
                self.applied[index] = *value;
                self.eq.set_parameter(CORE_INDEX[index], *value as f64);
            }
        }
    }

    /// Reserve the mono scratch buffer and snap the core to the current parameters.
    pub fn prepare_audio(&mut self, sample_rate: f64, max_block: usize) {
        let frames = max_block.max(1);
        self.scratch.resize(frames, 0.0);
        self.applied = [f32::NAN; PARAMS];
        self.sync_params();
        self.eq.prepare(sample_rate, frames);
    }

    pub fn process_stereo(&mut self, left: &mut [f32], right: &mut [f32]) {
        self.sync_params();
        let frames = left.len().min(right.len());
        let mut audio = AudioBlock {
            channels: [left, right],
            num_channels: 2,
            num_samples: frames,
        };
        self.eq.process_block(&mut audio, &EMPTY_MIDI);
    }

    fn process_mono(&mut self, left: &mut [f32]) {
        self.sync_params();
        let frames = left.len().min(self.scratch.len());
        if frames == 0 {
            return;
        }
        self.scratch[..frames].fill(0.0);
        let scratch = &mut self.scratch[..frames];
        let eq = &mut self.eq;
        let mut audio = AudioBlock {
            channels: [left, scratch],
            num_channels: 1,
            num_samples: frames,
        };
        eq.process_block(&mut audio, &EMPTY_MIDI);
    }
}

impl Plugin for CueHarborEq {
    const NAME: &'static str = "CueHarbor EQ";
    const VENDOR: &'static str = "CueHarbor";
    const URL: &'static str = "https://cueharbor.onrender.com";
    const EMAIL: &'static str = "";
    const VERSION: &'static str = env!("CARGO_PKG_VERSION");

    const AUDIO_IO_LAYOUTS: &'static [AudioIOLayout] = &[
        AudioIOLayout {
            main_input_channels: NonZeroU32::new(2),
            main_output_channels: NonZeroU32::new(2),
            aux_input_ports: &[],
            aux_output_ports: &[],
            names: PortNames::const_default(),
        },
        AudioIOLayout {
            main_input_channels: NonZeroU32::new(1),
            main_output_channels: NonZeroU32::new(1),
            ..AudioIOLayout::const_default()
        },
    ];

    const MIDI_INPUT: MidiConfig = MidiConfig::None;
    const SAMPLE_ACCURATE_AUTOMATION: bool = true;

    type SysExMessage = ();
    type BackgroundTask = ();

    fn params(&self) -> Arc<dyn Params> {
        self.params.clone()
    }

    fn initialize(
        &mut self,
        _audio_io_layout: &AudioIOLayout,
        buffer_config: &BufferConfig,
        _context: &mut impl InitContext<Self>,
    ) -> bool {
        self.prepare_audio(
            buffer_config.sample_rate as f64,
            buffer_config.max_buffer_size as usize,
        );
        _context.set_latency_samples(self.eq.latency_in_samples());
        true
    }

    fn reset(&mut self) {
        self.eq.reset();
    }

    fn process(
        &mut self,
        buffer: &mut Buffer,
        _aux: &mut AuxiliaryBuffers,
        _context: &mut impl ProcessContext<Self>,
    ) -> ProcessStatus {
        let channels = buffer.channels();
        if channels >= 2 {
            let slice = buffer.as_slice();
            let (first, rest) = slice.split_at_mut(1);
            let frames = first[0].len().min(rest[0].len());
            let left = &mut first[0][..frames];
            let right = &mut rest[0][..frames];
            self.process_stereo(left, right);
        } else if channels == 1 {
            let slice = buffer.as_slice();
            let left = &mut slice[0][..];
            self.process_mono(left);
        }
        ProcessStatus::Normal
    }
}

impl ClapPlugin for CueHarborEq {
    const CLAP_ID: &'static str = "app.cueharbor.eq";
    const CLAP_DESCRIPTION: Option<&'static str> = Some("CueHarbor EQ");
    const CLAP_MANUAL_URL: Option<&'static str> = Some(Self::URL);
    const CLAP_SUPPORT_URL: Option<&'static str> = None;
    const CLAP_FEATURES: &'static [ClapFeature] = &[
        ClapFeature::AudioEffect,
        ClapFeature::Equalizer,
        ClapFeature::Stereo,
        ClapFeature::Mono,
    ];
}

#[cfg(feature = "vst3")]
impl Vst3Plugin for CueHarborEq {
    const VST3_CLASS_ID: [u8; 16] = *b"CueHarborEq00001";
    const VST3_SUBCATEGORIES: &'static [Vst3SubCategory] =
        &[Vst3SubCategory::Fx, Vst3SubCategory::Eq];
}

nih_export_clap!(CueHarborEq);

#[cfg(feature = "vst3")]
nih_export_vst3!(CueHarborEq);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shell_matches_the_shared_eq() {
        let mut shell = CueHarborEq::default();
        shell.prepare_audio(48_000.0, 256);
        let values = shell.values();
        let mut core = EqProcessor::new();
        for (index, value) in values.iter().enumerate() {
            core.set_parameter(CORE_INDEX[index], *value as f64);
        }
        core.prepare(48_000.0, 256);
        let mut left = vec![0f32; 256];
        let mut right = vec![0f32; 256];
        for (index, sample) in left.iter_mut().enumerate() {
            *sample = ((index as f32) * 0.11).sin() * 0.3;
            right[index] = *sample * -0.4;
        }
        let mut core_l = left.clone();
        let mut core_r = right.clone();
        shell.process_stereo(&mut left, &mut right);
        let mut audio = AudioBlock {
            channels: [&mut core_l, &mut core_r],
            num_channels: 2,
            num_samples: 256,
        };
        core.process_block(&mut audio, &EMPTY_MIDI);
        assert_eq!(left, core_l);
        assert_eq!(right, core_r);
        assert_eq!(core.latency_in_samples(), 0);
    }
}
