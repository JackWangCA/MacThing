#!/bin/sh
# Car Thing auto-brightness — runs on the device itself, under supervisord, in place of Spotify's
# sp-als-backlight.
#
# The stock daemon sets the backlight straight from each light-sensor reading, and the sensor
# sits where a hand goes: reach for the knob or a button and the screen dims under your fingers.
# This uses the same curve, but only follows the room down once it has stayed darker for DELAY
# seconds. Brighter takes effect right away.
#
# Installed at /var/lib/carthing/dimmerd.sh by scripts/setup-device.sh, which points supervisord's
# [program:backlight] at it, so the bridge and sleepd.sh keep stopping and starting it by that
# name. The bridge pushes updates to it, and to /var/lib/carthing/dimmer.conf, whenever it connects.

set -u

CONF=${DIMMER_CONF:-/var/lib/carthing/dimmer.conf} # the overrides are for tests/brightness.test.js
BL=${DIMMER_BL:-/sys/class/backlight/aml-bl/brightness} # the level
POWER=${DIMMER_POWER:-/sys/class/aml_bl/power}          # on/off: "backlight power state: 0|1"

# Defaults. dimmer.conf, generated from bridge/config.js and bridge/settings.js, overrides them.
DELAY=10 # seconds the room must stay darker before the screen dims to match
POLL=1   # seconds between sensor readings
BIAS=0   # Settings → Brightness, -2…+2 notches; positive is brighter
STEP=25  # percent of the room left towards that end of the range that one notch is worth

[ -f "$CONF" ] && . "$CONF"

say() { echo "[dimmerd] $*"; }

# The bridge and sleepd.sh stop this program while the screen is off, since a new level could light
# the backlight again. Check anyway, in case something starts it then (supervisorctl update does).
set_level() {
  p=""
  read -r p < "$POWER" 2>/dev/null
  case "$p" in *0) return 0 ;; esac
  echo "$1" > "$BL" 2>/dev/null
}

# Read off sp-als-backlight's own log (raw reading → level, ALS ≥ threshold:level). Higher is
# dimmer on this panel. Below the first entry it holds the dimmest level; past the last one each
# 5% more light is one level brighter, which is how the stock curve carries on.
DARKEST=235
BRIGHTEST=1
CURVE="13:200 14:185 15:177 16:171 17:166 18:163 19:160 20:157 21:155 22:153 23:151 24:149
25:147 26:146 27:145 28:143 29:142 30:141 31:140 32:139 33:138 34:137 35:136 37:135 38:134 39:133
41:132 42:131 44:130 45:129 47:128 49:127 51:126 53:125 55:124 57:123 59:122 62:121 65:120 67:119
70:118 73:117 77:116 80:115 83:114 87:113 91:112 95:111 100:110 104:109 109:108 114:107 120:106
125:105 131:104 138:103 144:102 151:101 159:100 167:99 175:98 183:97 192:96 202:95 212:94 223:93
234:92 246:91 258:90 271:89 285:88 299:87 314:86 330:85 347:84 365:83 384:82 403:81 424:80 446:79
469:78 493:77 520:76 546:75 576:74 604:73 642:72 670:71 708:70 739:69 779:68 836:67 862:66"

# Sets BASE for a sensor reading — what the curve alone asks for — and then LEVEL, which is BASE
# with Settings → Brightness applied. The two are kept apart so a change to the setting can be
# worked out from the curve's own answer rather than compounded onto an already-shifted one.
# (No subshell: this runs every POLL.)
level_for() {
  BASE=$DARKEST
  at=0
  for p in $CURVE; do
    if [ "$1" -lt "${p%:*}" ]; then bias_level; return 0; fi
    at=${p%:*}
    BASE=${p#*:}
  done
  while [ "$BASE" -gt 1 ] && [ "$1" -ge $((at * 105 / 100)) ]; do
    at=$((at * 105 / 100))
    BASE=$((BASE - 1))
  done
  bias_level
}

# Settings → Brightness. Lower is brighter on this panel, so a positive bias subtracts, and a
# bias of 0 leaves BASE exactly as the curve had it.
#
# The offset belongs here, folded into the level the rest of the loop works with, rather than at
# set_level: the DELAY window compares LEVEL against cur, and cur already carries the offset. An
# unshifted LEVEL would disagree with it on every single poll, so the window would always be open
# and the screen would never settle.
#
# A notch is a share of the distance left to that end of the range, not a share of the level. The
# curve rests near the bright end — a normally lit room asks for about 75 of a 1..235 range — so
# scaling by the level gave a notch of 8 and left the 74 levels of headroom below it untouched;
# on the device the change could not be seen at all. Measuring from the end instead means a notch
# is always worth something at whatever level the room has chosen, the two directions get the
# room each actually has, and neither end can be overshot.
bias_level() {
  if [ "$BIAS" -gt 0 ]; then
    LEVEL=$((BASE - (BASE - BRIGHTEST) * BIAS * STEP / 100))
  elif [ "$BIAS" -lt 0 ]; then
    LEVEL=$((BASE + (DARKEST - BASE) * (0 - BIAS) * STEP / 100))
  else
    LEVEL=$BASE
  fi
  [ "$LEVEL" -lt "$BRIGHTEST" ] && LEVEL=$BRIGHTEST
  [ "$LEVEL" -gt "$DARKEST" ] && LEVEL=$DARKEST
  return 0
}

SENSOR=${DIMMER_SENSOR:-}
for f in /sys/bus/iio/devices/*/in_intensity0_raw; do
  [ -n "$SENSOR" ] && break
  [ -r "$f" ] && SENSOR=$f && break
done
if [ -z "$SENSOR" ]; then
  say "no light sensor — leaving the backlight where it is"
  while :; do sleep 3600; done # stay up so supervisord doesn't restart us in a loop
fi

# Start from whatever is lit now, not from the first reading: the screen is often woken by a
# press, with the hand that pressed still over the sensor.
cur=""
read -r cur < "$BL" 2>/dev/null
case "$cur" in '' | *[!0-9]*) cur=100 ;; esac
# Until the first reading lands, the level on screen is the best guess at what the curve wanted.
BASE=$cur
applied_bias=$BIAS
say "started at $cur (dims after ${DELAY}s darker, brightness $BIAS, sensor $SENSOR)"

since=0 # seconds the readings have all asked for dimmer than cur
hold="" # the brightest level asked for in that time

while :; do
  # Re-read the conf so a brightness change lands within one poll. The bridge rewrites this file
  # whenever the setting changes; restarting the program to pick it up would lose both cur and the
  # hold window, and the file is written in one go so there is no half-written state to read.
  [ -f "$CONF" ] && . "$CONF"

  # A change to the setting skips the DELAY window, which exists to ignore the room moving when it
  # was only a hand. This is not the room: it is someone watching the screen and asking for it to
  # change, and making them wait out DELAY reads as a control that does not work.
  if [ "$BIAS" -ne "$applied_bias" ]; then
    applied_bias=$BIAS
    bias_level # from BASE, so notches don't compound as you step through them
    say "brightness $BIAS: $cur → $LEVEL"
    cur=$LEVEL
    set_level "$cur"
    since=0
    hold=""
  fi

  als=""
  read -r als < "$SENSOR" 2>/dev/null
  case "$als" in '' | *[!0-9]*) sleep "$POLL"; continue ;; esac
  level_for "$als"

  if [ "$LEVEL" -le "$cur" ]; then
    since=0
    hold=""
    if [ "$LEVEL" -ne "$cur" ]; then
      cur=$LEVEL
      set_level "$cur"
    fi
  else
    since=$((since + POLL))
    if [ -z "$hold" ] || [ "$LEVEL" -lt "$hold" ]; then hold=$LEVEL; fi
    if [ "$since" -ge "$DELAY" ]; then
      # Only as dim as every reading in the window agreed on.
      say "dark for ${since}s: $cur → $hold (sensor $als)"
      cur=$hold
      set_level "$cur"
      since=0
      hold=""
    fi
  fi

  sleep "$POLL"
done
