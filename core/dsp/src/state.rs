//! Versioned parameter blob. Same shape as `encodeState` in `src/audio/core/adapt.ts`:
//! `{"v":1,"params":{"hp":20,...}}`.

use ryu::Buffer;

use crate::eq::CONTROLS;

pub fn write_state(out: &mut [u8], values: &[f64]) -> usize {
    let mut cursor = 0;
    if !push(out, &mut cursor, b"{\"v\":1,\"params\":{") {
        return 0;
    }
    for (index, control) in CONTROLS.iter().enumerate() {
        if index > 0 && !push(out, &mut cursor, b",") {
            return 0;
        }
        if !push(out, &mut cursor, b"\"")
            || !push(out, &mut cursor, control.key.as_bytes())
            || !push(out, &mut cursor, b"\":")
        {
            return 0;
        }
        let value = values.get(index).copied().unwrap_or(control.default_value);
        if !write_number(out, &mut cursor, value) {
            return 0;
        }
    }
    if !push(out, &mut cursor, b"}}") {
        return 0;
    }
    cursor
}

#[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
pub fn write_layout(out: &mut [u8]) -> usize {
    let mut cursor = 0;
    if !push(
        out,
        &mut cursor,
        b"{\"id\":\"eq\",\"name\":\"EQ\",\"version\":\"2\",\"controls\":[",
    ) {
        return 0;
    }
    for (index, control) in CONTROLS.iter().enumerate() {
        if index > 0 && !push(out, &mut cursor, b",") {
            return 0;
        }
        if !push(out, &mut cursor, b"{\"paramId\":") {
            return 0;
        }
        if !write_number(out, &mut cursor, control.param_id as f64) {
            return 0;
        }
        if !push(out, &mut cursor, b",\"key\":\"")
            || !push(out, &mut cursor, control.key.as_bytes())
            || !push(out, &mut cursor, b"\",\"name\":\"")
            || !push(out, &mut cursor, control.name.as_bytes())
            || !push(out, &mut cursor, b"\",\"min\":")
        {
            return 0;
        }
        if !write_number(out, &mut cursor, control.min) {
            return 0;
        }
        if !push(out, &mut cursor, b",\"max\":") || !write_number(out, &mut cursor, control.max) {
            return 0;
        }
        if !push(out, &mut cursor, b",\"defaultValue\":")
            || !write_number(out, &mut cursor, control.default_value)
        {
            return 0;
        }
        if !push(out, &mut cursor, b",\"unit\":\"")
            || !push(out, &mut cursor, control.unit.as_bytes())
            || !push(out, &mut cursor, b"\",\"automatable\":")
            || !push(
                out,
                &mut cursor,
                if control.automatable {
                    b"true"
                } else {
                    b"false"
                },
            )
            || !push(out, &mut cursor, b"}")
        {
            return 0;
        }
    }
    if !push(out, &mut cursor, b"]}") {
        return 0;
    }
    cursor
}

/// Read a version-1 blob. Missing keys keep `values`. A bad version or a bad
/// number leaves `values` untouched and returns false.
pub fn read_state(data: &[u8], values: &mut [f64]) -> bool {
    let Ok(json) = std::str::from_utf8(data) else {
        return false;
    };
    if !version_one(json) || !json.contains("\"params\"") {
        return false;
    }
    let mut next = [0.0; 64];
    let count = values.len().min(CONTROLS.len()).min(next.len());
    next[..count].copy_from_slice(&values[..count]);
    for index in 0..count {
        if let Some(text) = find_number(json, CONTROLS[index].key) {
            let Ok(parsed) = text.parse::<f64>() else {
                return false;
            };
            if !parsed.is_finite() {
                return false;
            }
            next[index] = parsed;
        }
    }
    values[..count].copy_from_slice(&next[..count]);
    true
}

fn version_one(json: &str) -> bool {
    let Some(text) = find_number(json, "v") else {
        return false;
    };
    matches!(text.parse::<f64>(), Ok(value) if value == 1.0)
}

fn find_number<'a>(json: &'a str, key: &str) -> Option<&'a str> {
    let bytes = json.as_bytes();
    let key_bytes = key.as_bytes();
    let mut index = 0;
    while index + key_bytes.len() + 2 <= bytes.len() {
        let quoted = bytes[index] == b'"'
            && bytes[index + 1..].starts_with(key_bytes)
            && bytes.get(index + 1 + key_bytes.len()) == Some(&b'"');
        if quoted {
            let mut cursor = index + key_bytes.len() + 2;
            while bytes.get(cursor).is_some_and(u8::is_ascii_whitespace) {
                cursor += 1;
            }
            if bytes.get(cursor) == Some(&b':') {
                cursor += 1;
                while bytes.get(cursor).is_some_and(u8::is_ascii_whitespace) {
                    cursor += 1;
                }
                let start = cursor;
                while cursor < bytes.len() && bytes[cursor] != b',' && bytes[cursor] != b'}' {
                    cursor += 1;
                }
                let text = std::str::from_utf8(&bytes[start..cursor]).ok()?.trim();
                if !text.is_empty() {
                    return Some(text);
                }
            }
        }
        index += 1;
    }
    None
}

fn write_number(out: &mut [u8], cursor: &mut usize, value: f64) -> bool {
    if !value.is_finite() || value == 0.0 {
        return push(out, cursor, b"0");
    }
    let nearest = value.round();
    if (value - nearest).abs() < 1e-10 && nearest.abs() < 1e15 {
        return write_i64(out, cursor, nearest as i64);
    }
    let mut buffer = Buffer::new();
    push(out, cursor, buffer.format(value).as_bytes())
}

fn write_i64(out: &mut [u8], cursor: &mut usize, value: i64) -> bool {
    if value < 0 && !push(out, cursor, b"-") {
        return false;
    }
    let magnitude = (value as i128).unsigned_abs();
    let mut digits = [0u8; 20];
    let mut count = 0;
    let mut rest = magnitude;
    if rest == 0 {
        return push(out, cursor, b"0");
    }
    while rest > 0 {
        digits[count] = b'0' + (rest % 10) as u8;
        rest /= 10;
        count += 1;
    }
    while count > 0 {
        count -= 1;
        if !push(out, cursor, &digits[count..count + 1]) {
            return false;
        }
    }
    true
}

fn push(out: &mut [u8], cursor: &mut usize, bytes: &[u8]) -> bool {
    if *cursor + bytes.len() > out.len() {
        return false;
    }
    out[*cursor..*cursor + bytes.len()].copy_from_slice(bytes);
    *cursor += bytes.len();
    true
}
