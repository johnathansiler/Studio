//! Proves `process_block` does not hit the allocator. The counter is armed only
//! around the audio callback. `prepare` is allowed to allocate.

use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;

static TEST_LOCK: Mutex<()> = Mutex::new(());

use cueharbor_dsp::{AudioBlock, CuePlugin, EqProcessor, NativePlugin, PLUGIN_COMP, PLUGIN_LIMIT, PLUGIN_REVERB, EMPTY_MIDI};

static ARMED: AtomicUsize = AtomicUsize::new(0);
static ALLOCS: AtomicUsize = AtomicUsize::new(0);

struct Guard;

unsafe impl GlobalAlloc for Guard {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        if ARMED.load(Ordering::SeqCst) == 1 && layout.size() != 0 {
            ALLOCS.fetch_add(1, Ordering::SeqCst);
        }
        System.alloc(layout)
    }

    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        System.dealloc(ptr, layout)
    }

    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        if ARMED.load(Ordering::SeqCst) == 1 && new_size != 0 {
            ALLOCS.fetch_add(1, Ordering::SeqCst);
        }
        System.realloc(ptr, layout, new_size)
    }
}

#[global_allocator]
static GLOBAL: Guard = Guard;

#[test]
fn process_block_does_not_allocate() {
    let _guard = TEST_LOCK.lock().unwrap();
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

    ARMED.store(1, Ordering::SeqCst);
    ALLOCS.store(0, Ordering::SeqCst);
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
    let allocations = ALLOCS.load(Ordering::SeqCst);
    ARMED.store(0, Ordering::SeqCst);
    assert_eq!(allocations, 0);
}

#[test]
fn insert_process_does_not_allocate() {
    let _guard = TEST_LOCK.lock().unwrap();
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
        ARMED.store(1, Ordering::SeqCst);
        ALLOCS.store(0, Ordering::SeqCst);
        plugin.set_parameter(1, -12.0);
        let mut audio = AudioBlock {
            channels: [&mut left, &mut right],
            num_channels: 2,
            num_samples: 128,
        };
        plugin.process_block(&mut audio, &EMPTY_MIDI);
        let during_process = ALLOCS.load(Ordering::SeqCst);
        plugin.reset();
        let during_reset = ALLOCS.load(Ordering::SeqCst);
        ARMED.store(0, Ordering::SeqCst);
        assert_eq!(during_process, 0, "plugin {index} allocated in process");
        assert_eq!(during_reset, 0, "plugin {index} allocated in reset");
    }
}
