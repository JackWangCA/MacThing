#!/bin/zsh
# Builds the two native pieces the bridge needs:
#   native/bin/MacThingVolume                    CoreAudio volume helper, presses the volume keys (Swift)
#   native/bin/appinfo                           app name + icon lookup by bundle id (Swift)
#   native/bin/powerwatch                        Mac sleep/wake + display sleep events (Swift)
#   native/bin/artwork                           covers for the device, and the blurred background (Swift)
#   native/bin/musicctl                          Apple Music favorite/play via Apple Events (Swift)
#   native/bin/CarThingHelper.app                location + calendar, with its own permissions (Swift)
#   native/bin/MediaRemoteAdapter.framework      ungive/mediaremote-adapter, loaded by /usr/bin/perl
# No cmake required — the adapter is small enough to build with clang directly.
set -euo pipefail

ROOT="${0:A:h:h}"
OUT="$ROOT/native/bin"
ADAPTER="$ROOT/vendor/mediaremote-adapter"
ADAPTER_TAG="v0.7.7"
mkdir -p "$OUT"

if [[ ! -d "$ADAPTER" ]]; then
  git clone -q --depth 1 --branch "$ADAPTER_TAG" https://github.com/ungive/mediaremote-adapter.git "$ADAPTER"
fi

echo "• appinfo, powerwatch, artwork"
swiftc -O -o "$OUT/appinfo" "$ROOT/native/appinfo.swift"
swiftc -O -o "$OUT/powerwatch" "$ROOT/native/powerwatch.swift"
swiftc -O -o "$OUT/artwork" "$ROOT/native/artwork.swift"

# Ad-hoc signed tools that hold a macOS permission lose it whenever the binary changes,
# so they're only rebuilt when their source changed.
VOLUME="$OUT/MacThingVolume"
if [[ ! -x "$VOLUME" || "$ROOT/native/MacThingVolume.swift" -nt "$VOLUME" ]]; then
  echo "• MacThingVolume (volume) — macOS will ask again before the knob can show the volume pop-up"
  swiftc -O -o "$VOLUME" "$ROOT/native/MacThingVolume.swift"
  codesign --force --sign - --identifier com.macthing.volume "$VOLUME" 2>/dev/null
else
  echo "• MacThingVolume unchanged (keeping its permission)"
fi

MUSICCTL="$OUT/musicctl"
if [[ ! -x "$MUSICCTL" || "$ROOT/native/musicctl.swift" -nt "$MUSICCTL" ]]; then
  echo "• musicctl (Apple Music favorite/play) — macOS will ask again to let it control Music"
  swiftc -O -o "$MUSICCTL" "$ROOT/native/musicctl.swift"
  codesign --force --sign - --identifier com.carthing.musicctl "$MUSICCTL" 2>/dev/null
else
  echo "• musicctl unchanged (keeping its permission)"
fi

APP="$OUT/CarThingHelper.app"
HELPER_BIN="$APP/Contents/MacOS/CarThingHelper"
# Ad-hoc signed: macOS keeps the Location/Calendars grants only while the binary is unchanged,
# so rebuild it only when its source changed.
if [[ ! -x "$HELPER_BIN" || "$ROOT/native/helper/main.swift" -nt "$HELPER_BIN" || "$ROOT/native/helper/Info.plist" -nt "$HELPER_BIN" ]]; then
  echo "• CarThingHelper.app (location + calendar) — macOS will ask for permissions again"
  mkdir -p "$APP/Contents/MacOS"
  cp "$ROOT/native/helper/Info.plist" "$APP/Contents/Info.plist"
  swiftc -O -o "$HELPER_BIN" "$ROOT/native/helper/main.swift"
  codesign --force --sign - --identifier com.carthing.helper "$APP" 2>/dev/null
else
  echo "• CarThingHelper.app unchanged (keeping its permissions)"
fi

echo "• MediaRemoteAdapter.framework ($ADAPTER_TAG)"
FW="$OUT/MediaRemoteAdapter.framework"
rm -rf "$FW"
mkdir -p "$FW/Versions/A/Resources"
clang -dynamiclib -arch arm64 -arch x86_64 -fobjc-arc -fvisibility=default -w \
  -I"$ADAPTER/include" -I"$ADAPTER/src" \
  "$ADAPTER"/src/adapter/*.m "$ADAPTER"/src/private/MediaRemote.m "$ADAPTER"/src/utility/*.m \
  -framework Foundation -framework AppKit -framework UniformTypeIdentifiers \
  -install_name @rpath/MediaRemoteAdapter.framework/Versions/A/MediaRemoteAdapter \
  -o "$FW/Versions/A/MediaRemoteAdapter"
cat > "$FW/Versions/A/Resources/Info.plist" <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>MediaRemoteAdapter</string>
<key>CFBundleIdentifier</key><string>com.vandenbe.MediaRemoteAdapter</string>
<key>CFBundleName</key><string>MediaRemoteAdapter</string>
<key>CFBundlePackageType</key><string>FMWK</string>
<key>CFBundleShortVersionString</key><string>0.1</string>
<key>CFBundleVersion</key><string>0.1.0</string>
</dict></plist>
EOF
ln -s A "$FW/Versions/Current"
ln -s Versions/Current/MediaRemoteAdapter "$FW/MediaRemoteAdapter"
ln -s Versions/Current/Resources "$FW/Resources"
codesign --force --deep --sign - "$FW" 2>/dev/null
cp "$ADAPTER/bin/mediaremote-adapter.pl" "$OUT/"

echo "• self-test"
if /usr/bin/perl "$OUT/mediaremote-adapter.pl" "$FW" get --no-artwork >/dev/null; then
  echo "  MediaRemote adapter OK"
else
  echo "  MediaRemote adapter FAILED — now playing will not work on this macOS version" >&2
  exit 1
fi
