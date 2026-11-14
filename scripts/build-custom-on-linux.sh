#!/usr/bin/env bash
# Builds the custom Linux runtime and the Windows installer that bundles it,
# natively on a Linux host: the same outputs as build-install-custom.ps1
# -BuildOnly, without Docker or a Windows machine. With T3CODE_ANDROID_KEYSTORE
# set, it also builds the Android preview APK.
#
# Host prerequisites (Ubuntu): build-essential pkg-config libsecret-1-dev
# imagemagick patchelf lld, rustup with the x86_64-pc-windows-msvc target, and a
# cargo [target.x86_64-pc-windows-msvc] config that links with lld-link against
# an `xwin splat` of the MSVC CRT and Windows SDK. Android also needs JDK 17 as
# JAVA_HOME and an Android SDK with accepted licenses as ANDROID_HOME.
set -euo pipefail

repo_root=$(cd "$(dirname "$0")/.." && pwd)
cd "$repo_root"

for tool in git vp sfw cargo patchelf lld-link; do
  command -v "$tool" >/dev/null || { echo "$tool is missing" >&2; exit 1; }
done
rustup target list --installed | grep -qx x86_64-pc-windows-msvc ||
  { echo "rustup target x86_64-pc-windows-msvc is missing" >&2; exit 1; }

# vp picks Node per package, and apps/server's loose engine range resolves to
# the newest Node 26, which the CLI executable build rejects.
export VP_NODE_VERSION
VP_NODE_VERSION=$(vp env exec node -p "require('./package.json').engines.node")
export CI=true T3CODE_DESKTOP_SKIP_BUILD=false

version=$(node -p "require('./apps/server/package.json').version")
output_root="$repo_root/release/custom"
linux_output="$output_root/linux"
windows_output="$output_root/windows"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
rm -rf "$output_root"
mkdir -p "$linux_output" "$windows_output" "$work/resource-monitor/linux-x64"

sfw pnpm install --frozen-lockfile
vp run build:desktop

sfw cargo build --locked --release --manifest-path native/resource-monitor/Cargo.toml \
  --target x86_64-unknown-linux-gnu
cp native/resource-monitor/target/x86_64-unknown-linux-gnu/release/t3-resource-monitor \
  "$work/resource-monitor/linux-x64/"
node apps/server/scripts/cli.ts build-exe
sfw node scripts/build-cli-archive.ts --platform linux --arch x64 --version "$version" \
  --resource-monitor-dir "$work/resource-monitor" --output-dir "$linux_output"
runtime="$linux_output/t3-$version-linux-x64.tar.gz"
node scripts/smoke-cli-archive.ts --archive "$runtime" --expect-version "$version"

# The packaging step's own `vp install --prod` inherits sfw's proxy.
sfw node scripts/build-desktop-artifact.ts --platform win --target nsis --arch x64 \
  --build-version "$version" --wsl-runtime "$runtime" \
  --output-dir "$windows_output"
installer="$windows_output/T3-Code-Custom-$version-x64.exe"
[ -f "$installer" ] || { echo "The custom installer was not produced." >&2; exit 1; }

# Android updates an installed app only when the signing key matches, so the
# preview APK is signed with the keystore T3CODE_ANDROID_KEYSTORE names
# (alias androiddebugkey, password android, as the generated project expects).
apk=""
if [ -n "${T3CODE_ANDROID_KEYSTORE:-}" ]; then
  : "${ANDROID_HOME:?ANDROID_HOME must name the Android SDK}"
  android_output="$output_root/android"
  mkdir -p "$android_output"
  (
    cd apps/mobile
    # OTA updates stay off: the configured update channel serves upstream bundles.
    export APP_VARIANT=preview T3CODE_MOBILE_UPDATES_ENABLED=0 EXPO_NO_GIT_STATUS=1
    sfw npx expo prebuild --clean --platform android --no-install
    cp "$T3CODE_ANDROID_KEYSTORE" android/app/debug.keystore
    cd android
    NODE_ENV=production ./gradlew assembleRelease --no-daemon
  )
  apk="$android_output/T3-Code-Custom-$version-android.apk"
  cp apps/mobile/android/app/build/outputs/apk/release/app-release.apk "$apk"
  apksigner=$(find "$ANDROID_HOME/build-tools" -name apksigner | sort -V | tail -1)
  signer=$("$apksigner" verify --print-certs "$apk" |
    sed -n 's/^.*[Ss]igner.*certificate SHA-256 digest: //p' | sort -u)
  expected=$(keytool -exportcert -keystore "$T3CODE_ANDROID_KEYSTORE" -storepass android \
    -alias androiddebugkey | sha256sum | cut -d' ' -f1)
  [ -n "$signer" ] && [ "$signer" = "$expected" ] ||
    { echo "The APK is not signed by $T3CODE_ANDROID_KEYSTORE." >&2; exit 1; }
fi

cat >"$output_root/BUILD.json" <<EOF
{
  "version": "$version",
  "sourceCommit": "$(git rev-parse HEAD)",
  "installer": "$installer",
  "installerSha256": "$(sha256sum "$installer" | cut -d' ' -f1)",
  "wslRuntimeSha256": "$(sha256sum "$runtime" | cut -d' ' -f1)"$(
    [ -z "$apk" ] || printf ',\n  "apkSha256": "%s"' "$(sha256sum "$apk" | cut -d' ' -f1)"
  )
}
EOF
echo "Installer: $installer"
[ -z "$apk" ] || echo "APK: $apk"
