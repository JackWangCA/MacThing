# Bottlerocket SSO — parked, not built

Nothing here is compiled or imported. `native/build.sh` doesn't build it and the bridge doesn't
load it. The usage widget authenticates with a personal API token again
(`bridge/widgets/bottlerocket-usage.js`). This is kept because the hard part — finding a way to
get a bearer token at all — does work, and if Tesla's policy changes it is ready to go.

- `main.swift` — a WKWebView that loads the usage dashboard and reads the `Authorization` header
  off the first call the page makes to the backend.
- `Info.plist` — the bundle identifier is what WebKit files the cookies under.
- `bridge-wrapper.js` — the Node side: runs the app, caches the token until its JWT `exp` less
  five minutes, backs off for 30 minutes after a failure. Its relative imports assume its old
  home, `bridge/mac/bottlerocket-auth.js`; put it back there to revive it.

## Why it was parked

The token minting itself was never the problem. It worked, repeatedly, in about 5 seconds. What
failed is the thing underneath it: **silent re-authorisation is Tesla's conditional-access policy
to grant, and it stopped being granted.**

On the day this was written, silent re-auth worked all morning and then stopped. Afterwards, with
a freshly completed interactive sign-in and `ESTSAUTHPERSISTENT` sitting valid in the jar, three
consecutive silent attempts — fully offscreen, one pixel on-screen, and the original visible
window — all bounced to the Microsoft sign-in page and stayed there, leaving a pile of `esctx-*`
cookies behind. Same result from every configuration, so it isn't this code.

The likely reason is that the policy wants a managed browser: Safari and Chrome carry the
Microsoft SSO extension, a bare WKWebView doesn't. The persistent cookie's lifetime dropped from
90 days to 7 between the morning and the evening, which fits a policy change. Either way it isn't
something this side can satisfy, and an auth path that can be withdrawn without notice is a poor
foundation for a widget that is meant to just sit there.

## Things learnt here that are worth not re-learning

- **An ordinary `NSWindow` cannot be put offscreen.** AppKit's `constrainFrameRect(_:to:)` drags
  it back onto a display as it is ordered in, so a window asked for at (-20000, -20000) arrives at
  (0, 468) — fully visible, alpha 1 — and a run meant to be invisible pops a browser window in
  your face every time. `UnconstrainedWindow` here overrides that.
- **But offscreen then breaks WebKit.** A window on no display, or at `alphaValue = 0`, reads as
  one nobody can see; the page is suspended and the sign-in never completes. Measured at 63s of
  nothing, three times. One pixel left on-screen was not enough either. So: there is no known
  placement that is both invisible and functional. Anything built on this has to accept a visible
  window, which on its own is a good reason not to poll with it.
- The tokens site's Azure app registration has public client flows off, so device-code
  redemption is refused outright — `AADSTS9002326` with an Origin, `AADSTS7000218` without one.
  That is why there is a browser here at all.
- WebKit seeds a new app's cookie jar from the system store on first use, then keeps its own at
  `~/Library/HTTPStorages/<bundle-id>.binarycookies`. So a fresh bundle id can inherit a session
  once, which makes "it worked" from a clean build misleading.
