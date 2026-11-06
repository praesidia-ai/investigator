"""Narration with Kokoro-82M (Apache-2.0 open weights, runs locally, free).

Reads [{"text": ..., "out": ".../scene-01.wav"}, ...] as JSON on stdin and writes one WAV per line.
Model files: KOKORO_DIR (default ~/.cache/jurator-film) holds kokoro-v1.0.onnx and voices-v1.0.bin from
https://github.com/thewh1teagle/kokoro-onnx/releases/tag/model-files-v1.0
Usage: python tts_kokoro.py <voice> <speed> < lines.json
"""
import json
import os
import sys

import numpy as np
import soundfile as sf
from kokoro_onnx import Kokoro

model_dir = os.environ.get("KOKORO_DIR", os.path.expanduser("~/.cache/jurator-film"))
voice, speed = sys.argv[1], float(sys.argv[2])
kokoro = Kokoro(os.path.join(model_dir, "kokoro-v1.0.onnx"), os.path.join(model_dir, "voices-v1.0.bin"))
GAP = 0.6  # seconds of silence for each "|" pause marker in a line
for line in json.load(sys.stdin):
    parts, marks, at, rate = [p.strip() for p in line["text"].split("|") if p.strip()], [], 0.0, 24000
    chunks = []
    for i, part in enumerate(parts):
        samples, rate = kokoro.create(part, voice=voice, speed=speed, lang="en-us")
        if i:
            chunks.append(np.zeros(int(GAP * rate), dtype=samples.dtype)); at += GAP
        marks.append({"start": round(at, 3), "end": round(at + len(samples) / rate, 3)})
        chunks.append(samples); at += len(samples) / rate
    sf.write(line["out"], np.concatenate(chunks), rate)
    if len(parts) > 1:  # segment times, so the film can cue animation to each spoken phrase
        with open(line["out"] + ".marks.json", "w") as f:
            json.dump(marks, f)
    print(line["out"], flush=True)
