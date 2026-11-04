//! Proves `process_block` does not hit the allocator. The counter is armed only
//! around the audio callback. `prepare` is allowed to allocate.

use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::Cell;

use cueharbor_dsp::{AudioBlock, CuePlugin, EqProcessor, NativePlugin, VoiceEngine, Vintage, PLUGIN_COMP, PLUGIN_LIMIT, PLUGIN_REVERB, EMPTY_MIDI, SP1200_BITS, SP1200_RATE};

thread_local! {
    static ARMED: Cell<bool> = const { Cell::new(false) };
    static ALLOCS: Cell<usize> = const { Cell::new(0) };
}

fn arm() {
    ALLOCS.with(|count| count.set(0));
    ARMED.with(|flag| flag.set(true));
}

fn disarm() -> usize {
    ARMED.with(|flag| flag.set(false));
    ALLOCS.with(|count| count.get())
}

fn allocs() -> usize {
    ALLOCS.with(|count| count.get())
}

struct Guard;

unsafe impl GlobalAlloc for Guard {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        if layout.size() != 0 {
            let _ = ARMED.try_with(|flag| {
                if flag.get() {
                    let _ = ALLOCS.try_with(|count| count.set(count.get() + 1));
                }
            });
        }
        System.alloc(layout)
    }

    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        System.dealloc(ptr, layout)
    }

    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        if new_size != 0 {
            let _ = ARMED.try_with(|flag| {
                if flag.get() {
                    let _ = ALLOCS.try_with(|count| count.set(count.get() + 1));
                }
            });
        }
        System.realloc(ptr, layout, new_size)
    }
}

#[global_allocator]
static GLOBAL: Guard = Guard;

#[test]
fn process_block_does_not_allocate() {
    let mut eq = EqProcessor::new();
    eq.prepare(48_000.0, 512);
    eq.set_parameter(7, 6.0);
    eq.set_state(&eq.get_state());
    let mut left = vec![0f32; 512];
    let mut right = vec![0f32; 512];
    for index in 0..left.len() {
        let sample = (index as f32 * 0.07).sin() * 0.4;
        left[index] = sample;
        right[index] = sample * 0.5;
    }

    arm();
    for block in 0..8 {
        if block == 3 {
            eq.set_parameter(4, -4.0);
            eq.set_parameter(6, 900.0);
        }
        let start = block * 64;
        let mut audio = AudioBlock {
            channels: [&mut left[start..start + 64], &mut right[start..start + 64]],
            num_channels: 2,
            num_samples: 64,
        };
        eq.process_block(&mut audio, &EMPTY_MIDI);
    }
    eq.reset();
    let mut audio = AudioBlock {
        channels: [&mut left[..128], &mut right[..128]],
        num_channels: 2,
        num_samples: 128,
    };
    eq.process_block(&mut audio, &EMPTY_MIDI);
    let allocations = disarm();
    assert_eq!(allocations, 0);
}

#[test]
fn insert_process_does_not_allocate() {
    let mut plugins = [
        CuePlugin::new(PLUGIN_COMP, 48_000.0),
        CuePlugin::new(PLUGIN_REVERB, 48_000.0),
        CuePlugin::new(PLUGIN_LIMIT, 48_000.0),
    ];
    for plugin in &mut plugins {
        plugin.prepare(48_000.0, 256);
        plugin.set_parameter(5, 0.35);
    }
    let mut left = vec![0.2f32; 256];
    let mut right = vec![-0.1f32; 256];
    for (index, plugin) in plugins.iter_mut().enumerate() {
        arm();
        plugin.set_parameter(1, -12.0);
        let mut audio = AudioBlock {
            channels: [&mut left, &mut right],
            num_channels: 2,
            num_samples: 128,
        };
        plugin.process_block(&mut audio, &EMPTY_MIDI);
        let during_process = allocs();
        plugin.reset();
        let during_reset = disarm();
        assert_eq!(during_process, 0, "plugin {index} allocated in process");
        assert_eq!(during_reset, 0, "plugin {index} allocated in reset");
    }
}

#[test]
fn voice_process_does_not_allocate() {
    let mut engine = VoiceEngine::new(48_000.0);
    engine.prepare(48_000.0, 128);
    let mut data = vec![0.0f32; 4_000];
    for (index, sample) in data.iter_mut().enumerate() {
        *sample = ((index as f32) * 0.05).sin() * 0.4;
    }
    engine.load_sample(1, &data, 48_000.0);
    for pad in 0..8 {
        engine.set_region(pad, 1, pad * 400, pad * 400 + 400);
        engine.set_pitch(pad, pad as f64 - 4.0, 15.0, pad % 2 == 0);
        engine.set_vintage(pad, Vintage {
            bit_depth: SP1200_BITS,
            sample_rate: SP1200_RATE,
            wow: 0.2,
            flutter: 0.1,
            noise: 0.05,
            crackle: 0.02,
            lowpass: 8_000.0,
        });
        engine.set_filter(pad, 40.0, 12_000.0);
        engine.set_choke_group(pad, 1);
        engine.set_reverse(pad, pad == 3);
        engine.set_hold(pad, pad == 1);
        engine.set_swing(pad, 4);
    }
    let mut left = vec![0.0f32; 128];
    let mut right = vec![0.0f32; 128];
    arm();
    for pad in 0..8 {
        engine.note(pad * 2, pad, 0.8);
    }
    engine.process(&mut left, &mut right);
    engine.note(10, 1, 0.0);
    engine.process(&mut left, &mut right);
    engine.reset();
    let allocations = disarm();
    assert_eq!(allocations, 0);
}
