// musicctl — Apple Music actions for the bridge, sent as Apple Events under this tool's own name,
// so macOS asks once whether "musicctl" may control Music (rather than node or a terminal).
//
//   musicctl status      what the current track is               → {"ok":true,"playing":true,
//                                                                   "inLibrary":false,"favorited":true}
//                        (playing:false — Music is stopped)
//   musicctl library     add the current track to the library,   → {"ok":true,"inLibrary":true}
//                        or remove it if it's already there
//   musicctl favorite    turn "favorited" on the current track   → {"ok":true,"favorited":true}
//                        on, or off if it's already on
//   musicctl library|favorite on|off   …or set either outright, which is what the bridge does:
//                        Music answers with the old value for a moment after a write, so a
//                        direction worked out by reading gets a quick second press wrong.
//   musicctl play        start playback                          → {"ok":true}
// Failures print {"ok":false,"error":"…","code":N} and exit 1.

import Foundation

// Be our own "responsible process" so the Automation grant attaches to musicctl.
// Re-execs in place (same pid and stdio) with the private disclaim spawn attribute.
func disclaimResponsibility() {
  guard getenv("MUSICCTL_DISCLAIMED") == nil,
    let sym = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "responsibility_spawnattrs_setdisclaim"),
    let path = Bundle.main.executablePath
  else { return }
  typealias SetDisclaim = @convention(c) (UnsafeMutablePointer<posix_spawnattr_t?>, Int32) -> Int32
  var attr: posix_spawnattr_t?
  posix_spawnattr_init(&attr)
  posix_spawnattr_setflags(&attr, Int16(POSIX_SPAWN_SETEXEC))
  _ = unsafeBitCast(sym, to: SetDisclaim.self)(&attr, 1)
  setenv("MUSICCTL_DISCLAIMED", "1", 1)
  var argv: [UnsafeMutablePointer<CChar>?] = CommandLine.arguments.map { strdup($0) } + [nil]
  posix_spawn(nil, path, nil, &attr, &argv, environ)
}
disclaimResponsibility()

func reply(_ obj: [String: Any]) {
  let data = try! JSONSerialization.data(withJSONObject: obj)
  print(String(data: data, encoding: .utf8)!)
}

// A streaming track and the library's copy of it are two different tracks, so "is it in the
// library" is a search rather than a property of what's playing.
//
// Album is part of the search, not just name and artist. The same song is often in the library
// twice over quite legitimately — once from the album, once from the single — and matching
// without it treats those as the same track: removing either would take both, which is someone
// else's music deleted by a button press under a knob.
let LIBRARY_MATCH =
  "every track of library playlist 1 whose name is theName and artist is theArtist and album is theAlbum"
// Raised by `library` for a track it won't delete. The bridge shows this message as it reads.
let NOT_SUBSCRIPTION = 1001

let scripts = [
  // Reported as two AppleScript booleans, "<in library>,<favorited>", or "off" when Music is
  // stopped — reading a property of `current track` is an error then, not a blank answer.
  "status": """
    tell application id "com.apple.Music"
      if player state is stopped then return "off"
      set t to current track
      set theName to name of t
      set theArtist to artist of t
      set theAlbum to album of t
      set inLibrary to (count of (\(LIBRARY_MATCH))) > 0
      set isFavorite to favorited of t
      return (inLibrary as text) & "," & (isFavorite as text)
    end tell
    """,
  "play": """
    tell application id "com.apple.Music" to play
    """,
]

/// `library on|off` adds or removes outright; plain `library` reads first and does the opposite.
///
/// Reading first is the thing to avoid. A track duplicated into the library takes a moment to
/// turn up in `library playlist 1`, so a second press that soon still counts zero copies, adds
/// a *second* one, and reports it as another add — which is both the wrong message and a
/// duplicate in the library. The caller that knows what it last set says which way instead.
///
/// "add" takes files, so it's no use for something streaming: duplicating the track is how a
/// subscription track is added. The destination has to be the library *source* — duplicating to
/// library playlist 1 earns "Can only duplicate subscription tracks to library source". The
/// source is found by kind rather than by name, which is localised.
///
/// Removing is `delete`, and it only ever touches a track streamed from Apple Music: a purchase,
/// an upload or a file someone imported looks the same from here, and losing one to a button
/// press under the knob is not a thing to risk. It deletes every copy it finds, which also tidies
/// up after any duplicate an earlier version of this managed to make — copies of the same song
/// on a different album are a different track and are left alone. Deleting re-finds the track
/// each time round: a reference held from the `whose` list comes back as a `shared track` and
/// answers "doesn't understand the delete message", while the same track found by name deletes
/// fine.
///
/// The counter is `found`, not `copies`: Music inherits `copies` from the Standard Suite's print
/// settings, so a variable of that name is read as an application term and the script dies on
/// "Unknown object type" before it gets anywhere near the library.
func libraryScript(_ target: Substring?) -> String {
  // With no direction given, fall back to reading — stale answer and all.
  let wantsIn = target == "on" ? "true" : target == "off" ? "false" : "(found is 0)"
  return """
    tell application id "com.apple.Music"
      if player state is stopped then error "Nothing is playing in Music" number 1
      set t to current track
      set theName to name of t
      set theArtist to artist of t
      set theAlbum to album of t
      set found to count of (\(LIBRARY_MATCH))
      if \(wantsIn) then
        if found is 0 then duplicate t to (first source whose kind is library)
        return true
      end if
      repeat with aTrack in (\(LIBRARY_MATCH))
        if cloud status of aTrack is not subscription then
          error "Only Apple Music songs can be removed here" number \(NOT_SUBSCRIPTION)
        end if
      end repeat
      repeat found times
        delete (first track of library playlist 1 whose name is theName and artist is theArtist and album is theAlbum)
      end repeat
      return false
    end tell
    """
}

/// `favorite on|off` sets the flag outright; plain `favorite` reads it and writes the opposite.
/// Reading is a beat behind — Music can still answer with the old value more than a second after
/// a write — so two quick presses both read "off" and both turn it on. The caller that knows what
/// it last set says so instead, and only something with no idea falls back to reading.
func favoriteScript(_ target: Substring?) -> String {
  let value = target == "on" ? "true" : target == "off" ? "false" : "not (favorited of t)"
  return """
    tell application id "com.apple.Music"
      if player state is stopped then error "Nothing is playing in Music" number 1
      set t to current track
      set isFavorite to \(value)
      set favorited of t to isFavorite
      return isFavorite
    end tell
    """
}

let arguments = CommandLine.arguments.dropFirst().map { Substring($0) }
let target = arguments.dropFirst().first
let source: String? = switch arguments.first {
case "favorite": favoriteScript(target)
case "library": libraryScript(target)
default: scripts[String(arguments.first ?? "")]
}
guard let command = arguments.first, let source else {
  FileHandle.standardError.write(
    "usage: musicctl status|library [on|off]|favorite [on|off]|play\n".data(using: .utf8)!)
  exit(2)
}

var error: NSDictionary?
let result = NSAppleScript(source: source)?.executeAndReturnError(&error)
if let error {
  reply([
    "ok": false,
    "error": error[NSAppleScript.errorMessage] as? String ?? "AppleScript error",
    "code": error[NSAppleScript.errorNumber] as? Int ?? 0,
  ])
  exit(1)
}
switch command {
case "play": reply(["ok": true])
case "status":
  let flags = (result?.stringValue ?? "off").split(separator: ",")
  if flags.count < 2 {
    reply(["ok": true, "playing": false])
  } else {
    reply(["ok": true, "playing": true, "inLibrary": flags[0] == "true", "favorited": flags[1] == "true"])
  }
case "library": reply(["ok": true, "inLibrary": result?.booleanValue ?? false])
default: reply(["ok": true, "favorited": result?.booleanValue ?? false])
}
