#!/usr/bin/env python3
"""Reference key estimates for the read-only benchmark.

Reads a manifest of local audio files and writes Essentia (EDMA and
Krumhansl) plus a librosa STFT-chroma + EDMA estimate. Nothing is uploaded
and the CueHarbor detector is not involved.
"""

from __future__ import annotations

import argparse
import csv
import json
import sys
from pathlib import Path

import essentia.standard as es
import librosa
import numpy as np

# Faraldo EDMA profiles, the same published profiles Essentia ships.
EDMA_MAJOR = np.array([1, 0.157808021, 0.366133251, 0.127058867, 0.588516922, 0.332227667, 0.107226417, 0.710546603, 0.15476814, 0.373265925, 0.097658604, 0.443561062])
EDMA_MINOR = np.array([1, 0.150171156, 0.378050852, 0.45244178, 0.139651959, 0.385338478, 0.122140361, 0.696360448, 0.394150762, 0.188959016, 0.200616277, 0.346860558])
NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']


def pearson(a: np.ndarray, b: np.ndarray) -> float:
    if a.std() < 1e-8 or b.std() < 1e-8:
        return 0.0
    return float(np.corrcoef(a, b)[0, 1])


def librosa_edma(path: str, seconds: float) -> tuple[str, float]:
    y, sr = librosa.load(path, sr=22050, mono=True, duration=seconds if seconds > 0 else None)
    if y.size < 2048:
        return '', 0.0
    chroma = librosa.feature.chroma_stft(y=y, sr=sr, n_fft=4096, hop_length=2048)
    mean = chroma.mean(axis=1)
    best_root = 0
    best_minor = False
    best = -2.0
    for root in range(12):
        folded = np.array([mean[(i + root) % 12] for i in range(12)])
        for minor, profile in ((False, EDMA_MAJOR), (True, EDMA_MINOR)):
            score = pearson(folded, profile)
            if score > best:
                best = score
                best_root = root
                best_minor = minor
    name = f"{NAMES[best_root]} {'minor' if best_minor else 'major'}"
    return name, best


def essentia_key(samples: np.ndarray, profile: str) -> tuple[str, float]:
    if samples.size < 4096:
        return '', 0.0
    key, scale, strength = es.KeyExtractor(profileType=profile, sampleRate=44100)(samples)
    return f'{key} {scale}', float(strength)


def load_mono(path: str, seconds: float) -> np.ndarray:
    audio = es.MonoLoader(filename=path, sampleRate=44100, resampleQuality=1)()
    if seconds > 0:
        audio = audio[: int(44100 * seconds)]
    return audio


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('manifest')
    parser.add_argument('out_csv')
    parser.add_argument('--librosa', action='store_true')
    args = parser.parse_args()
    rows = []
    manifest = Path(args.manifest).read_text().splitlines()
    total = len(manifest)
    for index, line in enumerate(manifest, start=1):
        if not line.strip():
            continue
        item = json.loads(line)
        path = item['path']
        seconds = float(item.get('seconds') or 0)
        try:
            audio = load_mono(path, seconds)
            edma, edma_s = essentia_key(audio, 'edma')
            kk, kk_s = essentia_key(audio, 'krumhansl')
            lib_name, lib_corr = ('', 0.0)
            if args.librosa:
                lib_name, lib_corr = librosa_edma(path, seconds if seconds > 0 else 24)
            full_name, full_s = ('', 0.0)
            if item.get('alsoFull'):
                full = load_mono(path, 0)
                full_name, full_s = essentia_key(full, 'edma')
            rows.append({
                'id': item['id'],
                'essentia_edma': edma,
                'essentia_edma_strength': f'{edma_s:.4f}',
                'essentia_kk': kk,
                'essentia_kk_strength': f'{kk_s:.4f}',
                'essentia_edma_full': full_name,
                'essentia_edma_full_strength': f'{full_s:.4f}' if full_name else '',
                'librosa_edma': lib_name,
                'librosa_edma_corr': f'{lib_corr:.4f}' if lib_name else '',
            })
        except Exception as error:  # noqa: BLE001 — one bad file should not stop the batch
            rows.append({
                'id': item['id'],
                'essentia_edma': '',
                'essentia_edma_strength': '',
                'essentia_kk': '',
                'essentia_kk_strength': '',
                'essentia_edma_full': '',
                'essentia_edma_full_strength': '',
                'librosa_edma': '',
                'librosa_edma_corr': '',
                'error': str(error),
            })
        if index % 25 == 0 or index == total:
            print(f'reference {index}/{total}', file=sys.stderr)
    fields = ['id', 'essentia_edma', 'essentia_edma_strength', 'essentia_kk', 'essentia_kk_strength', 'essentia_edma_full', 'essentia_edma_full_strength', 'librosa_edma', 'librosa_edma_corr', 'error']
    with open(args.out_csv, 'w', newline='') as handle:
        writer = csv.DictWriter(handle, fieldnames=fields, extrasaction='ignore')
        writer.writeheader()
        writer.writerows(rows)
    print(args.out_csv)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
