#!/bin/zsh
# The MacThing image: Spotify's system on the Car Thing with Spotify's own software taken out, the
# same build in both of its system slots. Needs the Car Thing connected with adb access.
#
#   backup        Dumps bootloader, env, misc, boot_a/b and system_a/b to the Mac, checksummed.
#                 Everything else here refuses to run until there is one.
#   build         Strips the running system: Spotify's app, its voice models and stock web app,
#                 its updater and its dimmer go; Bluetooth stays installed but isn't started.
#                 Chromium boots straight into /var/lib/carthing/ui, and supervisord.conf is
#                 replaced whole by device/supervisord.conf.
#   mirror        Copies the running system slot over the other one. The bootloader falls back to
#                 the other slot after a failed boot, and a slot that was never set up brings back
#                 "Welcome to Car Thing" — this is what keeps that from happening.
#   export        Saves the running system slot as an image on the Mac.
#   flash <img>   Writes an exported image to the slot that is not running.
#   logo          Replaces the boot picture (Thing Labs' logo on a community-flashed device) with
#                 the MacThing wordmark from scripts/boot-logo/. The logo partition has no A/B
#                 pair; it is backed up first like the rest.
#   all           backup (unless there is one), build, mirror, export, logo. `./macthing image`.
#
# Only the system slots and the boot picture are ever written. Rolling back the running slot needs USB burn mode — see
# "MacThing image" in README.md — because over adb only the slot that isn't running can be written.
set -euo pipefail

here=${0:A:h}
repo=${here:h}

serial=$(adb devices -l | awk '/spotify-car-thing|Car_Thing/ && $2=="device" {print $1; exit}')
[[ -n "$serial" ]] || { echo "No Car Thing found over adb" >&2; exit 1; }

backup_dir="$HOME/Library/Application Support/carthing-now-playing/device-backup/$serial"
parts=(bootloader env misc logo boot_a boot_b system_a system_b)

dev() { adb -s "$serial" shell "$@" | tr -d '\r'; }
# For anything that changes the device. A command that prints nothing, with adb's output going to a
# pipe, gets cut off early on this adbd: dd made its output file and wrote nothing to it. So the
# command runs in a subshell (its own traps fire first), then reports its exit code, and adb can't
# return before that last line. Fails the script unless the code is 0.
run() {
  local out
  out=$(adb -s "$serial" shell "( $1 ); echo __rc=\$?" | tr -d '\r')
  [[ -n ${out%%__rc=*} ]] && print -r -- "${${out%%__rc=*}%$'\n'}"
  [[ ${out##*__rc=} == 0 ]] || { echo "device command failed (exit ${out##*__rc=})" >&2; exit 1; }
}
# Copies a whole partition to a file on the Mac. Staged on the device's /var and pulled, because
# this adbd has no exec-out and `adb shell` turns every \n in the data into \r\n.
pull_part() {
  run "dd if=/dev/$1 of=/var/macthing-dump.img bs=1M 2>/dev/null"
  adb -s "$serial" pull /var/macthing-dump.img "$2" >/dev/null 2>&1
  run 'rm -f /var/macthing-dump.img'
}
active_slot() { dev 'for o in $(cat /proc/cmdline); do case $o in androidboot.slot_suffix=*) echo ${o#*=};; esac; done'; }
other_slot() { [[ $1 == _a ]] && echo _b || echo _a; }

backup_complete() {
  [[ -f "$backup_dir/SHA256SUMS" ]] || return 1
  (cd "$backup_dir" && shasum -a 256 -c SHA256SUMS >/dev/null 2>&1)
}

# Dumps one partition into the backup and adds it to SHA256SUMS, checked against the device.
backup_part() {
  local p=$1
  printf '• %s… ' $p
  pull_part $p "$backup_dir/$p.img.partial"
  local here_sum=$(shasum -a 256 "$backup_dir/$p.img.partial" | awk '{print $1}')
  local there_sum=$(dev "sha256sum /dev/$p" | awk '{print $1}')
  [[ "$here_sum" == "$there_sum" ]] || { echo "checksum mismatch (Mac $here_sum, device $there_sum)" >&2; exit 1; }
  mv "$backup_dir/$p.img.partial" "$backup_dir/$p.img"
  echo "$here_sum  $p.img" >> "$backup_dir/SHA256SUMS.partial"
  echo "$(( $(stat -f %z "$backup_dir/$p.img") / 1048576 )) MB, verified"
}

cmd_backup() {
  if backup_complete; then
    echo "• backup already in $backup_dir"
    return
  fi
  mkdir -p "$backup_dir"
  rm -f "$backup_dir/SHA256SUMS.partial"
  for p in $parts; do backup_part $p; done
  mv "$backup_dir/SHA256SUMS.partial" "$backup_dir/SHA256SUMS"
  echo "• backup complete: $backup_dir"
}

require_backup() {
  backup_complete || { echo "No complete backup yet — run: $0 backup" >&2; exit 1; }
}

cmd_build() {
  require_backup
  local version="$(git -C "$repo" rev-parse --short HEAD) $(date +%Y-%m-%d)"
  run 'mkdir -p /var/lib/carthing/ui'
  adb -s "$serial" push "$repo/device/sleepd.sh" /var/lib/carthing/sleepd.sh >/dev/null
  adb -s "$serial" push "$repo/device/dimmerd.sh" /var/lib/carthing/dimmerd.sh >/dev/null
  adb -s "$serial" push "$repo/device/inputd.sh" /var/lib/carthing/inputd.sh >/dev/null
  adb -s "$serial" push "$repo/device/supervisord.conf" /tmp/macthing-supervisord.conf >/dev/null
  run "
set -e
chmod +x /var/lib/carthing/sleepd.sh /var/lib/carthing/dimmerd.sh /var/lib/carthing/inputd.sh
[ -f /var/lib/carthing/ui/index.html ] || echo '<body style=\"background:#121212\"></body>' > /var/lib/carthing/ui/index.html

mount -o remount,rw /
trap 'sync; mount -o remount,ro /' EXIT

cp /tmp/macthing-supervisord.conf /etc/supervisord.conf
rm -f /etc/supervisord.conf.spotify
echo '• supervisord.conf: our UI at boot, no Spotify app or updater, Bluetooth off'

# Stopped first: a program still running from a deleted binary keeps / from going read-only again.
supervisorctl stop swupdate superbird >/dev/null 2>&1 || true
rm -rf /usr/share/qt-superbird-app /etc/qt-superbird-app /usr/bin/qt-superbird-app
echo '• removed Spotify'\''s app, its stock web app and its voice models'
rm -f /usr/bin/swupdate /usr/bin/swupdate-client /etc/spotify-public.pem /etc/swupdate-public.pem
echo '• removed the OTA updater'
rm -f /usr/bin/sp-als-backlight
echo '• removed the stock dimmer'

# Weston shows this picture from when it takes the screen until Chromium paints: about 4 seconds
# that would otherwise be black between the boot logo and the UI. Stock pointed it into Spotify's
# web app, removed above.
sed -i 's|^background-image=.*|background-image=/var/lib/carthing/ui/images/appstart.png|' /etc/aml-weston.ini
sed -i 's|^background-color=.*|background-color=0xff000000|' /etc/aml-weston.ini
echo '• Weston shows the MacThing splash until the UI paints'

echo '$version' > /etc/macthing-image
echo '• image version $version'
"
  # update applies the new conf: superbird and swupdate go, chromium restarts on its new URL. The
  # backlight comes back the way it was, so a screen the bridge had turned off stays off.
  run '
lit=yes
supervisorctl status backlight 2>/dev/null | grep -q STOPPED && lit=no
supervisorctl reread >/dev/null 2>&1; supervisorctl update >/dev/null 2>&1
supervisorctl stop bluetoothd >/dev/null 2>&1 || true
[ "$lit" = no ] && supervisorctl stop backlight >/dev/null 2>&1
supervisorctl status; true'
}

cmd_mirror() {
  local active=$(active_slot) other
  [[ $active == _a || $active == _b ]] || { echo "Can't tell which slot is running ($active)" >&2; exit 1; }
  other=$(other_slot $active)
  [[ $(dev 'grep -c " / ext4 ro," /proc/mounts') == 1 ]] || { echo "The root filesystem isn't read-only; not copying a live one" >&2; exit 1; }
  # Both slots run the one kernel (boot_a and boot_b are identical), so a copy is only safe while
  # the other slot holds the same release: a different one may be what that kernel expects.
  local versions=("${(@f)$(dev "cat /etc/sw-versions; mkdir -p /tmp/other && mount -o ro /dev/system$other /tmp/other && cat /tmp/other/etc/sw-versions; umount /tmp/other")}")
  [[ ${#versions} == 2 && ${versions[1]} == ${versions[2]} ]] ||
    { echo "system$other is a different release (${versions[2]:-unreadable}, running ${versions[1]}); not overwriting it" >&2; exit 1; }
  echo "• copying system$active over system$other…"
  run "dd if=/dev/system$active of=/dev/system$other bs=1M 2>/dev/null && sync"
  local sums=("${(@f)$(dev "md5sum /dev/system$active /dev/system$other" | awk '{print $1}')}")
  [[ ${sums[1]} == ${sums[2]} ]] || { echo "system$other doesn't match after the copy" >&2; exit 1; }
  run "mkdir -p /tmp/other && mount -o ro /dev/system$other /tmp/other && cat /tmp/other/etc/macthing-image; umount /tmp/other" |
    sed "s/^/• system$other now carries /"
}

cmd_export() {
  require_backup
  local version=$(dev 'cat /etc/macthing-image 2>/dev/null' | awk '{print $1}')
  [[ -n "$version" ]] || { echo "The running system isn't a MacThing image yet — run: $0 build" >&2; exit 1; }
  local active=$(active_slot) out="$backup_dir/macthing-system-$version.img"
  pull_part system$active "$out.partial"
  [[ "$(shasum -a 256 "$out.partial" | awk '{print $1}')" == "$(dev "sha256sum /dev/system$active" | awk '{print $1}')" ]] ||
    { echo "checksum mismatch exporting system$active" >&2; exit 1; }
  mv "$out.partial" "$out"
  echo "• exported $out"
}

cmd_flash() {
  local img=${1:?usage: $0 flash <image>}
  require_backup
  local other=$(other_slot $(active_slot))
  local size=$(dev "cat /sys/class/block/\$(basename \$(readlink -f /dev/system$other))/size")
  (( $(stat -f %z "$img") == size * 512 )) || { echo "$img isn't the size of system$other" >&2; exit 1; }
  echo "• writing $img to system$other (not the running slot)…"
  adb -s "$serial" push "$img" /var/macthing-flash.img >/dev/null
  run "dd if=/var/macthing-flash.img of=/dev/system$other bs=1M 2>/dev/null && sync; rm -f /var/macthing-flash.img"
  [[ "$(md5 -q "$img")" == "$(dev "md5sum /dev/system$other" | awk '{print $1}')" ]] ||
    { echo "system$other doesn't match $img after writing" >&2; exit 1; }
  echo "• system$other written and verified"
}

cmd_logo() {
  require_backup
  # A backup taken before the logo was part of it: add the logo now, before writing over it.
  if [[ ! -f "$backup_dir/logo.img" ]]; then
    cp "$backup_dir/SHA256SUMS" "$backup_dir/SHA256SUMS.partial"
    backup_part logo
    mv "$backup_dir/SHA256SUMS.partial" "$backup_dir/SHA256SUMS"
  fi
  # Always packed from the backed-up original, so a rerun gives the same partition.
  local work=$(mktemp -d)
  (cd "$work" && swift "$here/boot-logo/render.swift")
  node "$here/boot-logo/pack.js" "$backup_dir/logo.img" "$work/portrait.rgba" "$work/logo.img"
  local want=$(md5 -q "$work/logo.img")
  if [[ "$(dev 'md5sum /dev/logo' | awk '{print $1}')" == "$want" ]]; then
    echo "• boot picture already the MacThing wordmark"
  else
    adb -s "$serial" push "$work/logo.img" /var/macthing-logo.img >/dev/null
    run 'dd if=/var/macthing-logo.img of=/dev/logo bs=1M 2>/dev/null && sync; rm -f /var/macthing-logo.img'
    [[ "$(dev 'md5sum /dev/logo' | awk '{print $1}')" == "$want" ]] || { echo "the logo partition doesn't match after writing" >&2; exit 1; }
    echo "• boot picture written and verified; it shows from the next boot"
  fi
  rm -rf "$work"
}

case ${1:-} in
  backup) cmd_backup ;;
  build) cmd_build ;;
  mirror) cmd_mirror ;;
  export) cmd_export ;;
  flash) cmd_flash "${2:-}" ;;
  logo) cmd_logo ;;
  all) cmd_backup; cmd_build; cmd_mirror; cmd_export; cmd_logo ;;
  *) sed -n '2,/^set -euo/p' "$0" | sed '$d; s/^# \{0,1\}//'; exit 1 ;;
esac
