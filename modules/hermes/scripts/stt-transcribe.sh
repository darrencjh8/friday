#!/bin/bash
# Speech to text for Hermes's stt command provider: stt-transcribe <input> <output>.
#
# Parakeet first: the laptop's voice server (the Friday desktop app's server.py)
# takes a 16 kHz mono WAV on POST /transcribe and answers {"text": "..."}. If it
# does not answer (on the server host.docker.internal does not resolve, so it
# is not even tried), errors, or replies with something that is not that JSON, the
# original file goes to the server's Whisper, which answers plain text. Either
# way the transcript is written to <output> as plain text.
#
# An empty Parakeet transcript is kept, not retried on Whisper: Parakeet's voice
# check found no speech, and Whisper (also voice-filtered) would only spend time
# loading its model to say the same.
#
# Which engine served goes to stderr; Hermes shows it only when the command
# fails, so Parakeet's own log on the laptop is where a success is confirmed.
set -u

input=$1
output=$2
parakeet=${PARAKEET_URL:-http://host.docker.internal:8765}
# Bare host of the URL: on the server it does not resolve, so skip the
# conversion and the connect attempt and go straight to Whisper.
host=${parakeet#*://}
host=${host%%/*}
host=${host%:*}

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

if getent hosts "$host" >/dev/null \
    && ffmpeg -nostdin -loglevel error -y -i "$input" -ar 16000 -ac 1 -f wav "$work/audio.wav" \
    && curl --fail -sS --connect-timeout 2 --max-time 120 -H 'Content-Type: audio/wav' \
        --data-binary @"$work/audio.wav" -o "$work/reply.json" "$parakeet/transcribe" \
    && python3 -c '
import json, sys
text = json.load(open(sys.argv[1], encoding="utf-8"))["text"]
if not isinstance(text, str):
    sys.exit("parakeet reply has no text")
open(sys.argv[2], "w", encoding="utf-8").write(text)
' "$work/reply.json" "$output"; then
    echo "stt-transcribe: served by parakeet" >&2
    exit 0
fi

echo "stt-transcribe: parakeet failed, falling back to whisper" >&2
curl --fail-with-body -sS --data-binary @"$input" -o "$output" http://whisper:8000/transcribe || exit
echo "stt-transcribe: served by whisper" >&2
