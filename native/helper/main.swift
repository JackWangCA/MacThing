// CarThingHelper — location, calendar and reminders for the bridge. Lives in an .app bundle so
// macOS can ask for (and remember) Location Services, Calendars and Reminders permission under
// its own name.
//
// stdin, one JSON object per line:
//   {"id":1,"cmd":"status"}
//   {"id":2,"cmd":"location"}                          prompts for permission the first time
//   {"id":3,"cmd":"events","from":<ms>,"to":<ms>}      prompts for permission the first time
//   {"id":4,"cmd":"calendars"}
//   {"id":5,"cmd":"reminders","to":<ms>}               prompts for permission the first time
//   {"id":6,"cmd":"reminderLists"}
// stdout, one JSON object per line: replies carry the request's "id"; unsolicited notices
// carry "event": "ready" | "eventKitChanged" | "locationAuthorization".

import AppKit
import CoreLocation
import EventKit
import MapKit
import Foundation

// Be our own "responsible process" so permissions attach to this app, not to node/launchd.
// Re-execs in place (same pid and stdio) with the private disclaim spawn attribute.
func disclaimResponsibility() {
  guard getenv("CARTHING_HELPER_DISCLAIMED") == nil,
    let sym = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "responsibility_spawnattrs_setdisclaim"),
    let path = Bundle.main.executablePath
  else { return }
  typealias SetDisclaim = @convention(c) (UnsafeMutablePointer<posix_spawnattr_t?>, Int32) -> Int32
  var attr: posix_spawnattr_t?
  posix_spawnattr_init(&attr)
  posix_spawnattr_setflags(&attr, Int16(POSIX_SPAWN_SETEXEC))
  _ = unsafeBitCast(sym, to: SetDisclaim.self)(&attr, 1)
  setenv("CARTHING_HELPER_DISCLAIMED", "1", 1)
  var argv: [UnsafeMutablePointer<CChar>?] = CommandLine.arguments.map { strdup($0) } + [nil]
  posix_spawn(nil, path, nil, &attr, &argv, environ)
}
disclaimResponsibility()
setvbuf(stdout, nil, _IOLBF, 0)

/// How long a location request waits for a fresh fix before settling for the last known one.
let FIX_WAIT: TimeInterval = 20

/// A fix already this recent is used as it stands, without waiting for the delegate to deliver
/// another. On a Mac that hasn't moved, startUpdatingLocation() frequently delivers nothing at
/// all: measured after the deadlines were split, three requests in a row sat out the whole of
/// FIX_WAIT and then fell back to this very fix anyway — so the wait bought twenty seconds of
/// nothing, and cost the place name, because no geocode was ever started to find one.
let FIX_FRESH: TimeInterval = 5 * 60

/// And how long the fix then gets to be turned into a place name. These were one 20-second
/// budget covering both, which the geocode kept losing: measured against the live helper, the
/// reverse geocode that succeeded took 17.8s on its own, so whatever the fix had already spent
/// came out of its margin. Requests after it expired at 21.0s with the right coordinates and no
/// name, and the bridge drew "Current location" over a correct forecast. Splitting the two means
/// the geocode always gets its full budget rather than the remainder.
let GEOCODE_WAIT: TimeInterval = 30

func send(_ obj: [String: Any]) {
  guard let data = try? JSONSerialization.data(withJSONObject: obj),
    let line = String(data: data, encoding: .utf8)
  else { return }
  print(line)
}

func hex(_ color: NSColor?) -> String {
  guard let c = color?.usingColorSpace(.sRGB) else { return "#8e8e93" }
  return String(format: "#%02x%02x%02x", Int(c.redComponent * 255), Int(c.greenComponent * 255), Int(c.blueComponent * 255))
}

/// A video-call link from the event's location, URL or notes, for events whose location doesn't
/// say where the meeting is (the link is often only in the invite's notes).
let callPattern = try! NSRegularExpression(
  pattern: #"https?://([a-z0-9-]+\.)*(zoom\.us|meet\.google\.com|teams\.microsoft\.com|teams\.live\.com|webex\.com|facetime\.apple\.com)(/[^\s<>"')]*)?"#,
  options: [.caseInsensitive])
func callLink(_ ev: EKEvent) -> String? {
  for text in [ev.location, ev.url?.absoluteString, ev.notes].compactMap({ $0 }) {
    let range = NSRange(text.startIndex..., in: text)
    if let match = callPattern.firstMatch(in: text, range: range), let r = Range(match.range, in: text) {
      return String(text[r])
    }
  }
  return nil
}

final class Helper: NSObject, CLLocationManagerDelegate {
  let store = EKEventStore()
  let locationManager = CLLocationManager()
  let geocoder = CLGeocoder()
  var locationWaiters: [Any] = []
  var locationDeadline: DispatchWorkItem?
  var geocodeDeadline: DispatchWorkItem?
  var cancelGeocodeRequest: () -> Void = {}
  var askedForCalendar = false
  var askedForReminders = false

  override init() {
    super.init()
    locationManager.delegate = self
    locationManager.desiredAccuracy = kCLLocationAccuracyKilometer
    // One notification for the whole store: it doesn't say whether an event or a reminder moved,
    // so both widgets listen to it and re-read their own half.
    NotificationCenter.default.addObserver(forName: .EKEventStoreChanged, object: store, queue: .main) { _ in
      send(["event": "eventKitChanged"])
    }
  }

  var locationStatus: String {
    switch locationManager.authorizationStatus {
    case .notDetermined: return "notDetermined"
    case .denied: return "denied"
    case .restricted: return "restricted"
    default: return "authorized"
    }
  }

  func entityStatus(_ entity: EKEntityType) -> String {
    switch EKEventStore.authorizationStatus(for: entity) {
    case .notDetermined: return "notDetermined"
    case .denied: return "denied"
    case .restricted: return "restricted"
    case .writeOnly: return "writeOnly"
    case .fullAccess: return "authorized"
    @unknown default: return "unknown"
    }
  }

  var calendarStatus: String { entityStatus(.event) }
  var remindersStatus: String { entityStatus(.reminder) }

  func handle(_ msg: [String: Any]) {
    let id = msg["id"] ?? NSNull()
    switch msg["cmd"] as? String {
    case "status":
      send([
        "id": id, "ok": true, "location": locationStatus, "calendar": calendarStatus,
        "reminders": remindersStatus,
      ])
    case "location":
      location(id)
    case "events":
      events(id, from: msg["from"] as? Double ?? 0, to: msg["to"] as? Double ?? 0)
    case "calendars":
      calendars(id)
    case "reminders":
      reminders(id, to: msg["to"] as? Double ?? 0)
    case "reminderLists":
      reminderLists(id)
    default:
      send(["id": id, "ok": false, "error": "unknown command"])
    }
  }

  // MARK: Location

  func location(_ id: Any) {
    switch locationManager.authorizationStatus {
    case .denied, .restricted:
      send(["id": id, "ok": false, "status": locationStatus])
    case .notDetermined:
      // No deadline yet: the permission panel can sit on screen until someone answers it.
      locationWaiters.append(id)
      locationManager.requestWhenInUseAuthorization()
    default:
      locationWaiters.append(id)
      startLocating()
    }
  }

  /// Continuous updates, stopped at the first fix, rather than requestLocation(). A background
  /// (LSUIElement) agent whose authorization is already settled gets nothing back from the
  /// one-shot call — neither delegate ever fires and the bridge waits out its whole timeout.
  func startLocating() {
    // A waiter that arrives mid-geocode rides along on it: flushLocation answers everyone, and
    // starting a second geocode on the shared CLGeocoder would only break the one in flight.
    guard geocodeDeadline == nil else { return }
    // Nothing to wait for if CoreLocation is already holding something recent.
    if let loc = locationManager.location, -loc.timestamp.timeIntervalSinceNow < FIX_FRESH {
      return startGeocoding(loc)
    }
    locationManager.startUpdatingLocation()
    guard locationDeadline == nil else { return } // a request is already running
    let work = DispatchWorkItem { [weak self] in self?.locationRanOut() }
    locationDeadline = work
    DispatchQueue.main.asyncAfter(deadline: .now() + FIX_WAIT, execute: work)
  }

  /// No fresh fix in time, so the older one CoreLocation holds is the answer. It still gets
  /// geocoded: the coordinates are sound whatever their age — they are what the forecast is
  /// drawn from — and a name costs a tenth of a second now. Replying unnamed here is what put
  /// "Current location" on the screen over a perfectly correct forecast.
  func locationRanOut() {
    locationDeadline = nil
    guard let loc = locationManager.location else {
      return flushLocation(["ok": false, "status": "unavailable", "error": "no location fix"])
    }
    locationManager.stopUpdatingLocation()
    startGeocoding(loc, fresh: false)
  }

  /// Turns the fix into a place name, through MapKit where there is one.
  ///
  /// CLGeocoder is deprecated as of macOS 26, and on 27 it is also barely usable. Measured side
  /// by side against the same coordinates: MKReverseGeocodingRequest answered in 0.10s, and
  /// CLGeocoder took 17.8s on the occasion it answered at all, with the requests either side of
  /// it running the deadline out and coming back empty. That gap was the whole of the bug — the
  /// coordinates were always right, and the Weather screen still read "Current location".
  ///
  /// MKMapItem.placemark is itself deprecated, but it is the one route to the same structured
  /// fields this reply has always carried. The supported accessors only offer "Palo Alto, CA" as
  /// a single string, and splitting a localized address back into city and region is a worse bet
  /// than a deprecated getter.
  ///
  /// The geocode gets its own deadline, started once the fix is in hand rather than sharing the
  /// fix's, and whatever is in flight is cancelled when that expires: a CLGeocoder left running
  /// refuses the next request on the same instance, so a hung one used to take its successor
  /// down with it.
  func startGeocoding(_ loc: CLLocation, fresh: Bool = true) {
    guard geocodeDeadline == nil else { return }
    // Armed before the request goes out: MapKit can answer fast enough to beat it otherwise, and
    // geocoded() ignores anything arriving once the deadline has had its say.
    let work = DispatchWorkItem { [weak self] in
      guard let self else { return }
      self.geocodeDeadline = nil
      self.cancelGeocodeRequest()
      self.cancelGeocodeRequest = {}
      self.flushLocation(self.located(loc, nil, nameError: "geocodeTimedOut", fresh: fresh))
    }
    geocodeDeadline = work
    DispatchQueue.main.asyncAfter(deadline: .now() + GEOCODE_WAIT, execute: work)

    if #available(macOS 26.0, *), let req = MKReverseGeocodingRequest(location: loc) {
      cancelGeocodeRequest = { req.cancel() }
      Task { @MainActor [weak self] in
        do {
          let items = try await req.mapItems
          self?.geocoded(loc, items.first?.placemark, nil, fresh: fresh)
        } catch {
          self?.geocoded(loc, nil, error, fresh: fresh)
        }
      }
    } else {
      cancelGeocodeRequest = { [weak self] in self?.geocoder.cancelGeocode() }
      geocoder.reverseGeocodeLocation(loc) { [weak self] placemarks, err in
        self?.geocoded(loc, placemarks?.first, err, fresh: fresh)
      }
    }
  }

  /// The geocode came back. Main thread only — both callers answer there.
  func geocoded(_ loc: CLLocation, _ placemark: CLPlacemark?, _ err: Error?, fresh: Bool) {
    guard geocodeDeadline != nil else { return } // the deadline already answered for us
    geocodeDeadline?.cancel()
    geocodeDeadline = nil
    cancelGeocodeRequest = {}
    let why = err.map { "geocodeFailed: \($0.localizedDescription)" } ?? "noPlacemark"
    flushLocation(located(loc, placemark, nameError: placemark == nil ? why : nil, fresh: fresh))
  }

  /// A successful fix, named if the geocode managed it. `nameError` says which half fell short
  /// when it didn't — without it an unnamed reply looks the same whether the fix never arrived,
  /// the geocode ran out of time, or it answered with nothing, and those want different fixes.
  func located(_ loc: CLLocation, _ p: CLPlacemark?, nameError: String?, fresh: Bool = true) -> [String: Any] {
    var reply: [String: Any] = [
      "ok": true, "status": "authorized",
      "lat": loc.coordinate.latitude, "lon": loc.coordinate.longitude,
      "accuracy": loc.horizontalAccuracy,
      "name": p?.locality ?? p?.subAdministrativeArea ?? p?.administrativeArea ?? "",
      "region": p?.administrativeArea ?? "", "country": p?.isoCountryCode ?? "",
    ]
    if let nameError { reply["nameError"] = nameError }
    if !fresh { reply["staleFix"] = true } // CoreLocation never delivered a new one in time
    reply["fixAge"] = Int(-loc.timestamp.timeIntervalSinceNow)
    return reply
  }

  func flushLocation(_ reply: [String: Any]) {
    locationDeadline?.cancel()
    locationDeadline = nil
    geocodeDeadline?.cancel()
    geocodeDeadline = nil
    locationManager.stopUpdatingLocation()
    let ids = locationWaiters
    locationWaiters = []
    for id in ids { send(reply.merging(["id": id]) { $1 }) }
  }

  func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
    send(["event": "locationAuthorization", "status": locationStatus])
    guard !locationWaiters.isEmpty else { return }
    switch manager.authorizationStatus {
    case .notDetermined: break
    case .denied, .restricted: flushLocation(["ok": false, "status": locationStatus])
    default: startLocating()
    }
  }

  func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
    guard let loc = locations.last, !locationWaiters.isEmpty else { return }
    locationManager.stopUpdatingLocation() // one fix is enough
    locationDeadline?.cancel() // the fix is in; from here the geocode is on its own clock
    locationDeadline = nil
    startGeocoding(loc)
  }

  func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
    // While updates run, "location unknown" is temporary: keep waiting for the deadline.
    if (error as? CLError)?.code == .locationUnknown { return }
    flushLocation(["ok": false, "status": "unavailable", "error": error.localizedDescription])
  }

  // MARK: Calendar

  func events(_ id: Any, from: Double, to: Double) {
    let status = EKEventStore.authorizationStatus(for: .event)
    if status == .notDetermined && !askedForCalendar {
      askedForCalendar = true
      store.requestFullAccessToEvents { _, _ in
        DispatchQueue.main.async { self.events(id, from: from, to: to) }
      }
      return
    }
    guard status == .fullAccess else {
      send(["id": id, "ok": false, "status": calendarStatus])
      return
    }
    let predicate = store.predicateForEvents(
      withStart: Date(timeIntervalSince1970: from / 1000), end: Date(timeIntervalSince1970: to / 1000), calendars: nil)
    let events = store.events(matching: predicate)
      .filter { ev in
        ev.status != .canceled
          && !(ev.attendees?.contains { $0.isCurrentUser && $0.participantStatus == .declined } ?? false)
      }
      .sorted { $0.startDate < $1.startDate }
      .prefix(80)
      .map { ev -> [String: Any] in
        [
          "title": ev.title ?? "", "location": ev.location ?? "",
          "start": ev.startDate.timeIntervalSince1970 * 1000, "end": ev.endDate.timeIntervalSince1970 * 1000,
          "allDay": ev.isAllDay, "calendar": ev.calendar.title, "color": hex(ev.calendar.color),
          "calendarId": ev.calendar.calendarIdentifier,
          "call": callLink(ev) ?? "",
          // The event's alerts, as ms before its start (negative = after). Location-based
          // ("when I leave") alerts have no time, so they're left out.
          "alerts": (ev.alarms ?? []).filter { $0.proximity == .none }.map { alarm -> Double in
            if let date = alarm.absoluteDate { return (ev.startDate.timeIntervalSince(date)) * 1000 }
            return -alarm.relativeOffset * 1000
          },
        ]
      }
    send(["id": id, "ok": true, "status": "authorized", "events": Array(events)])
  }

  /// Every event calendar the Mac knows about, so the settings page can offer them as choices.
  func calendars(_ id: Any) {
    guard EKEventStore.authorizationStatus(for: .event) == .fullAccess else {
      send(["id": id, "ok": false, "status": calendarStatus])
      return
    }
    let list = store.calendars(for: .event)
      .sorted { ($0.source.title, $0.title) < ($1.source.title, $1.title) }
      .map { cal -> [String: Any] in
        ["id": cal.calendarIdentifier, "title": cal.title, "color": hex(cal.color), "account": cal.source.title]
      }
    send(["id": id, "ok": true, "status": "authorized", "calendars": list])
  }

  // MARK: Reminders

  /// Incomplete reminders due by `to`, overdue ones included. The predicate takes no lower bound,
  /// which is what lets something due last week through; asking for a date range at all is also
  /// what leaves out reminders with no due date, which is what we want on a dashboard.
  func reminders(_ id: Any, to: Double) {
    let status = EKEventStore.authorizationStatus(for: .reminder)
    if status == .notDetermined && !askedForReminders {
      askedForReminders = true
      store.requestFullAccessToReminders { _, _ in
        DispatchQueue.main.async { self.reminders(id, to: to) }
      }
      return
    }
    guard status == .fullAccess else {
      send(["id": id, "ok": false, "status": remindersStatus])
      return
    }
    let predicate = store.predicateForIncompleteReminders(
      withDueDateStarting: nil, ending: Date(timeIntervalSince1970: to / 1000), calendars: nil)
    store.fetchReminders(matching: predicate) { found in
      let list = (found ?? [])
        .compactMap { item -> (EKReminder, Date, Bool)? in
          guard let parts = item.dueDateComponents, let due = Calendar.current.date(from: parts) else { return nil }
          // No hour in the components means a whole-day reminder, which reads "All day" rather
          // than as midnight — the same distinction an all-day event makes.
          return (item, due, parts.hour != nil)
        }
        .sorted { $0.1 < $1.1 }
        .prefix(80)
        .map { item, due, hasTime -> [String: Any] in
          [
            // Whether it's overdue is left to the device: this list is re-read every few minutes,
            // and a deadline that passes in between would otherwise go on reading as upcoming.
            "title": item.title ?? "", "notes": item.notes ?? "",
            "due": due.timeIntervalSince1970 * 1000, "hasTime": hasTime,
            // EKReminder priority is 0 for none, 1–4 high, 5 medium, 6–9 low.
            "priority": item.priority,
            "list": item.calendar.title, "listId": item.calendar.calendarIdentifier,
            "color": hex(item.calendar.color),
          ]
        }
      // fetchReminders answers on its own queue; everything else here replies from main.
      DispatchQueue.main.async {
        send(["id": id, "ok": true, "status": "authorized", "reminders": Array(list)])
      }
    }
  }

  /// Every reminder list on the Mac, so the settings page can offer them as choices. Smart lists
  /// (Today, Scheduled, Flagged) aren't calendars and don't appear here.
  func reminderLists(_ id: Any) {
    guard EKEventStore.authorizationStatus(for: .reminder) == .fullAccess else {
      send(["id": id, "ok": false, "status": remindersStatus])
      return
    }
    let list = store.calendars(for: .reminder)
      .sorted { ($0.source.title, $0.title) < ($1.source.title, $1.title) }
      .map { cal -> [String: Any] in
        ["id": cal.calendarIdentifier, "title": cal.title, "color": hex(cal.color), "account": cal.source.title]
      }
    send(["id": id, "ok": true, "status": "authorized", "reminderLists": list])
  }
}

let helper = Helper()
send([
  "event": "ready", "location": helper.locationStatus, "calendar": helper.calendarStatus,
  "reminders": helper.remindersStatus,
])

Thread {
  while let line = readLine() {
    guard let data = line.data(using: .utf8),
      let msg = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
    else { continue }
    DispatchQueue.main.async { helper.handle(msg) }
  }
  exit(0)  // stdin closed: the bridge went away
}.start()

RunLoop.main.run()
