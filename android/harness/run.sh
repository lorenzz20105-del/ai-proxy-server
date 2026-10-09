#!/usr/bin/env bash
# Run the on-device proxy engine as a plain JVM program, with Android stubbed out.
#
# The engine is pure Java except for SQLite and a few android.* utility classes. This
# script compiles it against thin stubs (SQLite backed by sqlite-jdbc) and runs
# EngineTest, which drives the real HTTP server through auth, admin CRUD, routing,
# all three provider translations, streaming, caching, quota failover, egress
# assignment and desktop identity — 155 assertions, no emulator needed.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
SRC="$ROOT/android/java/com/aiproxy/mobile"
OUT="$HERE/out"
CACHE="${HARNESS_CACHE:-$HOME/.cache/aiproxy-harness}"

JAVA_BIN=""
# Find a JDK: JAVA_HOME first, then PATH, then common install locations.
if [ -n "${JAVA_HOME:-}" ] && [ -x "$JAVA_HOME/bin/javac" ]; then
  JAVA_BIN="$JAVA_HOME/bin/"
elif command -v javac >/dev/null 2>&1; then
  JAVA_BIN="$(dirname "$(command -v javac)")/"
else
  for d in /usr/lib/jvm/*/bin /usr/lib64/jvm/*/bin /opt/*/bin /opt/java/*/bin; do
    if [ -x "$d/javac" ]; then JAVA_BIN="$d/"; break; fi
  done
fi
[ -n "$JAVA_BIN" ] || { echo "no JDK found - set JAVA_HOME to a JDK 11+" >&2; exit 1; }
echo "  javac: ${JAVA_BIN}javac"
export PATH="$JAVA_BIN:$PATH"

mkdir -p "$CACHE" "$OUT"

fetch() { # fetch <name> <url>
  local name="$1" url="$2" dest="$CACHE/$1"
  [ -f "$dest" ] || { echo "  fetching $name"; curl -fsSL -o "$dest" "$url"; }
}

echo "== dependencies"
fetch sqlite-jdbc.jar \
  "https://repo1.maven.org/maven2/org/xerial/sqlite-jdbc/3.45.3.0/sqlite-jdbc-3.45.3.0.jar"
fetch json.jar \
  "https://repo1.maven.org/maven2/org/json/json/20240303/json-20240303.jar"
fetch slf4j-api.jar \
  "https://repo1.maven.org/maven2/org/slf4j/slf4j-api/1.7.36/slf4j-api-1.7.36.jar"
CP="$CACHE/sqlite-jdbc.jar:$CACHE/json.jar"

echo "== compile"
rm -rf "$OUT"; mkdir -p "$OUT"
# MainActivity needs a real Android UI toolkit; everything else compiles headless.
ENGINE_SOURCES=()
while IFS= read -r f; do
  case "$(basename "$f")" in MainActivity.java|PlaygroundActivity.java) continue;; esac
  ENGINE_SOURCES+=("$f")
done < <(find "$SRC" -name '*.java')

javac -nowarn -encoding UTF-8 -cp "$CP" -d "$OUT" \
  $(find "$HERE/stubs" -name '*.java') \
  "${ENGINE_SOURCES[@]}" \
  "$HERE/src/com/aiproxy/mobile/EngineTest.java" \
  "$HERE/src/com/aiproxy/mobile/ServerMain.java"

echo "== run"
exec java \
  -Daiproxy.assets="${AIPROXY_ASSETS:-$ROOT/android/assets}" \
  -Daiproxy.db="${AIPROXY_DB:-jdbc:sqlite::memory:}" \
  -cp "$OUT:$CP:$CACHE/slf4j-api.jar" \
  com.aiproxy.mobile.EngineTest "$@"
