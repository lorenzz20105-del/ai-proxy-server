#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
#  Build the AI Proxy companion APK with no Gradle, no AndroidX and no
#  network fetches beyond the two one-time tool downloads below.
#
#      bash build-apk.sh [output.apk]
#
#  Toolchain: aapt (resources) -> javac (Java 8 bytecode) -> R8's d8 (dex)
#             -> zipalign -> apksigner.
#
#  The app uses pure android.* framework APIs only. Adding an AndroidX or
#  Material import would break this path, since there is no AAR resolution.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUILD="$HERE/build"
OUT="${1:-$HERE/dist/AIProxy.apk}"

export JAVA_HOME="${JAVA_HOME:-/usr/lib/jvm/java-17-openjdk-arm64}"
export PATH="$JAVA_HOME/bin:$PATH"
export LD_LIBRARY_PATH="/usr/lib/aarch64-linux-gnu/android:${LD_LIBRARY_PATH:-}"

AAPT="${AAPT:-aapt}"
TOOLS="${APK_TOOLS:-$HOME/.cache/aiproxy-apk}"
KEYSTORE="${APK_KEYSTORE:-$TOOLS/aiproxy.jks}"
STOREPASS="${APK_KEYSTORE_PASSWORD:-android}"
KEYALIAS="${APK_KEY_ALIAS:-ai-proxy}"
R8_VERSION="8.5.35"

# aapt v1 cannot parse the resource table that ships with API 33+ platform jars,
# so the compile SDK is pinned to Android 12. targetSdkVersion stays modern.
PLATFORM_URL="https://dl.google.com/android/repository/platform-32_r01.zip"
ANDROID_JAR="$TOOLS/android-32_r01.jar"
R8_JAR="$TOOLS/r8.jar"

MIN_SDK=24
TARGET_SDK=34
VERSION_CODE=30000
VERSION_NAME=3.0.0

say() { printf '\033[1;36m==>\033[0m %s\n' "$1"; }

fetch() {
  local url="$1" dest="$2"
  [ -s "$dest" ] && return 0
  say "fetching $(basename "$dest")"
  mkdir -p "$(dirname "$dest")"
  curl -fsSL --retry 3 -o "$dest" "$url"
}

mkdir -p "$TOOLS" "$(dirname "$OUT")"

# ---------------------------------------------------------------- tools
fetch "$PLATFORM_URL" "$TOOLS/platform.zip"
if [ ! -s "$ANDROID_JAR" ]; then
  say "extracting android.jar"
  python3 - "$TOOLS/platform.zip" "$ANDROID_JAR" <<'PYEOF'
import sys, zipfile
archive, out = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(archive) as z:
    name = next(n for n in z.namelist() if n.endswith("/android.jar"))
    open(out, "wb").write(z.read(name))
print("android.jar <-", name)
PYEOF
  rm -f "$TOOLS/platform.zip"
fi

fetch "https://dl.google.com/dl/android/maven2/com/android/tools/r8/$R8_VERSION/r8-$R8_VERSION.jar" "$R8_JAR"

if [ ! -s "$KEYSTORE" ]; then
  say "generating signing keystore"
  keytool -genkeypair -keystore "$KEYSTORE" -storepass "$STOREPASS" -keypass "$STOREPASS" \
    -alias "$KEYALIAS" -keyalg RSA -keysize 2048 -validity 10000 \
    -dname "CN=AI Proxy, OU=Mobile, O=aiproxy, C=US" >/dev/null
fi

# ---------------------------------------------------------------- clean
say "clean"
rm -rf "$BUILD"
mkdir -p "$BUILD/classes" "$BUILD/dex" "$BUILD/gen" "$BUILD/res"

# The dashboard is bundled so the app works with no network and no build step.
if [ ! -f "$HERE/assets/dashboard/index.html" ]; then
  echo "assets/dashboard is empty — build the console first:" >&2
  echo "  cd ../frontend && npm install && npm run build" >&2
  echo "  rm -rf ../android/assets/dashboard && mkdir -p ../android/assets/dashboard" >&2
  echo "  cp -r dist/. ../android/assets/dashboard/" >&2
  exit 1
fi

# ---------------------------------------------------------------- resources
say "compiling resources"
cp -r "$HERE/res/." "$BUILD/res/"
"$AAPT" package -f \
  -J "$BUILD/gen" \
  -M "$HERE/AndroidManifest.xml" \
  -S "$BUILD/res" \
  -A "$HERE/assets" \
  -I "$ANDROID_JAR" \
  -F "$BUILD/app-unsigned.apk" \
  --auto-add-overlay \
  --min-sdk-version "$MIN_SDK" \
  --target-sdk-version "$TARGET_SDK" \
  --version-code "$VERSION_CODE" \
  --version-name "$VERSION_NAME"

# ---------------------------------------------------------------- java -> dex
say "compiling java"
find "$HERE/java" -name '*.java' > "$BUILD/sources.txt"
javac -nowarn -encoding UTF-8 \
  -source 8 -target 8 \
  -bootclasspath "$ANDROID_JAR" \
  -d "$BUILD/classes" \
  @"$BUILD/sources.txt" 2>&1 \
  | grep -vE 'bootstrap class path|source value 8|target value 8|^Note:' || true

if [ -z "$(find "$BUILD/classes" -name '*.class' -print -quit)" ]; then
  echo "javac produced no classes" >&2
  exit 1
fi
echo "    $(find "$BUILD/classes" -name '*.class' | wc -l) class files"

say "dexing"
java -cp "$R8_JAR" com.android.tools.r8.D8 \
  --min-api "$MIN_SDK" \
  --lib "$ANDROID_JAR" \
  --output "$BUILD/dex" \
  $(find "$BUILD/classes" -name '*.class')

# ---------------------------------------------------------------- package
say "packaging"
cp "$BUILD/dex/classes.dex" "$BUILD/classes.dex"
( cd "$BUILD" && zip -q -X app-unsigned.apk classes.dex )

say "aligning"
zipalign -f -p 4 "$BUILD/app-unsigned.apk" "$BUILD/app-aligned.apk"

say "signing"
apksigner sign \
  --ks "$KEYSTORE" \
  --ks-pass "pass:$STOREPASS" \
  --key-pass "pass:$STOREPASS" \
  --ks-key-alias "$KEYALIAS" \
  --min-sdk-version "$MIN_SDK" \
  --out "$OUT" \
  "$BUILD/app-aligned.apk"

rm -f "$OUT.idsig"
apksigner verify --verbose "$OUT" | sed 's/^/    /'
say "built $OUT ($(du -h "$OUT" | cut -f1))"