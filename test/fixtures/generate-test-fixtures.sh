#!/bin/bash
# Generate test videos for still-extractor integration tests.
# Run inside the test container (ffmpeg required).

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "Generating test fixtures..."

# 1. Plain colourful video — every candidate offset should yield a usable frame.
if [ ! -f "color.mp4" ]; then
    echo "Creating color.mp4..."
    ffmpeg -y -f lavfi -i testsrc=duration=10:size=320x240:rate=24 \
           -c:v libx264 -preset ultrafast -crf 28 -pix_fmt yuv420p \
           color.mp4
fi

# 2. Six seconds of black, then picture. 20s total, so the 20% candidate (4s)
#    lands in the black head and must be rejected in favour of a later one.
if [ ! -f "black-head.mp4" ]; then
    echo "Creating black-head.mp4..."
    ffmpeg -y -f lavfi -i "color=c=black:size=320x240:duration=6:rate=24" \
           -c:v libx264 -preset ultrafast -crf 28 -pix_fmt yuv420p black_part.mp4
    ffmpeg -y -f lavfi -i testsrc=duration=14:size=320x240:rate=24 \
           -c:v libx264 -preset ultrafast -crf 28 -pix_fmt yuv420p color_part.mp4
    printf "file 'black_part.mp4'\nfile 'color_part.mp4'\n" > concat.txt
    ffmpeg -y -f concat -safe 0 -i concat.txt -c copy black-head.mp4
    rm -f black_part.mp4 color_part.mp4 concat.txt
fi

# 3. Video carrying attached cover art LARGER than the video itself — the
#    stream-selection trap. ffprobe reports the cover as codec_type=video.
if [ ! -f "cover-art.mp4" ]; then
    echo "Creating cover-art.mp4..."
    ffmpeg -y -f lavfi -i "color=c=red:size=600x900:duration=1:rate=1" -frames:v 1 cover.png
    ffmpeg -y -i color.mp4 -i cover.png \
           -map 0:v -map 1 -c copy -disposition:v:1 attached_pic \
           cover-art.mp4
    rm -f cover.png
fi

# 4. Audio-only file — nothing to extract.
if [ ! -f "audio-only.mp3" ]; then
    echo "Creating audio-only.mp3..."
    ffmpeg -y -f lavfi -i sine=frequency=440:duration=2 \
           -c:a libmp3lame -b:a 128k \
           audio-only.mp3
fi

echo "Test fixtures generated:"
ls -la *.mp4 *.mp3 2>/dev/null || true
