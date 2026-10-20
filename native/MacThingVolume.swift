// MacThingVolume — tiny long-running CoreAudio helper for the Car Thing bridge.
//
// Reads commands on stdin, one per line:
//   get                 emit current state
//   set <0..1>          set output volume
//   delta <-1..1>       nudge output volume (unmutes when raising)
//   mute <0|1>          set mute
//   togglemute
//   key up|down [fine]  press the Mac's volume key (fine = Option+Shift, 1/64 steps);
//                       unlike set/delta this shows the macOS volume indicator
//   requestaccess       ask macOS for the permission `key` needs (shows a prompt once)
//
// Writes one JSON object per line on stdout whenever the state changes
// (including changes made elsewhere, e.g. keyboard volume keys or switching
// output device):
//   {"volume":0.56,"muted":false,"supported":true,"device":"AirPods Pro","keys":true}
//
// `supported` is false when the current output device has no software volume
// (common for HDMI, S/PDIF and some USB DACs). `keys` is whether this helper may
// post volume-key events (System Settings → Privacy & Security → Accessibility).

import AppKit
import AudioToolbox
import CoreAudio
import Foundation

// Become our own "responsible process" so macOS attributes the Accessibility grant
// to MacThingVolume itself rather than to whatever launched it (node, a terminal, Claude…).
// Re-execs in place (same pid, same stdio) using the private disclaim spawn attribute.
func disclaimResponsibility() {
  guard getenv("VOLUMECTL_DISCLAIMED") == nil,
    let sym = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "responsibility_spawnattrs_setdisclaim"),
    let path = Bundle.main.executablePath
  else { return }
  typealias SetDisclaim = @convention(c) (UnsafeMutablePointer<posix_spawnattr_t?>, Int32) -> Int32
  var attr: posix_spawnattr_t?
  posix_spawnattr_init(&attr)
  posix_spawnattr_setflags(&attr, Int16(POSIX_SPAWN_SETEXEC))
  _ = unsafeBitCast(sym, to: SetDisclaim.self)(&attr, 1)
  setenv("VOLUMECTL_DISCLAIMED", "1", 1)
  var argv: [UnsafeMutablePointer<CChar>?] = CommandLine.arguments.map { strdup($0) } + [nil]
  posix_spawn(nil, path, nil, &attr, &argv, environ)
  // Only reached if the re-exec failed; carry on as a normal child process.
}
disclaimResponsibility()

setvbuf(stdout, nil, _IOLBF, 0)

let queue = DispatchQueue(label: "MacThingVolume")
let systemObject = AudioObjectID(kAudioObjectSystemObject)

var defaultDeviceAddr = AudioObjectPropertyAddress(
  mSelector: kAudioHardwarePropertyDefaultOutputDevice,
  mScope: kAudioObjectPropertyScopeGlobal,
  mElement: kAudioObjectPropertyElementMain)
var volumeAddr = AudioObjectPropertyAddress(
  mSelector: kAudioHardwareServiceDeviceProperty_VirtualMainVolume,
  mScope: kAudioDevicePropertyScopeOutput,
  mElement: kAudioObjectPropertyElementMain)
var muteAddr = AudioObjectPropertyAddress(
  mSelector: kAudioDevicePropertyMute,
  mScope: kAudioDevicePropertyScopeOutput,
  mElement: kAudioObjectPropertyElementMain)
var nameAddr = AudioObjectPropertyAddress(
  mSelector: kAudioObjectPropertyName,
  mScope: kAudioObjectPropertyScopeGlobal,
  mElement: kAudioObjectPropertyElementMain)

var currentDevice = AudioDeviceID(0)
var lastEmitted = ""

func defaultOutputDevice() -> AudioDeviceID {
  var id = AudioDeviceID(0)
  var size = UInt32(MemoryLayout<AudioDeviceID>.size)
  AudioObjectGetPropertyData(systemObject, &defaultDeviceAddr, 0, nil, &size, &id)
  return id
}

func deviceName(_ dev: AudioDeviceID) -> String {
  var name: Unmanaged<CFString>?
  var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
  guard AudioObjectGetPropertyData(dev, &nameAddr, 0, nil, &size, &name) == noErr,
    let value = name?.takeRetainedValue()
  else { return "Unknown" }
  return value as String
}

func isSettable(_ dev: AudioDeviceID, _ addr: inout AudioObjectPropertyAddress) -> Bool {
  guard AudioObjectHasProperty(dev, &addr) else { return false }
  var settable: DarwinBoolean = false
  return AudioObjectIsPropertySettable(dev, &addr, &settable) == noErr && settable.boolValue
}

func getVolume(_ dev: AudioDeviceID) -> Float32? {
  guard AudioObjectHasProperty(dev, &volumeAddr) else { return nil }
  var v = Float32(0)
  var size = UInt32(MemoryLayout<Float32>.size)
  guard AudioObjectGetPropertyData(dev, &volumeAddr, 0, nil, &size, &v) == noErr else { return nil }
  return v
}

func getMuted(_ dev: AudioDeviceID) -> Bool {
  guard AudioObjectHasProperty(dev, &muteAddr) else { return false }
  var m = UInt32(0)
  var size = UInt32(MemoryLayout<UInt32>.size)
  AudioObjectGetPropertyData(dev, &muteAddr, 0, nil, &size, &m)
  return m != 0
}

func setVolume(_ dev: AudioDeviceID, _ value: Float32) {
  guard isSettable(dev, &volumeAddr) else { return }
  var v = min(max(value, 0), 1)
  AudioObjectSetPropertyData(dev, &volumeAddr, 0, nil, UInt32(MemoryLayout<Float32>.size), &v)
}

func setMuted(_ dev: AudioDeviceID, _ muted: Bool) {
  guard isSettable(dev, &muteAddr) else { return }
  var m = UInt32(muted ? 1 : 0)
  AudioObjectSetPropertyData(dev, &muteAddr, 0, nil, UInt32(MemoryLayout<UInt32>.size), &m)
}

func emit(force: Bool = false) {
  let dev = currentDevice
  let volume = getVolume(dev)
  let state: [String: Any] = [
    "volume": volume.map { Double($0) } ?? NSNull(),
    "muted": getMuted(dev),
    "supported": volume != nil && isSettable(dev, &volumeAddr),
    "device": deviceName(dev),
    "keys": CGPreflightPostEventAccess(),
  ]
  guard let data = try? JSONSerialization.data(withJSONObject: state, options: [.sortedKeys]),
    let line = String(data: data, encoding: .utf8)
  else { return }
  if force || line != lastEmitted {
    lastEmitted = line
    print(line)
  }
}

let onDeviceChange: AudioObjectPropertyListenerBlock = { _, _ in emit() }

func attach(to dev: AudioDeviceID) {
  if currentDevice != 0 {
    AudioObjectRemovePropertyListenerBlock(currentDevice, &volumeAddr, queue, onDeviceChange)
    AudioObjectRemovePropertyListenerBlock(currentDevice, &muteAddr, queue, onDeviceChange)
  }
  currentDevice = dev
  AudioObjectAddPropertyListenerBlock(dev, &volumeAddr, queue, onDeviceChange)
  AudioObjectAddPropertyListenerBlock(dev, &muteAddr, queue, onDeviceChange)
}

// NX_KEYTYPE_SOUND_UP / NX_KEYTYPE_SOUND_DOWN, posted the way the keyboard does it.
func pressVolumeKey(up: Bool, fine: Bool) {
  let key = up ? 0 : 1
  let mods: NSEvent.ModifierFlags = fine ? [.option, .shift] : []
  for down in [true, false] {
    let state = down ? 0xa : 0xb
    guard
      let event = NSEvent.otherEvent(
        with: .systemDefined, location: .zero,
        modifierFlags: NSEvent.ModifierFlags(rawValue: UInt(state << 8)).union(mods),
        timestamp: 0, windowNumber: 0, context: nil, subtype: 8,
        data1: (key << 16) | (state << 8), data2: -1)
    else { continue }
    event.cgEvent?.post(tap: .cghidEventTap)
  }
}

func handle(_ line: String) {
  let parts = line.split(separator: " ").map(String.init)
  guard let cmd = parts.first else { return }
  let arg = parts.count > 1 ? Float32(parts[1]) : nil
  let dev = currentDevice
  switch cmd {
  case "get":
    emit(force: true)
  case "set":
    if let v = arg { setVolume(dev, v); if v > 0 { setMuted(dev, false) } }
  case "delta":
    if let d = arg, let v = getVolume(dev) {
      setVolume(dev, v + d)
      if d > 0 { setMuted(dev, false) }
    }
  case "mute":
    if let m = arg { setMuted(dev, m != 0) }
  case "togglemute":
    setMuted(dev, !getMuted(dev))
  case "key":
    guard parts.count > 1, parts[1] == "up" || parts[1] == "down" else { break }
    pressVolumeKey(up: parts[1] == "up", fine: parts.contains("fine"))
    return  // the resulting volume change is reported by the property listener
  case "requestaccess":
    _ = CGRequestPostEventAccess()
  default:
    FileHandle.standardError.write("MacThingVolume: unknown command \(cmd)\n".data(using: .utf8)!)
  }
  emit()
}

queue.sync {
  attach(to: defaultOutputDevice())
  emit(force: true)
}

AudioObjectAddPropertyListenerBlock(systemObject, &defaultDeviceAddr, queue) { _, _ in
  attach(to: defaultOutputDevice())
  emit()
}

Thread {
  while let line = readLine() {
    let trimmed = line.trimmingCharacters(in: .whitespaces)
    if !trimmed.isEmpty { queue.async { handle(trimmed) } }
  }
  exit(0)  // stdin closed: the bridge went away
}.start()

dispatchMain()
