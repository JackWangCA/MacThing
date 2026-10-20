// BottlerocketAuth — a bearer token for backend.bottlerocket.tesla.com, by way of Tesla SSO.
//
//   BottlerocketAuth             silently, from the saved session   → {"ok":true,"token":"…"}
//                                never signed in, or it lapsed      → {"ok":false,"reason":"needsLogin"}
//   BottlerocketAuth --login     a window, to sign in once          → the same, after you do
//   BottlerocketAuth --signout   throw the saved session away       → {"ok":true,"cookies":n}
//
// The tokens site is a single-page app whose Azure registration has public client flows turned
// off: it refuses every device-code redemption, carrying an Origin as AADSTS9002326 and without
// one as AADSTS7000218. So the token is taken from the page that is allowed to mint one. A
// WKWebView loads the dashboard, MSAL re-authorises from cookies this app kept from the last
// sign-in, and the token is read off the first call the page makes to the backend.
//
// An .app bundle because WebKit keys its cookie jar to a bundle identifier
// (~/Library/HTTPStorages/com.carthing.bottlerocketauth.binarycookies). That's a bundle id and
// not a code signature, so rebuilding this doesn't sign you out — unlike the Location and
// Calendars grants on CarThingHelper, which a rebuild does cost.
import Cocoa
import WebKit

let USAGE = "https://tokens.bottlerocket.tesla.com/usage-cost/individual?date_preset_key=24h"
let BACKEND = "backend.bottlerocket.tesla.com"

let login = CommandLine.arguments.contains("--login")
let signout = CommandLine.arguments.contains("--signout")
/// Signing in is a person typing a password and answering a prompt on a phone; re-authorising is
/// a redirect or two. Hence the very different patience, and the retry only the silent path needs.
let ATTEMPT_SECONDS: TimeInterval = login ? 300 : 30
let ATTEMPTS = login ? 1 : 2

// WKWebView shows the app nothing of a request's headers, so the page is asked to tell on itself:
// fetch and XMLHttpRequest are wrapped before any of the site's own script runs, and the first
// Authorization bound for the backend is handed back over the message handler.
let HOOK = """
(function () {
  if (window.__ctHooked) return;
  window.__ctHooked = true;
  function send(auth) {
    if (!auth || !/^bearer /i.test(String(auth))) return;
    try { window.webkit.messageHandlers.auth.postMessage(String(auth).slice(7)); } catch (e) {}
  }
  var origFetch = window.fetch;
  window.fetch = function (input, init) {
    try {
      var url = typeof input === 'string' ? input : (input && input.url) || '';
      if (url.indexOf('\(BACKEND)') >= 0) {
        var h = (init && init.headers) || (input && input.headers);
        if (h) {
          if (typeof h.get === 'function') send(h.get('authorization'));
          else if (Array.isArray(h)) h.forEach(function (p) { if (String(p[0]).toLowerCase() === 'authorization') send(p[1]); });
          else for (var k in h) if (k.toLowerCase() === 'authorization') send(h[k]);
        }
      }
    } catch (e) {}
    return origFetch.apply(this, arguments);
  };
  var origSet = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.setRequestHeader = function (k, v) {
    if (String(k).toLowerCase() === 'authorization') send(v);
    return origSet.apply(this, arguments);
  };
})();
"""

func emit(_ obj: [String: Any]) {
  guard let data = try? JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys]),
    let line = String(data: data, encoding: .utf8)
  else { return }
  print(line)
}

/// AppKit pulls an ordinary window back onto the display as it is ordered in, so asking for one
/// at (-20000, -20000) gets you one at (0, 468) — which is how runs meant to be unattended ended
/// up showing the dashboard, looking for all the world like a surprise demand to sign in.
/// Declining to be constrained is what lets the quiet window sit where it was put.
final class UnconstrainedWindow: NSWindow {
  override func constrainFrameRect(_ frameRect: NSRect, to screen: NSScreen?) -> NSRect { frameRect }
}

final class Auth: NSObject, WKScriptMessageHandler {
  var webView: WKWebView!
  var window: NSWindow!
  var finished = false
  var attempt = 0
  var deadline: DispatchWorkItem?

  func start() {
    let config = WKWebViewConfiguration()
    config.websiteDataStore = .default() // the persistent one: this is what remembers the sign-in
    config.userContentController.add(self, name: "auth")
    config.userContentController.addUserScript(
      WKUserScript(source: HOOK, injectionTime: .atDocumentStart, forMainFrameOnly: false))

    let frame = NSRect(x: 0, y: 0, width: 1100, height: 850)
    webView = WKWebView(frame: frame, configuration: config)

    // Even with nothing to show, the view has to belong to an ordered-in window or WebKit
    // throttles it until it never finishes loading. Offscreen is as headless as this gets.
    window = login
      ? NSWindow(
        contentRect: frame, styleMask: [.titled, .closable, .resizable], backing: .buffered, defer: false)
      : UnconstrainedWindow(
        contentRect: frame, styleMask: [.borderless], backing: .buffered, defer: false)
    window.contentView = webView
    window.title = "Sign in to Bottlerocket"
    if login {
      NSApp.setActivationPolicy(.regular)
      window.center()
      window.makeKeyAndOrderFront(nil)
      NSApp.activate(ignoringOtherApps: true)
    } else {
      // A window has to keep a toe on a display or macOS treats it as something nobody can see,
      // WebKit suspends the page, and the sign-in never finishes — measured twice at 63s of
      // nothing, both fully offscreen and at alphaValue = 0. So it is pushed off until a single
      // pixel of its corner remains, in the corner of the screen, which costs nothing to look at
      // and keeps the page running at full speed. No Dock icon, out of Mission Control and
      // ⌘-tab, and deaf to the mouse, so that pixel can't be clicked by accident either.
      NSApp.setActivationPolicy(.accessory)
      window.ignoresMouseEvents = true
      window.collectionBehavior = [.transient, .ignoresCycle, .stationary]
      window.setFrameOrigin(NSPoint(x: 1 - frame.width, y: 1 - frame.height))
      window.orderBack(nil)
    }
    go(reload: false)
  }

  /// Silent re-authorisation sometimes doesn't take on the first navigation — the page lands back
  /// on the Microsoft sign-in and sits there — and a plain reload fixes it. So one retry.
  func go(reload: Bool) {
    attempt += 1
    if reload {
      webView.reload()
    } else {
      webView.load(URLRequest(url: URL(string: USAGE)!))
    }
    let work = DispatchWorkItem { [weak self] in
      guard let self, !self.finished else { return }
      if self.attempt < ATTEMPTS { self.go(reload: true) } else { self.finish(nil) }
    }
    deadline = work
    DispatchQueue.main.asyncAfter(deadline: .now() + ATTEMPT_SECONDS, execute: work)
  }

  func userContentController(_ c: WKUserContentController, didReceive message: WKScriptMessage) {
    if let token = message.body as? String, !token.isEmpty { finish(token) }
  }

  func finish(_ token: String?) {
    guard !finished else { return }
    finished = true
    deadline?.cancel()
    if let token {
      emit(["ok": true, "token": token])
    } else {
      let host = webView.url?.host ?? ""
      emit([
        "ok": false,
        "reason": login ? "notSignedIn" : "needsLogin",
        "detail": host.contains("microsoftonline")
          ? "the saved sign-in didn't carry over" : "the dashboard never asked the backend for anything",
      ])
    }
    // Give WebKit a moment to write the refreshed cookies before the process goes.
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { exit(token == nil ? 1 : 0) }
  }
}

/// Forgets the sign-in: every cookie and every scrap of stored site data, back to a clean app.
/// Only this app's jar is touched — it is the one WebKit opens for this bundle id.
func signOutAndExit() {
  let store = WKWebsiteDataStore.default()
  // Counted first: the sweep below takes the cookies with it, so afterwards there is nothing
  // left to count and the number would always read zero.
  store.httpCookieStore.getAllCookies { before in
    store.removeData(
      ofTypes: WKWebsiteDataStore.allWebsiteDataTypes(), modifiedSince: Date(timeIntervalSince1970: 0)
    ) {
      // The sweep covers cookies, but it is the sign-in at stake, so check and finish the job.
      store.httpCookieStore.getAllCookies { remaining in
        let group = DispatchGroup()
        for cookie in remaining {
          group.enter()
          store.httpCookieStore.delete(cookie) { group.leave() }
        }
        group.notify(queue: .main) {
          store.httpCookieStore.getAllCookies { left in
            emit(["ok": left.isEmpty, "removed": before.count, "left": left.count])
            // Let WebKit write the empty jar out before the process goes.
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { exit(left.isEmpty ? 0 : 1) }
          }
        }
      }
    }
  }
}

setvbuf(stdout, nil, _IOLBF, 0)
let app = NSApplication.shared
let auth = Auth()
DispatchQueue.main.async {
  if signout {
    NSApp.setActivationPolicy(.accessory)
    signOutAndExit()
  } else {
    auth.start()
  }
}
app.run()
