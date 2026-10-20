#!/bin/zsh
# Runs the bridge at login (and keeps it running) via a per-user LaunchAgent.
#   scripts/launch-agent.sh install | uninstall | restart | status | logs
set -euo pipefail

ROOT="${0:A:h:h}"
LABEL="com.carthing.bridge"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/carthing-bridge.log"
DOMAIN="gui/$(id -u)"

case "${1:-}" in
  install)
    NODE="$(command -v node)" || { echo "node not found on PATH" >&2; exit 1; }
    ADB="$(command -v adb)" || { echo "adb not found on PATH (brew install android-platform-tools)" >&2; exit 1; }
    [[ -x "$ROOT/native/bin/MacThingVolume" ]] || { echo "Run npm run build first" >&2; exit 1; }
    mkdir -p "${PLIST:h}"
    cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>$NODE</string><string>$ROOT/bridge/main.js</string></array>
  <key>WorkingDirectory</key><string>$ROOT</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${ADB:h}:${NODE:h}:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict>
</plist>
EOF
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
    launchctl bootstrap "$DOMAIN" "$PLIST"
    echo "Installed $LABEL (node: $NODE). Logs: $LOG"
    ;;
  uninstall)
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
    rm -f "$PLIST"
    echo "Removed $LABEL"
    ;;
  restart)
    launchctl kickstart -k "$DOMAIN/$LABEL"
    echo "Restarted $LABEL"
    ;;
  status)
    launchctl print "$DOMAIN/$LABEL" 2>/dev/null | grep -E "^\s*(state|pid|last exit code) =" | head -3 || echo "not installed"
    ;;
  logs)
    tail -n 50 -f "$LOG"
    ;;
  *)
    echo "usage: $0 install|uninstall|restart|status|logs" >&2
    exit 2
    ;;
esac
