#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "$(readlink -f -- "$0")")/.."

node tests/startup.mjs
node tests/discovery.mjs
node tests/bridge.mjs
node tests/hero-artwork.mjs
node tests/search-streaming.mjs
node tests/webview-compat.mjs
python3 tests/tv-manifest.py
python3 tests/android-contract.py

if [[ -z "${JAVA_HOME:-}" ]] && ! command -v javac >/dev/null 2>&1; then
  echo "JDK 17 is required for the Java protocol and episode-selection checks." >&2
  exit 1
fi
test_dir=$(mktemp -d)
trap 'rm -rf -- "$test_dir"' EXIT
JAVAC=${JAVA_HOME:+$JAVA_HOME/bin/}javac
JAVA=${JAVA_HOME:+$JAVA_HOME/bin/}java
"$JAVAC" -d "$test_dir" tests/CastWireTest.java app/src/main/java/app/cocoastream/android/CastWire.java
"$JAVA" -ea -cp "$test_dir" CastWireTest
"$JAVAC" -d "$test_dir" tests/EpisodeFilesTest.java app/src/main/java/app/cocoastream/android/EpisodeFiles.java
"$JAVA" -ea -cp "$test_dir" EpisodeFilesTest
