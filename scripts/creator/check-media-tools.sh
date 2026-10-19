#!/bin/sh
# Checks that this host or image can run the Creator Studio worker's media work, and fails
# (exit 1, one reason on stderr) otherwise. Run by the Dockerfile's `worker` stage at
# build time (a worker image without a suitable FFmpeg is never produced), by CI against
# the built image, and by hand on a worker host:
#
#   sh scripts/creator/check-media-tools.sh
#
# Requires: FFmpeg 6 or later with the libx264, aac and libopus encoders and the
# `subtitles` filter (libass); ffprobe; the subtitle font the worker burns in. Then a real
# smoke run: a one-second synthetic clip is encoded with burned-in subtitles and read
# back with ffprobe. Synthetic input only (lavfi), in a private temporary directory that is
# always removed; no network. POSIX sh (the image's /bin/sh is dash).
set -eu

FFMPEG="${CREATOR_FFMPEG_PATH:-ffmpeg}"
FFPROBE="${CREATOR_FFPROBE_PATH:-ffprobe}"
FONT="${CREATOR_SUBTITLE_FONT:-/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf}"
MIN_MAJOR=6

fail() {
  echo "media tools check FAILED: $1" >&2
  exit 1
}

# Each command's own exit status is checked (dash has no pipefail).
banner="$("$FFMPEG" -hide_banner -version 2>/dev/null)" || fail "ffmpeg is not runnable"
version="$(printf '%s\n' "$banner" | head -n 1)"
major="$(printf '%s\n' "$version" | sed -n 's/^ffmpeg version n\{0,1\}\([0-9][0-9]*\).*/\1/p')"
[ -n "$major" ] || fail "unrecognised ffmpeg version line: $version"
[ "$major" -ge "$MIN_MAJOR" ] || fail "FFmpeg $major is older than $MIN_MAJOR"

encoders="$("$FFMPEG" -hide_banner -encoders 2>/dev/null)" || fail "cannot list ffmpeg encoders"
for encoder in libx264 aac libopus; do
  printf '%s\n' "$encoders" | grep -Eq "[[:space:]]${encoder}[[:space:]]" ||
    fail "encoder $encoder missing"
done
filters="$("$FFMPEG" -hide_banner -filters 2>/dev/null)" || fail "cannot list ffmpeg filters"
printf '%s\n' "$filters" | grep -Eq '[[:space:]]subtitles[[:space:]]' ||
  fail "subtitles filter missing (FFmpeg built without libass)"
"$FFPROBE" -hide_banner -version >/dev/null 2>&1 || fail "ffprobe is not runnable"
[ -f "$FONT" ] || fail "subtitle font missing: $FONT"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
printf '1\n00:00:00,000 --> 00:00:01,000\nسلام check\n' > "$work/check.srt"
"$FFMPEG" -nostdin -v error -f lavfi -i testsrc=size=320x240:rate=25 -f lavfi -i sine=frequency=440 \
  -t 1 -vf "subtitles=$work/check.srt" -c:v libx264 -preset ultrafast -pix_fmt yuv420p \
  -c:a aac -shortest -y "$work/check.mp4" 2>"$work/err.txt" ||
  fail "smoke encode failed: $(tail -n 1 "$work/err.txt")"
codec="$("$FFPROBE" -v error -select_streams v:0 -show_entries stream=codec_name -of csv=p=0 "$work/check.mp4")" ||
  fail "ffprobe cannot read the smoke clip"
[ "$codec" = "h264" ] || fail "smoke clip has video codec '$codec', not h264"
"$FFMPEG" -nostdin -v error -f lavfi -i sine=frequency=440 -t 1 -c:a libopus -b:a 24k -y "$work/check.ogg" 2>"$work/err.txt" ||
  fail "smoke Opus encode failed: $(tail -n 1 "$work/err.txt")"

echo "media tools OK: FFmpeg $major (libx264, aac, libopus, subtitles), ffprobe, subtitle font, smoke encode"
