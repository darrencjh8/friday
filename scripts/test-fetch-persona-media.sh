#!/usr/bin/env bash
# Tests scripts/fetch-persona-media.sh against a stub `gh` that serves a local
# release fixture, so it runs offline and needs no token.
# Usage: bash scripts/test-fetch-persona-media.sh   (exit 0 = all pass)
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FETCH="$ROOT/scripts/fetch-persona-media.sh"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
status=0
fail() { echo "FAIL: $1"; status=1; }

# Release fixture: v3 with one file per consumer.
mkdir -p "$work/src/media/dots-web/public/dots/nova" "$work/src/media/android/app/src/main/res/raw" "$work/release/v3"
echo clip > "$work/src/media/dots-web/public/dots/nova/idle.webp"
echo state > "$work/src/media/android/app/src/main/res/raw/nova_state_still_white.webp"
tar -czf "$work/release/v3/persona-media-v3.tar.gz" -C "$work/src" media
(cd "$work/release/v3" && sha256sum persona-media-v3.tar.gz > persona-media-v3.tar.gz.sha256)

# Stub gh: `gh release download <tag> ... -D <dir>` copies that tag's fixture files.
mkdir -p "$work/bin"
cat > "$work/bin/gh" <<'EOF'
#!/usr/bin/env bash
[ "$1 $2" = "release download" ] || exit 2
tag=$3; dir=""
while [ $# -gt 0 ]; do [ "$1" = "-D" ] && dir=$2; shift; done
[ -d "$FIXTURE/$tag" ] || { echo "release not found" >&2; exit 1; }
cp "$FIXTURE/$tag"/* "$dir"/
EOF
chmod +x "$work/bin/gh"
export PATH="$work/bin:$PATH" FIXTURE="$work/release"

consumer() { rm -rf "$work/c"; mkdir -p "$work/c"; printf '%s\n' "$1" > "$work/c/persona-media.version"; }

# 1. dots-web unpacks its own files in place, and nothing of android's.
consumer v3
bash "$FETCH" dots-web "$work/c" >/dev/null 2>&1 || fail "dots-web fetch exited non-zero"
[ "$(cat "$work/c/public/dots/nova/idle.webp" 2>/dev/null)" = clip ] || fail "dots-web clip not unpacked to public/dots/nova/"
[ ! -e "$work/c/app" ] || fail "dots-web fetch unpacked android files"

# 2. android unpacks under app/src/main/res/.
consumer v3
bash "$FETCH" android "$work/c" >/dev/null 2>&1 || fail "android fetch exited non-zero"
[ -f "$work/c/app/src/main/res/raw/nova_state_still_white.webp" ] || fail "android clip not unpacked to app/src/main/res/raw/"

# 3. A checksum mismatch fails and unpacks nothing.
cp -r "$work/release/v3" "$work/release/v4"
mv "$work/release/v4/persona-media-v3.tar.gz" "$work/release/v4/persona-media-v4.tar.gz"
echo "0000000000000000000000000000000000000000000000000000000000000000  persona-media-v4.tar.gz" > "$work/release/v4/persona-media-v4.tar.gz.sha256"
echo tampered >> "$work/release/v4/persona-media-v4.tar.gz"
consumer v4
bash "$FETCH" dots-web "$work/c" >/dev/null 2>&1 && fail "checksum mismatch did not fail"
[ ! -e "$work/c/public" ] || fail "checksum mismatch still unpacked files"

# 4. A malformed version, a missing release, a missing version file, an unknown consumer all fail.
consumer "main"
bash "$FETCH" dots-web "$work/c" >/dev/null 2>&1 && fail "malformed version did not fail"
consumer v9
bash "$FETCH" dots-web "$work/c" >/dev/null 2>&1 && fail "missing release did not fail"
rm -rf "$work/c"; mkdir -p "$work/c"
bash "$FETCH" dots-web "$work/c" >/dev/null 2>&1 && fail "missing version file did not fail"
consumer v3
bash "$FETCH" ios "$work/c" >/dev/null 2>&1 && fail "unknown consumer did not fail"

[ "$status" -eq 0 ] && echo "fetch-persona-media: all checks pass"
exit "$status"
