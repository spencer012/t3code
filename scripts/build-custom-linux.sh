#!/usr/bin/env bash
set -euo pipefail

git config --global --add safe.directory /source
git config --global --add safe.directory /source/.git
git clone --shared --no-checkout --quiet /source /home/vp/workspace/repo
rsync -rlt --exclude='.git/' --exclude='node_modules/' --exclude='.pnpm-store/' \
  --exclude='.repos/' --exclude='.t3/' --exclude='.codex/' --exclude='.aws/' \
  --exclude='release/' --exclude='release-mock/' --exclude='.plans/' \
  --exclude='dist/' --exclude='dist-electron/' --exclude='target/' --exclude='build/' \
  /source/ /home/vp/workspace/repo/
cd /home/vp/workspace/repo

# Package downloads go through Socket Firewall. `vp install` only delegates to
# pnpm; the image's pnpm shim resolves the pinned version, and sfw recognizes
# it by name.
command -v sfw >/dev/null || { echo "sfw is missing from the builder image; rebuild it" >&2; exit 1; }
sfw pnpm install --frozen-lockfile \
  --filter=@t3tools/desktop... --filter=t3... --filter=@t3tools/scripts...
vp run build:desktop
version=$(vp env exec node -p "JSON.parse(require('node:fs').readFileSync('apps/server/package.json', 'utf8')).version")
sfw cargo build --locked --release --manifest-path native/resource-monitor/Cargo.toml \
  --target x86_64-unknown-linux-gnu

if [ "$BUILD_LINUX_DESKTOP" = "1" ]; then
  T3CODE_DESKTOP_REUSE_RESOURCE_MONITOR=true vp run dist:desktop:artifact \
    --platform linux --target AppImage --arch x64 --build-version "$version" \
    --skip-build --output-dir /home/vp/artifacts
fi

VP_NODE_VERSION=26.8.2 vp env exec node apps/server/scripts/cli.ts build-exe
mkdir -p /home/vp/cli-resource-monitor/linux-x64
cp native/resource-monitor/target/x86_64-unknown-linux-gnu/release/t3-resource-monitor \
  /home/vp/cli-resource-monitor/linux-x64/
vp env exec node scripts/build-cli-archive.ts --platform linux --arch x64 \
  --version "$version" --resource-monitor-dir /home/vp/cli-resource-monitor \
  --output-dir /home/vp/artifacts
vp env exec node scripts/smoke-cli-archive.ts \
  --archive "/home/vp/artifacts/t3-$version-linux-x64.tar.gz" --expect-version "$version"
cp -v /home/vp/artifacts/* /output/
