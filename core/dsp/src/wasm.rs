//! C ABI for the EQ. The host writes samples into buffers reserved by `prepare`,
//! then calls `ch_eq_process`. That call does not grow those buffers.

use crate::contract::{AudioBlock, NativePlugin, EMPTY_MIDI};
use crate::eq::EqProcessor;
use crate::plugin::CuePlugin;
use crate::smooth::glide_block;
use crate::state::write_layout;

const STATE_CAP: usize = 16384;
const MAX_BLOCK: usize = 8192;

struct WasmEq {
    eq: EqProcessor,
    left: Vec<f32>,
    right: Vec<f32>,
    state: Vec<u8>,
    max_block: usize,
}

impl WasmEq {
    fn new() -> Self {
        Self {
            eq: EqProcessor::new(),
            left: Vec::new(),
            right: Vec::new(),
            state: vec![0; STATE_CAP],
            max_block: 0,
        }
    }
}

fn eq_mut<'a>(ptr: *mut WasmEq) -> Option<&'a mut WasmEq> {
    if ptr.is_null() {
        None
    } else {
        Some(unsafe { &mut *ptr })
    }
}

#[no_mangle]
pub extern "C" fn ch_eq_create() -> *mut WasmEq {
    Box::into_raw(Box::new(WasmEq::new()))
}

#[no_mangle]
pub extern "C" fn ch_eq_destroy(ptr: *mut WasmEq) {
    if !ptr.is_null() {
        unsafe { drop(Box::from_raw(ptr)) }
    }
}

#[no_mangle]
pub extern "C" fn ch_eq_prepare(ptr: *mut WasmEq, sample_rate: f64, max_block: u32) {
    let Some(plugin) = eq_mut(ptr) else { return };
    let frames = (max_block as usize).clamp(1, MAX_BLOCK);
    plugin.left.resize(frames, 0.0);
    plugin.right.resize(frames, 0.0);
    if plugin.state.len() < STATE_CAP {
        plugin.state.resize(STATE_CAP, 0);
    }
    plugin.max_block = frames;
    plugin.eq.prepare(sample_rate, frames);
}

#[no_mangle]
pub extern "C" fn ch_eq_release(ptr: *mut WasmEq) {
    if let Some(plugin) = eq_mut(ptr) {
        plugin.eq.release();
    }
}

#[no_mangle]
pub extern "C" fn ch_eq_reset(ptr: *mut WasmEq) {
    if let Some(plugin) = eq_mut(ptr) {
        plugin.eq.reset();
    }
}

#[no_mangle]
pub extern "C" fn ch_eq_set_parameter(ptr: *mut WasmEq, param_id: u32, value: f64) {
    if let Some(plugin) = eq_mut(ptr) {
        plugin.eq.set_parameter(param_id, value);
    }
}

#[no_mangle]
pub extern "C" fn ch_eq_get_parameter(ptr: *mut WasmEq, param_id: u32) -> f64 {
    eq_mut(ptr)
        .map(|plugin| plugin.eq.get_parameter(param_id))
        .unwrap_or(0.0)
}

#[no_mangle]
pub extern "C" fn ch_eq_num_parameters(ptr: *mut WasmEq) -> u32 {
    eq_mut(ptr)
        .map(|plugin| plugin.eq.num_parameters())
        .unwrap_or(0)
}

#[no_mangle]
pub extern "C" fn ch_eq_latency(ptr: *mut WasmEq) -> u32 {
    eq_mut(ptr)
        .map(|plugin| plugin.eq.latency_in_samples())
        .unwrap_or(0)
}

/// `channels` is 1 or 2. Frames above the prepared size are ignored.
#[no_mangle]
pub extern "C" fn ch_eq_process(ptr: *mut WasmEq, channels: u32, frames: u32) {
    let Some(plugin) = eq_mut(ptr) else { return };
    let frames = (frames as usize).min(plugin.max_block);
    if frames == 0 || plugin.left.len() < frames || plugin.right.len() < frames {
        return;
    }
    let num_channels = if channels <= 1 { 1 } else { 2 };
    let eq = &mut plugin.eq;
    let left = &mut plugin.left[..frames];
    let right = &mut plugin.right[..frames];
    let mut audio = AudioBlock {
        channels: [left, right],
        num_channels,
        num_samples: frames,
    };
    eq.process_block(&mut audio, &EMPTY_MIDI);
}

#[no_mangle]
pub extern "C" fn ch_eq_channel_ptr(ptr: *mut WasmEq, channel: u32) -> *mut f32 {
    match eq_mut(ptr) {
        Some(plugin) if channel == 0 => plugin.left.as_mut_ptr(),
        Some(plugin) => plugin.right.as_mut_ptr(),
        None => std::ptr::null_mut(),
    }
}

#[no_mangle]
pub extern "C" fn ch_eq_state_ptr(ptr: *mut WasmEq) -> *mut u8 {
    eq_mut(ptr)
        .map(|plugin| plugin.state.as_mut_ptr())
        .unwrap_or(std::ptr::null_mut())
}

#[no_mangle]
pub extern "C" fn ch_eq_get_state(ptr: *mut WasmEq) -> u32 {
    let Some(plugin) = eq_mut(ptr) else { return 0 };
    let bytes = plugin.eq.get_state();
    let length = bytes.len().min(plugin.state.len());
    plugin.state[..length].copy_from_slice(&bytes[..length]);
    length as u32
}

#[no_mangle]
pub extern "C" fn ch_eq_set_state(ptr: *mut WasmEq, len: u32) -> i32 {
    let Some(plugin) = eq_mut(ptr) else { return 0 };
    let length = (len as usize).min(plugin.state.len());
    let mut copy = [0u8; STATE_CAP];
    let length = length.min(STATE_CAP);
    copy[..length].copy_from_slice(&plugin.state[..length]);
    if plugin.eq.set_state(&copy[..length]) {
        1
    } else {
        0
    }
}

#[no_mangle]
pub extern "C" fn ch_eq_layout(ptr: *mut WasmEq) -> u32 {
    let Some(plugin) = eq_mut(ptr) else { return 0 };
    write_layout(&mut plugin.state) as u32
}

#[no_mangle]
pub extern "C" fn ch_glide_block(from: f64, to: f64, frames: u32, rate: f64) -> f64 {
    glide_block(from, to, frames as usize, rate)
}

struct WasmPlug {
    cue: CuePlugin,
    left: Vec<f32>,
    right: Vec<f32>,
    side: Vec<f32>,
    state: Vec<u8>,
    max_block: usize,
}

fn plug_mut<'a>(ptr: *mut WasmPlug) -> Option<&'a mut WasmPlug> {
    if ptr.is_null() {
        None
    } else {
        Some(unsafe { &mut *ptr })
    }
}

#[no_mangle]
pub extern "C" fn ch_plug_create(code: u32) -> *mut WasmPlug {
    Box::into_raw(Box::new(WasmPlug {
        cue: CuePlugin::new(code, 48_000.0),
        left: Vec::new(),
        right: Vec::new(),
        side: Vec::new(),
        state: vec![0; STATE_CAP],
        max_block: 0,
    }))
}

#[no_mangle]
pub extern "C" fn ch_plug_destroy(ptr: *mut WasmPlug) {
    if !ptr.is_null() {
        unsafe { drop(Box::from_raw(ptr)) }
    }
}

#[no_mangle]
pub extern "C" fn ch_plug_prepare(ptr: *mut WasmPlug, sample_rate: f64, max_block: u32) {
    let Some(plugin) = plug_mut(ptr) else { return };
    let frames = (max_block as usize).clamp(1, MAX_BLOCK);
    plugin.left.resize(frames, 0.0);
    plugin.right.resize(frames, 0.0);
    plugin.side.resize(frames, 0.0);
    if plugin.state.len() < STATE_CAP {
        plugin.state.resize(STATE_CAP, 0);
    }
    plugin.max_block = frames;
    plugin.cue.prepare(sample_rate, frames);
}

#[no_mangle]
pub extern "C" fn ch_plug_reset(ptr: *mut WasmPlug) {
    if let Some(plugin) = plug_mut(ptr) {
        plugin.cue.reset();
    }
}

#[no_mangle]
pub extern "C" fn ch_plug_set_param(ptr: *mut WasmPlug, param_id: u32, value: f64) {
    if let Some(plugin) = plug_mut(ptr) {
        plugin.cue.set_parameter(param_id, value);
    }
}

#[no_mangle]
pub extern "C" fn ch_plug_get_param(ptr: *mut WasmPlug, param_id: u32) -> f64 {
    plug_mut(ptr).map(|plugin| plugin.cue.get_parameter(param_id)).unwrap_or(0.0)
}

#[no_mangle]
pub extern "C" fn ch_plug_latency(ptr: *mut WasmPlug) -> u32 {
    plug_mut(ptr).map(|plugin| plugin.cue.latency_in_samples()).unwrap_or(0)
}

#[no_mangle]
pub extern "C" fn ch_plug_set_transport(ptr: *mut WasmPlug, tempo: f64, eco: u32, offline: u32, scale_root: i32) {
    let Some(plugin) = plug_mut(ptr) else { return };
    plugin.cue.tempo = if tempo.is_finite() && tempo > 0.0 { tempo } else { 120.0 };
    plugin.cue.eco = eco != 0;
    plugin.cue.offline = offline != 0;
    plugin.cue.scale_root = scale_root;
}

#[no_mangle]
pub extern "C" fn ch_plug_set_scale_len(ptr: *mut WasmPlug, intervals: u32, cents: u32) {
    let Some(plugin) = plug_mut(ptr) else { return };
    plugin.cue.set_scale_len(intervals as usize, cents as usize);
}

#[no_mangle]
pub extern "C" fn ch_plug_set_interval(ptr: *mut WasmPlug, index: u32, interval: i32) {
    if let Some(plugin) = plug_mut(ptr) {
        plugin.cue.set_interval(index as usize, interval);
    }
}

#[no_mangle]
pub extern "C" fn ch_plug_set_cents(ptr: *mut WasmPlug, index: u32, cents: f64) {
    if let Some(plugin) = plug_mut(ptr) {
        plugin.cue.set_cents(index as usize, cents);
    }
}

#[no_mangle]
pub extern "C" fn ch_plug_note(ptr: *mut WasmPlug, pitch: f64, vel: f64) {
    if let Some(plugin) = plug_mut(ptr) {
        plugin.cue.note(pitch, vel);
    }
}

#[no_mangle]
pub extern "C" fn ch_plug_midi(ptr: *mut WasmPlug, offset: u32, pitch: f64, vel: f64) {
    if let Some(plugin) = plug_mut(ptr) {
        plugin.cue.push_note(offset, pitch, vel);
    }
}

#[no_mangle]
pub extern "C" fn ch_plug_channel_ptr(ptr: *mut WasmPlug, channel: u32) -> *mut f32 {
    match plug_mut(ptr) {
        Some(plugin) if channel == 0 => plugin.left.as_mut_ptr(),
        Some(plugin) if channel == 1 => plugin.right.as_mut_ptr(),
        Some(plugin) => plugin.side.as_mut_ptr(),
        None => std::ptr::null_mut(),
    }
}

#[no_mangle]
pub extern "C" fn ch_plug_process(ptr: *mut WasmPlug, channels: u32, frames: u32, side_frames: u32) {
    let Some(plugin) = plug_mut(ptr) else { return };
    let frames = (frames as usize).min(plugin.max_block);
    if frames == 0 || plugin.left.len() < frames || plugin.right.len() < frames {
        return;
    }
    plugin.cue.side_frames = if side_frames == 0 { 0 } else { frames.min(side_frames as usize) };
    let WasmPlug { cue, left, right, side, .. } = plugin;
    cue.process(&mut left[..frames], &mut right[..frames], &side[..frames.min(side.len())], frames);
    let _ = channels;
}
