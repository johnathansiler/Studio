#!/usr/bin/env python3
"""Convert a library to 48 kHz, 24-bit, stereo PCM WAV.

The phone plays this format without a second resampler. Android Chrome follows
the device, and that device is 48 kHz. 24-bit sources stay 24-bit. 16-bit
sources are padded up. Nothing is peak-normalized.

Resampling is libsoxr VHQ. After a rate change the float samples are quantized
with triangular dither at the 24-bit step. A file that is already 48 kHz
24-bit stereo WAV is copied. Duration in seconds is unchanged, so a loop's
BPM stays the same. The sample count changes with the rate.

  python3 scripts/standardize-library.py --check
  python3 scripts/standardize-library.py --inventory catalogs/soundscout-2026-11-17-4.json
  python3 scripts/standardize-library.py --root /path/to/audio --out /path/to/wav48 --catalog catalog.json.gz

Does not upload anywhere. Converted audio is written only under --out.
"""

from __future__ import annotations

import argparse
import gzip
import json
import struct
import sys
from collections import Counter
from pathlib import Path

RATE = 48000
BITS = 24
CHANNELS = 2

try:
    import numpy as np
    import soxr
except ImportError as exc:  # pragma: no cover
    sys.stderr.write('This script needs numpy and soxr (pip install numpy soxr).\n')
    raise SystemExit(1) from exc


def read_wav(path: Path):
    raw = path.read_bytes()
    if raw[0:4] != b'RIFF' or raw[8:12] != b'WAVE':
        raise ValueError(f'{path} is not a PCM WAV')
    offset = 12
    sample_rate = channels = bits = format_code = 0
    data = b''
    while offset + 8 <= len(raw):
        chunk = raw[offset:offset + 4]
        size = struct.unpack_from('<I', raw, offset + 4)[0]
        body = raw[offset + 8:offset + 8 + size]
        if chunk == b'fmt ':
            format_code, channels, sample_rate, _, _, bits = struct.unpack_from('<HHIIHH', body)
            if format_code == 0xFFFE and len(body) >= 40:
                format_code = struct.unpack_from('<H', body, 24)[0]
        elif chunk == b'data':
            data = body
            break
        offset += 8 + size + (size & 1)
    if not data or not sample_rate or not channels:
        raise ValueError(f'{path} has no PCM data')
    frames = len(data) // (channels * (bits // 8))
    if format_code == 3 and bits == 32:
        samples = np.frombuffer(data, dtype='<f4', count=frames * channels).astype(np.float64)
        exact = None
    elif bits == 16:
        codes = np.frombuffer(data, dtype='<i2', count=frames * channels).astype(np.int32)
        samples = np.where(codes < 0, codes / 32768.0, codes / 32767.0)
        exact = codes
    elif bits == 24:
        packed = np.frombuffer(data, dtype=np.uint8, count=frames * channels * 3).reshape(-1, 3)
        codes = packed[:, 0].astype(np.int32) | (packed[:, 1].astype(np.int32) << 8) | (packed[:, 2].astype(np.int32) << 16)
        codes = np.where(codes >= 0x800000, codes - 0x1000000, codes)
        samples = np.where(codes < 0, codes / 8388608.0, codes / 8388607.0)
        exact = codes
    elif bits == 32 and format_code == 1:
        codes = np.frombuffer(data, dtype='<i4', count=frames * channels).astype(np.float64)
        samples = codes / 2147483648.0
        exact = None
    else:
        raise ValueError(f'{path} is {bits}-bit format {format_code}, not PCM WAV')
    audio = samples.reshape(frames, channels)
    return {
        'rate': sample_rate,
        'bits': bits,
        'channels': channels,
        'audio': audio,
        'exact': exact,
    }


def write_wav_24(path: Path, audio: np.ndarray, dither: bool):
    frames, channels = audio.shape
    if channels != CHANNELS:
        raise ValueError('the standard file is stereo')
    shaped = audio.astype(np.float64, copy=True)
    if dither:
        quantum = 1.0 / 8388607.0
        noise = (np.random.random(shaped.shape) - np.random.random(shaped.shape)) * quantum
        shaped = np.clip(shaped + noise, -1.0, 1.0 - 1.0 / 8388607.0)
    else:
        shaped = np.clip(shaped, -1.0, 1.0 - 1.0 / 8388607.0)
    neg = shaped < 0
    codes = np.empty(shaped.shape, dtype=np.int32)
    codes[neg] = np.trunc(shaped[neg] * 8388608.0).astype(np.int32)
    codes[~neg] = np.trunc(shaped[~neg] * 8388607.0).astype(np.int32)
    codes = np.clip(codes, -8388608, 8388607).astype(np.uint32) & 0xFFFFFF
    packed = np.empty((frames * channels, 3), dtype=np.uint8)
    flat = codes.reshape(-1)
    packed[:, 0] = flat & 0xFF
    packed[:, 1] = (flat >> 8) & 0xFF
    packed[:, 2] = (flat >> 16) & 0xFF
    data = packed.tobytes()
    block = CHANNELS * 3
    header = struct.pack(
        '<4sI4s4sIHHIIHH4sI',
        b'RIFF', 36 + len(data), b'WAVE', b'fmt ', 16, 1, CHANNELS, RATE, RATE * block, block, BITS, b'data', len(data),
    )
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(header + data)


def to_stereo(audio: np.ndarray) -> np.ndarray:
    if audio.shape[1] == 1:
        return np.repeat(audio, 2, axis=1)
    if audio.shape[1] == 2:
        return audio
    # More than two channels: keep the first pair. A later channel is not mixed in.
    return audio[:, :2].copy()


def convert_audio(info: dict) -> tuple[np.ndarray, str]:
    audio = to_stereo(info['audio'])
    if info['rate'] == RATE and info['bits'] == BITS and info['channels'] == CHANNELS and info['exact'] is not None:
        return audio, 'copy'
    if info['rate'] == RATE:
        return audio, 'pad' if info['bits'] < BITS else 'quantize'
    converted = np.column_stack([
        soxr.resample(audio[:, index], info['rate'], RATE, quality='VHQ')
        for index in range(audio.shape[1])
    ])
    return converted, 'soxr-vhq'


def convert_file(src: Path, dest: Path) -> dict:
    info = read_wav(src)
    audio, how = convert_audio(info)
    dither = how == 'soxr-vhq'
    if how == 'copy':
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(src.read_bytes())
    else:
        write_wav_24(dest, audio, dither)
    seconds_in = info['audio'].shape[0] / info['rate']
    seconds_out = audio.shape[0] / RATE
    return {
        'source': str(src),
        'output': str(dest),
        'how': how,
        'from': {'rate': info['rate'], 'bits': info['bits'], 'channels': info['channels']},
        'to': {'rate': RATE, 'bits': BITS, 'channels': CHANNELS, 'frames': int(audio.shape[0])},
        'secondsIn': seconds_in,
        'secondsOut': seconds_out,
        'durationDeltaMs': (seconds_out - seconds_in) * 1000,
        'peakIn': float(np.max(np.abs(info['audio']))),
        'peakOut': float(np.max(np.abs(audio))),
    }


def load_catalog(path: Path):
    raw = path.read_bytes()
    if path.suffix == '.gz' or raw[:2] == b'\x1f\x8b':
        text = gzip.decompress(raw).decode('utf-8')
        gzipped = True
    else:
        text = raw.decode('utf-8')
        gzipped = False
    return json.loads(text), gzipped


def inventory_catalog(path: Path) -> dict:
    doc, _ = load_catalog(path)
    entries = doc.get('entries') or []
    counts: Counter = Counter()
    crunch = Counter()
    for entry in entries:
        rate = entry.get('sampleRate') or entry.get('sample_rate')
        bits = entry.get('bitDepth') or entry.get('bit_depth')
        channels = entry.get('channels')
        key = entry.get('path') or entry.get('key') or ''
        ext = key.rsplit('.', 1)[-1].lower() if '.' in key else entry.get('format') or '?'
        kind = (ext, rate, bits, channels)
        counts[kind] += 1
        category = (entry.get('category') or '').lower()
        if category in {'bass', '808'}:
            crunch[kind] += 1
    return {'entries': len(entries), 'groups': counts, 'bassLike': crunch}


def print_inventory(summary: dict):
    print(f"entries {summary['entries']}")
    print('format, rate, bits, channels, count')
    for key, count in sorted(summary['groups'].items(), key=lambda item: -item[1]):
        ext, rate, bits, channels = key
        mark = ''
        if summary['bassLike'].get(key):
            mark = f"  category bass/808 {summary['bassLike'][key]}"
        print(f'  {count:5d}  {ext}  {rate} Hz  {bits}-bit  ch {channels}{mark}')


def thd(buf: np.ndarray, freq: float, rate: int) -> float:
    start = int(rate * 0.1)
    n = 8192
    frame = buf[start:start + n]
    i = np.arange(n)
    w = 2 * np.pi * freq / rate
    s = np.sin(w * i)
    c = np.cos(w * i)
    aa = np.dot(s, s)
    bb = np.dot(s, c)
    cc = np.dot(c, c)
    dd = np.dot(frame, s)
    ee = np.dot(frame, c)
    det = aa * cc - bb * bb
    sine_a = (dd * cc - bb * ee) / det
    cosine = (aa * ee - bb * dd) / det
    err = frame - (sine_a * s + cosine * c)
    return float(np.sqrt(np.mean(err * err) / np.mean(frame * frame)))


def transparency() -> dict:
    n = 44100
    sine = 0.5 * np.sin(2 * np.pi * 55 * np.arange(n) / 44100)
    up = soxr.resample(sine, 44100, 48000, quality='VHQ')
    back = soxr.resample(up, 48000, 44100, quality='VHQ')
    a = sine[2000:-2000]
    b = back[2000:2000 + len(a)]
    gain = float(np.dot(a, b) / np.dot(b, b))
    null = float(np.sqrt(np.mean((a - gain * b) ** 2) / np.mean(a * a)))
    high = 0.5 * np.sin(2 * np.pi * 1000 * np.arange(96000) / 96000)
    ultra = 0.5 * np.sin(2 * np.pi * 30000 * np.arange(96000) / 96000)
    high_out = soxr.resample(high, 96000, 48000, quality='VHQ')
    ultra_out = soxr.resample(ultra, 96000, 48000, quality='VHQ')
    leaked = float(np.sqrt(np.mean(ultra_out[4000:-4000] ** 2)))
    return {
        'resampler': 'soxr VHQ',
        'sine55_44100_to_48000_thd': thd(up, 55, 48000),
        'roundtrip_null_ratio': null,
        'roundtrip_null_db': 20 * np.log10(null + 1e-20),
        'sine1k_96000_to_48000_thd': thd(high_out, 1000, 48000),
        'sine30k_96000_to_48000_rms': leaked,
        'sine30k_rejection_db': 20 * np.log10(leaked + 1e-20),
    }


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description='Standardize library audio to 48 kHz 24-bit stereo WAV')
    parser.add_argument('--check', action='store_true', help='Print soxr VHQ transparency and exit')
    parser.add_argument('--inventory', type=Path, help='Catalog JSON or JSON.GZ to count')
    parser.add_argument('--root', type=Path, help='Directory of source WAV files')
    parser.add_argument('--out', type=Path, help='Directory for converted WAV files')
    parser.add_argument('--catalog', type=Path, help='Optional catalog to rewrite next to the output')
    args = parser.parse_args(argv)
    if args.check:
        report = transparency()
        print(json.dumps(report, indent=2))
        return 0
    if args.inventory:
        print_inventory(inventory_catalog(args.inventory))
        return 0
    if not args.root or not args.out:
        parser.error('pass --check, --inventory, or both --root and --out')
    rows = []
    for src in sorted(args.root.rglob('*.wav')):
        rel = src.relative_to(args.root)
        dest = args.out / rel
        rows.append(convert_file(src, dest))
    report_path = args.out / 'standardize-report.json'
    report_path.write_text(json.dumps({'rate': RATE, 'bits': BITS, 'channels': CHANNELS, 'files': rows}, indent=2))
    print(f'converted {len(rows)} files into {args.out}')
    if args.catalog:
        doc, gzipped = load_catalog(args.catalog)
        by_name = {Path(row['source']).name: row for row in rows}
        for entry in doc.get('entries') or []:
            key = entry.get('key') or entry.get('path') or ''
            hit = by_name.get(Path(key).name)
            if not hit:
                continue
            entry['format'] = 'wav'
            entry['sampleRate'] = RATE
            entry['bitDepth'] = BITS
            entry['channels'] = CHANNELS
            entry['size'] = Path(hit['output']).stat().st_size
            if 'durationSec' in entry:
                entry['durationSec'] = hit['secondsOut']
            if isinstance(entry.get('key'), str):
                entry['key'] = str(Path(entry['key']).with_suffix('.wav'))
            if isinstance(entry.get('path'), str):
                entry['path'] = str(Path(entry['path']).with_suffix('.wav'))
        payload = json.dumps(doc).encode('utf-8')
        dest_catalog = args.out / args.catalog.name
        if gzipped or args.catalog.suffix == '.gz':
            dest_catalog.write_bytes(gzip.compress(payload))
        else:
            dest_catalog.write_bytes(payload)
        print(f'catalog {dest_catalog}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main(sys.argv[1:]))
