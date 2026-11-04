//! The built-in synth voice from `dispatch.ts`, including sample-offset notes.

use crate::util::store;

#[derive(Clone, Copy)]
pub struct Note {
    pub offset: u32,
    pub pitch: f64,
    pub vel: f64,
}

pub struct Synth {
    pitch: f64,
    vel: f64,
    env: f64,
    phase: f64,
}

impl Synth {
    pub fn new() -> Self {
        Self { pitch: 60.0, vel: 0.0, env: 0.0, phase: 0.0 }
    }
    pub fn reset(&mut self) {
        self.vel = 0.0;
        self.env = 0.0;
        self.phase = 0.0;
    }
    pub fn note(&mut self, pitch: f64, vel: f64) {
        self.pitch = pitch.clamp(0.0, 127.0);
        self.vel = vel.clamp(0.0, 1.0);
    }
    pub fn process(&mut self, left: &mut [f32], right: &mut [f32], frames: usize, sample_rate: f64, notes: &[Note]) {
        if notes.is_empty() {
            self.render(left, right, 0, frames, sample_rate);
            return;
        }
        let mut cursor = 0;
        let mut index = 0;
        while cursor < frames {
            while index < notes.len() && notes[index].offset as usize <= cursor {
                self.note(notes[index].pitch, notes[index].vel);
                index += 1;
            }
            let end = if index < notes.len() {
                (notes[index].offset as usize).clamp(cursor + 1, frames)
            } else {
                frames
            };
            if end > cursor {
                self.render(left, right, cursor, end, sample_rate);
            }
            cursor = end;
        }
    }
    fn render(&mut self, left: &mut [f32], right: &mut [f32], start: usize, end: usize, sample_rate: f64) {
        let step = (2.0 * std::f64::consts::PI * 440.0 * 2f64.powf((self.pitch - 69.0) / 12.0)) / sample_rate;
        for i in start..end {
            let dry_l = left[i] as f64;
            let dry_r = right[i] as f64;
            if self.vel <= 0.0 && self.env <= 1e-5 {
                self.env = 0.0;
                left[i] = store(dry_l);
                right[i] = store(dry_r);
                continue;
            }
            let follow = if self.vel > self.env { 0.25 } else { 0.04 };
            self.env += (self.vel - self.env) * follow;
            if self.env < 1e-5 {
                self.env = 0.0;
            }
            let sample = if self.env > 0.0 { self.phase.sin() * self.env * 0.35 } else { 0.0 };
            self.phase += step;
            if self.phase > std::f64::consts::PI * 2.0 {
                self.phase -= std::f64::consts::PI * 2.0;
            }
            left[i] = store(dry_l + sample);
            right[i] = store(dry_r + sample);
        }
    }
}

impl Default for Synth {
    fn default() -> Self {
        Self::new()
    }
}
