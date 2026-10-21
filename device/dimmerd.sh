#!/bin/sh
# Car Thing auto-brightness — runs on the device itself, under supervisord, in place of Spotify's
# sp-als-backlight.
#
# The stock daemon sets the backlight straight from each light-sensor reading, and the sensor
# sits where a hand goes: reach for the knob or a button and the screen dims under your fingers.
# This uses the same curve, but only follows the room once it has read that way for DELAY seconds
# going darker, or RISE going brighter, and it fades between levels instead of stepping.
#
# Both directions wait, for different lengths. Only guarding the dim was not enough: a hand
# crossing the sensor reflects the screen back into it, so reaching for a button reads as a spike
# of light and the screen jumped brighter on the next reading. Worse, that reset the dim window,
# so the wrong level then held for another DELAY seconds. RISE is the shorter of the two — a room
# whose lights come on should catch up quickly, while a room going dark can afford to wait.
#
# Installed at /var/lib/carthing/dimmerd.sh by scripts/setup-device.sh, which points supervisord's
# [program:backlight] at it, so the bridge and sleepd.sh keep stopping and starting it by that
# name. The bridge pushes updates to it, and to /var/lib/carthing/dimmer.conf, whenever it connects.

set -u

CONF=/var/lib/carthing/dimmer.conf
BL=/sys/class/backlight/aml-bl/brightness # the level
POWER=/sys/class/aml_bl/power             # on/off: "backlight power state: 0|1"

# Defaults. dimmer.conf, generated from bridge/config.js, overrides them.
DELAY=10 # seconds the room must stay darker before the screen dims to match
RISE=3   # and brighter, before it brightens to match
POLL=1   # seconds between sensor readings
FADE=400 # milliseconds a change takes; 0 steps straight there
FADEMAX=24 # most writes one fade makes, so a big change isn't a slow crawl

[ -f "$CONF" ] && . "$CONF"

say() { echo "[dimmerd] $*"; }

# usleep is what makes a fade a fade. Without it the only wait available is a whole second a
# step, which would drag a 24-step change out over the best part of half a minute — far worse
# than the snap it was meant to smooth. So decide once, here, rather than per step.
if [ "$FADE" -gt 0 ] && ! command -v usleep >/dev/null 2>&1; then
  say "no usleep — stepping straight to each level instead of fading"
  FADE=0
fi

# The bridge and sleepd.sh stop this program while the screen is off, since a new level could light
# the backlight again. Check anyway, in case something starts it then (supervisorctl update does).
set_level() {
  p=""
  read -r p < "$POWER" 2>/dev/null
  case "$p" in *0) return 0 ;; esac
  echo "$1" > "$BL" 2>/dev/null
}

# Walk to a level instead of jumping to it. One write was a visible snap, and the jumps are not
# small: the curve's bottom entry is 200 and anything darker than it is 235, so a hand over the
# sensor moves the backlight 35 levels at once. Each write is a sysfs poke, so the number of them
# is capped and the step grows for a big change rather than the fade taking longer.
# Checks POWER through set_level on every step: the screen can be put to sleep mid-fade.
fade_to() {
  to=$1
  delta=$((to - cur))
  [ "$delta" = 0 ] && return 0
  steps=$delta
  [ "$steps" -lt 0 ] && steps=$((-steps))
  [ "$steps" -gt "$FADEMAX" ] && steps=$FADEMAX
  if [ "$FADE" -le 0 ] || [ "$steps" -le 1 ]; then
    cur=$to
    set_level "$cur"
    return 0
  fi
  nap=$((FADE * 1000 / steps)) # microseconds per step
  i=1
  while [ "$i" -lt "$steps" ]; do
    set_level $((cur + delta * i / steps))
    usleep "$nap" 2>/dev/null
    i=$((i + 1))
  done
  cur=$to
  set_level "$cur"
}

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
    t=${p%:*}
    if [ "$1" -lt "$t" ]; then
      # Below the curve's first entry the stock daemon has nothing, and took the dimmest level
      # for all of it — so a reading of 12 was 35 levels darker than a reading of 13, and a hand
      # over the sensor dropped the backlight to minimum in one move. Slide across that gap.
      [ "$at" -eq 0 ] && LEVEL=$((DARKEST - (DARKEST - ${p#*:}) * $1 / t))
      return 0
    fi
    at=$t
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
say "started at $cur (dims after ${DELAY}s darker, brightens after ${RISE}s lighter, ${FADE}ms fade, sensor $SENSOR)"

# One window per direction. A reading that disagrees with a window clears it: the room has to
# read the same way throughout, and a hand waved over the sensor belongs to neither run, so it
# simply holds the level where it is rather than moving it.
dim_since=0  # seconds every reading has asked for dimmer than cur
dim_hold=""  # the brightest of those readings
rise_since=0 # and the same going the other way
rise_hold="" # the dimmest of those readings

while :; do
  als=""
  read -r als < "$SENSOR" 2>/dev/null
  case "$als" in '' | *[!0-9]*) sleep "$POLL"; continue ;; esac
  level_for "$als"

  if [ "$LEVEL" -gt "$cur" ]; then
    rise_since=0
    rise_hold=""
    dim_since=$((dim_since + POLL))
    if [ -z "$dim_hold" ] || [ "$LEVEL" -lt "$dim_hold" ]; then dim_hold=$LEVEL; fi
    if [ "$dim_since" -ge "$DELAY" ]; then
      # Only as dim as every reading in the window agreed on.
      say "dark for ${dim_since}s: $cur → $dim_hold (sensor $als)"
      fade_to "$dim_hold"
      dim_since=0
      dim_hold=""
    fi
  elif [ "$LEVEL" -lt "$cur" ]; then
    dim_since=0
    dim_hold=""
    rise_since=$((rise_since + POLL))
    if [ -z "$rise_hold" ] || [ "$LEVEL" -gt "$rise_hold" ]; then rise_hold=$LEVEL; fi
    if [ "$rise_since" -ge "$RISE" ]; then
      # And only as bright: a single reflected flash off a passing hand is not the room.
      say "light for ${rise_since}s: $cur → $rise_hold (sensor $als)"
      fade_to "$rise_hold"
      rise_since=0
      rise_hold=""
    fi
  else
    dim_since=0
    dim_hold=""
    rise_since=0
    rise_hold=""
  fi

  sleep "$POLL"
done
