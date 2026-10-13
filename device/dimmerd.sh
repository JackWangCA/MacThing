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

CONF=/var/lib/carthing/dimmer.conf
BL=/sys/class/backlight/aml-bl/brightness # the level; on/off is /sys/class/aml_bl/power

# Defaults. dimmer.conf, generated from bridge/config.js, overrides them.
DELAY=30 # seconds the room must stay darker before the screen dims to match
POLL=1   # seconds between sensor readings

[ -f "$CONF" ] && . "$CONF"

say() { echo "[dimmerd] $*"; }

# Read off sp-als-backlight's own log (raw reading → level, ALS ≥ threshold:level). Higher is
# dimmer on this panel. Below the first entry it holds the dimmest level; past the last one each
# 5% more light is one level brighter, which is how the stock curve carries on.
DARKEST=235
CURVE="13:200 14:185 15:177 16:171 17:166 18:163 19:160 20:157 21:155 22:153 23:151 24:149
25:147 26:146 27:145 28:143 29:142 30:141 31:140 32:139 33:138 34:137 35:136 37:135 38:134 39:133
41:132 42:131 44:130 45:129 47:128 49:127 51:126 53:125 55:124 57:123 59:122 62:121 65:120 67:119
70:118 73:117 77:116 80:115 83:114 87:113 91:112 95:111 100:110 104:109 109:108 114:107 120:106
125:105 131:104 138:103 144:102 151:101 159:100 167:99 175:98 183:97 192:96 202:95 212:94 223:93
234:92 246:91 258:90 271:89 285:88 299:87 314:86 330:85 347:84 365:83 384:82 403:81 424:80 446:79
469:78 493:77 520:76 546:75 576:74 604:73 642:72 670:71 708:70 739:69 779:68 836:67 862:66"

# Sets LEVEL for a sensor reading (no subshell: this runs every POLL).
level_for() {
  LEVEL=$DARKEST
  at=0
  for p in $CURVE; do
    [ "$1" -ge "${p%:*}" ] || return 0
    at=${p%:*}
    LEVEL=${p#*:}
  done
  while [ "$LEVEL" -gt 1 ] && [ "$1" -ge $((at * 105 / 100)) ]; do
    at=$((at * 105 / 100))
    LEVEL=$((LEVEL - 1))
  done
}

SENSOR=""
for f in /sys/bus/iio/devices/*/in_intensity0_raw; do
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
say "started at $cur (dims after ${DELAY}s darker, sensor $SENSOR)"

since=0 # seconds the readings have all asked for dimmer than cur
hold="" # the brightest level asked for in that time

while :; do
  als=""
  read -r als < "$SENSOR" 2>/dev/null
  case "$als" in '' | *[!0-9]*) sleep "$POLL"; continue ;; esac
  level_for "$als"

  if [ "$LEVEL" -le "$cur" ]; then
    since=0
    hold=""
    if [ "$LEVEL" -ne "$cur" ]; then
      cur=$LEVEL
      echo "$cur" > "$BL" 2>/dev/null
    fi
  else
    since=$((since + POLL))
    if [ -z "$hold" ] || [ "$LEVEL" -lt "$hold" ]; then hold=$LEVEL; fi
    if [ "$since" -ge "$DELAY" ]; then
      # Only as dim as every reading in the window agreed on.
      say "dark for ${since}s: $cur → $hold (sensor $als)"
      cur=$hold
      echo "$cur" > "$BL" 2>/dev/null
      since=0
      hold=""
    fi
  fi

  sleep "$POLL"
done
