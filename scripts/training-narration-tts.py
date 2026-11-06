#!/usr/bin/env python3
"""Synthesize the training narration script with a local Piper voice.

Input: a JSON array of {"id": "...", "text": "..."} objects.
Output: one 16-bit PCM WAV per entry in --output-dir, named <id>.wav, plus a
JSON summary on stdout with the measured duration of every clip.

The voice runs fully offline (ONNX on the CPU). No text leaves the runner and
no network call is made during synthesis.
"""
import argparse
import json
import sys
import wave
from pathlib import Path


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True, help="Path to the Piper .onnx voice")
    parser.add_argument("--config", help="Path to the voice .onnx.json (defaults to <model>.json)")
    parser.add_argument("--input", required=True, help="JSON array of {id, text}")
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--length-scale", type=float, default=1.0, help="1.0 is normal speed; higher is slower")
    args = parser.parse_args()

    try:
        from piper import PiperVoice, SynthesisConfig
    except ImportError as error:  # pragma: no cover - environment guard
        print("piper-tts is not installed: " + str(error), file=sys.stderr)
        return 2

    model = Path(args.model)
    config = Path(args.config) if args.config else Path(str(model) + ".json")
    if not model.is_file() or not config.is_file():
        print("Narration voice model or config missing: %s / %s" % (model, config), file=sys.stderr)
        return 2

    with open(args.input, "r", encoding="utf-8") as handle:
        entries = json.load(handle)
    if not isinstance(entries, list) or not entries:
        print("Narration input must be a non-empty JSON array", file=sys.stderr)
        return 2

    output = Path(args.output_dir)
    output.mkdir(parents=True, exist_ok=True)
    voice = PiperVoice.load(model, config_path=config)
    syn = SynthesisConfig(length_scale=args.length_scale)
    results = []
    for entry in entries:
        clip_id = str(entry["id"])
        text = str(entry["text"]).strip()
        if not clip_id.replace("-", "").isalnum() or not text:
            print("Invalid narration entry: %r" % (entry,), file=sys.stderr)
            return 2
        target = output / (clip_id + ".wav")
        with wave.open(str(target), "wb") as wav_file:
            voice.synthesize_wav(text, wav_file, syn_config=syn)
        with wave.open(str(target), "rb") as check:
            frames = check.getnframes()
            rate = check.getframerate()
        if frames < rate // 10:
            print("Narration clip is unexpectedly short: " + clip_id, file=sys.stderr)
            return 1
        results.append({"id": clip_id, "seconds": frames / float(rate)})
    json.dump({"clips": results, "sampleRate": rate}, sys.stdout)
    return 0


if __name__ == "__main__":
    sys.exit(main())
