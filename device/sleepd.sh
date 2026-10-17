#!/bin/sh
# Car Thing sleep watchdog — runs on the device itself, under supervisord.
#
# While the bridge is connected it owns the backlight: it writes the heartbeat file every few
# seconds with the state it wants the screen in. When the Mac goes away — shut down, asleep with
# the port still powered, cable pulled, bridge stopped — that heartbeat stops, and nothing else
# on the device would ever turn the backlight off: the "Waiting for your Mac" screen would stay
# lit for as long as the Car Thing has power. This notices, and puts the panel to sleep until
# someone presses a button or turns the knob.
#
# Installed at /var/lib/carthing/sleepd.sh by scripts/setup-device.sh; the bridge pushes updates
# to it, and to /var/lib/carthing/sleep.conf, whenever it connects.

set -u

CONF=${SLEEPD_CONF:-/var/lib/carthing/sleep.conf} # overridable for tests/sleepd.test.js
BL=/sys/class/aml_bl/power  # echo 0|1; the standard backlight/aml-bl/bl_power does nothing here
GOV=/sys/devices/system/cpu/cpu0/cpufreq/scaling_governor
MARK=/tmp/carthing-input
GADGET=/sys/kernel/config/usb_gadget/g1 # built by /etc/init.d/S49usbgadget, at boot only

# Defaults. sleep.conf, generated from bridge/config.js, overrides them.
HB=/tmp/carthing-heartbeat  # what the Mac writes: "<counter> <on|off>"
IDLE=90                     # seconds without a heartbeat before the screen sleeps
WAKE=20                     # seconds awake after a button or knob press while the Mac is away
POLL=1                      # seconds between checks (also the wake-on-input latency)
POWERSAVE=1                 # also idle the CPU while asleep (governor, or a clock cap)
HEAL=180                    # seconds of quiet before rebinding a dead USB gadget (0 = never)
HEAL_PRESS=25               # …or this many, when a button press asks for it (~2 missed heartbeats)
HEAL_MAX=60                 # longest gap between attempts while they keep failing

[ -f "$CONF" ] && . "$CONF"

say() { echo "[sleepd] $*"; }

HAVE_TIMEOUT=no
command -v timeout >/dev/null 2>&1 && HAVE_TIMEOUT=yes
# supervisorctl talks to supervisord over a socket; never block the loop on it.
sctl() {
  if [ "$HAVE_TIMEOUT" = yes ]; then timeout 5 supervisorctl "$@" >/dev/null 2>&1
  else supervisorctl "$@" >/dev/null 2>&1; fi
}

GOV_WAS=""
[ -r "$GOV" ] && read -r GOV_WAS < "$GOV" 2>/dev/null

# This kernel offers "interactive performance schedutil" — there is no powersave governor, and
# writing one that doesn't exist fails silently. Pick whichever idle-friendly governor is really
# there; with none, cap the clock to its lowest step instead. Both are put back on wake.
GOV_IDLE=""
GOV_AVAIL=""
[ -r "${GOV%governor}available_governors" ] && read -r GOV_AVAIL < "${GOV%governor}available_governors" 2>/dev/null
for g in powersave schedutil; do
  case " $GOV_AVAIL " in *" $g "*) GOV_IDLE=$g; break ;; esac
done
MAXF="${GOV%scaling_governor}scaling_max_freq"
MINF="${GOV%scaling_governor}scaling_min_freq"
MAXF_WAS=""
[ -z "$GOV_IDLE" ] && [ -r "$MAXF" ] && read -r MAXF_WAS < "$MAXF" 2>/dev/null

# Same sequence the bridge uses: the ambient-light daemon is paused while the screen is off so
# it can't relight it behind our back.
backlight() {
  if [ "$1" = on ]; then
    echo 1 > "$BL" 2>/dev/null
    sctl start backlight
  else
    sctl stop backlight
    echo 0 > "$BL" 2>/dev/null
  fi
  say "backlight $1"
  return 0
}

# Idle down the CPU too while we're the ones holding the screen off. Only ever changed around
# our own sleep, and always put back before the bridge takes the screen over again.
governor() {
  [ "$POWERSAVE" = 1 ] || return 0
  if [ -n "$GOV_IDLE" ] && [ -n "$GOV_WAS" ] && [ -w "$GOV" ]; then
    if [ "$1" = powersave ]; then echo "$GOV_IDLE" > "$GOV" 2>/dev/null
    else echo "$GOV_WAS" > "$GOV" 2>/dev/null; fi
    say "governor $(cat "$GOV" 2>/dev/null)"
  elif [ -n "$MAXF_WAS" ] && [ -w "$MAXF" ] && [ -r "$MINF" ]; then
    if [ "$1" = powersave ]; then cat "$MINF" > "$MAXF" 2>/dev/null
    else echo "$MAXF_WAS" > "$MAXF" 2>/dev/null; fi
    say "max clock $(cat "$MAXF" 2>/dev/null)"
  fi
  return 0
}

# When the Mac suspends it stops driving the port, and this firmware's gadget doesn't always come
# back with it: the Mac wakes to no Car Thing on the bus. /etc/init.d/S49usbgadget only builds the
# gadget at boot, so the only cure is a full power cycle — a replug doesn't do it while the device
# keeps power from a hub. Rebinding the UDC is that cure, without the unplugging.
#
# The gate is what keeps this safe: it only ever runs when the heartbeat has been quiet for HEAL
# seconds AND no host has the gadget configured. A working link — even an idle one with the bridge
# stopped — reads "configured", so a rebind can never interrupt something that was working.
usb_state() {
  for u in /sys/class/udc/*; do
    [ -r "$u/state" ] || continue
    cat "$u/state" 2>/dev/null
    return 0
  done
  echo unknown
}

udc_dir() {
  for u in /sys/class/udc/*; do [ -d "$u" ] && echo "$u" && return 0; done
  return 1
}

rebind_udc() {
  udc=$(ls -1 /sys/class/udc/ 2>/dev/null | head -1)
  [ -n "$udc" ] || return 1
  echo "" > "$GADGET/UDC" 2>/dev/null
  sleep 1
  echo "$udc" > "$GADGET/UDC" 2>/dev/null
  sleep 2
  [ "$(usb_state)" = configured ]
}

# Returns 0 when USB is usable afterwards, 1 when it still isn't — the caller uses that to decide
# how long to wait before trying again.
heal_usb() {
  [ "$HEAL" -gt 0 ] || return 0
  [ -n "$beat" ] || return 0 # never saw the Mac this run: nothing to win back
  [ "$(usb_state)" = configured ] && return 0
  [ -w "$GADGET/UDC" ] || { say "no $GADGET/UDC — can't rebind"; return 1; }

  # One line of kernel log with it: whoever reads this later wants to know what the controller
  # saw when the host went away, not just that we tried something.
  say "usb $(usb_state) after ${idle}s quiet; last: $(dmesg 2>/dev/null | grep -i 'dwc\|gadget' | tail -1)"

  if rebind_udc; then
    say "usb configured again"
    return 0
  fi

  # adbd serves the gadget's ffs endpoint, and its end of it doesn't survive every unbind. Give it
  # a fresh start and try once more before waiting out the next interval.
  say "still $(usb_state) — restarting adbd"
  killall adbd 2>/dev/null
  sleep 1
  /usr/bin/adbd &
  sleep 2
  if rebind_udc; then
    say "usb configured again"
    return 0
  fi
  say "usb still $(usb_state); next try in ${step}s"
  return 1
}

# Buttons and the knob are evdev devices. Reading one doesn't take the events away from
# Chromium — every open file description gets its own copy — so the UI still sees them.
WATCHERS=""
start_watchers() {
  : > "$MARK"
  for dev in /dev/input/event*; do
    [ -r "$dev" ] || continue
    cat "$dev" >> "$MARK" 2>/dev/null &
    WATCHERS="$WATCHERS $!"
  done
  [ -n "$WATCHERS" ] || say "no readable /dev/input/event* — nothing can wake the screen"
}
stop_watchers() {
  for pid in $WATCHERS; do kill "$pid" 2>/dev/null; done
  WATCHERS=""
}
watchers_alive() {
  [ -n "$WATCHERS" ] || return 1
  for pid in $WATCHERS; do kill -0 "$pid" 2>/dev/null || return 1; done
  return 0
}
# True when something was pressed or turned since the last check; always drains the marker.
input_seen() {
  [ -s "$MARK" ] || return 1
  : > "$MARK"
  return 0
}

cleanup() {
  stop_watchers
  governor restore
  backlight on  # never leave the device dark with no one left to wake it
  exit 0
}
trap cleanup INT TERM

start_watchers
say "started (idle ${IDLE}s, wake ${WAKE}s, heartbeat $HB)"

beat=""     # last heartbeat seen, to spot it standing still
idle=0      # seconds since it last changed
want=on     # screen state the bridge asked for, restored when it comes back
mode=host   # host = the Mac drives the screen; sleep / wake = we do
left=0      # seconds of wake time remaining
ticks=0
step=$HEAL      # gap until the next repair attempt; doubles while they don't stick
next_heal=$HEAL # value of idle at which to try again
good=0          # heartbeats in a row, to tell a real link from one that dies again
usb_prev=$(usb_state) # last USB state seen, to notice the host coming back
cooldown=0      # seconds to wait before another state-triggered attempt
handed=""       # state we handed the screen over in, until the next heartbeat confirms it

while :; do
  hb=""
  [ -f "$HB" ] && read -r hb < "$HB" 2>/dev/null
  if [ -n "$hb" ] && [ "$hb" != "$beat" ]; then
    beat="$hb"
    idle=0
    good=$((good + 1))
    # A link that lasted about a minute is a real one: earn back the short retry gap.
    if [ "$good" -ge 6 ]; then step=$HEAL; next_heal=$HEAL; fi
    case "$hb" in *" off") want=off ;; *) want=on ;; esac
    # The beat we handed over on may have been written before the bridge set the screen — then
    # it went dark behind the bridge's back and the bridge, believing it lit, never fixed it.
    # Settle it on the one after: by then the bridge's own setScreen and heartbeat have landed.
    if [ "$mode" = host ] && [ -n "$handed" ]; then
      [ "$want" != "$handed" ] && backlight "$want"
      handed=""
    fi
  else
    idle=$((idle + POLL))
    [ "$idle" -ge "$HEAL_PRESS" ] && good=0
  fi

  input=no
  input_seen && input=yes

  if [ "$idle" -lt "$IDLE" ]; then
    if [ "$mode" != host ]; then
      mode=host
      governor restore
      backlight "$want"  # the Mac is back: hand the screen over in the state it wants
      handed=$want
    fi
  else
    case "$mode" in
      host)
        mode=sleep
        say "no heartbeat for ${IDLE}s — sleeping"
        backlight off
        governor powersave
        ;;
      sleep)
        if [ "$input" = yes ]; then mode=wake; left=$WAKE; governor restore; backlight on; fi
        ;;
      wake)
        if [ "$input" = yes ]; then
          left=$WAKE
        else
          left=$((left - POLL))
          if [ "$left" -le 0 ]; then mode=sleep; backlight off; governor powersave; fi
        fi
        ;;
    esac
  fi

  # Then see whether USB needs rebinding: every HEAL seconds of quiet, and right away on a button
  # press, since someone reaching for it is the clearest sign they want it back. This runs after
  # the screen work above so a press lights the panel first — rebinding takes a few seconds.
  #
  # The gap stretches while attempts don't stick, but never past HEAL_MAX: on a hub that drops the
  # port nightly this is the only way back, and a Mac woken in the morning shouldn't wait longer
  # than that for the device to reappear on its own.
  # The controller's state changing while we're quiet means the host did something — plugged in,
  # woke up, powered the port again. React to that rather than waiting out the interval.
  [ "$cooldown" -gt 0 ] && cooldown=$((cooldown - POLL))
  usb_now=$(usb_state)
  if [ "$usb_now" != "$usb_prev" ]; then
    usb_prev=$usb_now
    if [ "$HEAL" -gt 0 ] && [ "$usb_now" != configured ] && [ "$idle" -ge "$HEAL_PRESS" ] && [ "$cooldown" -le 0 ]; then
      say "usb changed to $usb_now while quiet — trying now"
      heal_usb
      usb_prev=$(usb_state)
      cooldown=20
      next_heal=$((idle + step))
    fi
  fi

  if [ "$HEAL" -gt 0 ]; then
    if [ "$input" = yes ] && [ "$idle" -ge "$HEAL_PRESS" ]; then
      heal_usb
      usb_prev=$(usb_state)
      cooldown=20
      next_heal=$((idle + step))
    elif [ "$idle" -ge "$next_heal" ]; then
      # Grow the gap only while attempts fail — a failure means the host isn't there. One that
      # works means it is, so go straight back to the short interval.
      if heal_usb; then step=$HEAL
      else
        step=$((step * 2))
        [ "$step" -gt "$HEAL_MAX" ] && step=$HEAL_MAX
      fi
      usb_prev=$(usb_state)
      cooldown=20
      next_heal=$((idle + step))
    fi
  fi

  ticks=$((ticks + 1))
  if [ $((ticks % 30)) -eq 0 ] && ! watchers_alive; then
    say "input watchers stopped; restarting them"
    stop_watchers
    start_watchers
  fi

  sleep "$POLL"
done
