#!/usr/bin/env bash
# Downloads the pinned Friday persona media release and unpacks one consumer's
# files in place. Friday's portraits, clips and icons live in
# darrencjh8/friday-persona (media/), never in the app repositories.
#
# Usage: fetch-persona-media.sh <dots-web|android> <consumer dir>
#   dots-web: modules/dots-web in friday   android: the hermes-dots root
# The consumer dir holds persona-media.version, a friday-persona release tag
# such as v1. Needs GH_TOKEN with read access to darrencjh8/friday-persona.
set -euo pipefail

target=${1:-} dest=${2:-}
case "$target" in
    dots-web | android) ;;
    *) echo "usage: $0 <dots-web|android> <consumer dir>" >&2; exit 2 ;;
esac
version=$(tr -d '[:space:]' < "$dest/persona-media.version")
[[ $version =~ ^v[0-9]+$ ]] || { echo "bad version '$version' in $dest/persona-media.version" >&2; exit 1; }

archive="persona-media-$version.tar.gz"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
gh release download "$version" -R darrencjh8/friday-persona -p "$archive" -p "$archive.sha256" -D "$tmp"
(cd "$tmp" && sha256sum -c --quiet "$archive.sha256")
tar -xzf "$tmp/$archive" -C "$dest" --strip-components=2 "media/$target"
echo "persona media $version ($target) unpacked into $dest"
