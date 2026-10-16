# 1.0.0 release artwork

[Open the 1.0.0 Figma page](https://www.figma.com/design/Xw7pn5j4QZ8Ns237keo3ev/MacThing?node-id=327-1567).

These assets show the release after PRs [#37](https://github.com/srcurran/MacThing/pull/37),
[#40](https://github.com/srcurran/MacThing/pull/40), [#41](https://github.com/srcurran/MacThing/pull/41),
[#42](https://github.com/srcurran/MacThing/pull/42), and [#43](https://github.com/srcurran/MacThing/pull/43)
are merged. The release PR must follow those changes.

The screens were rendered from a combined preview build at **800×480**, using the bundled UI
fonts and fixture data. The exact PR commits, compiled UI hash, and image checksums are in
[assets.json](assets.json). Physical-device captures and the device test are deferred at the
user's request; generating these previews did not change the Car Thing build. These images are release
previews, not verified device captures.

## Figma video setup

The page duplicates the 0.2.3 production setup and refreshes its screen layers. Device shapes,
screen placement, existing transitions, and the original page are preserved.

- [Full cut](https://www.figma.com/design/Xw7pn5j4QZ8Ns237keo3ev/MacThing?node-id=327-1643):
  27.8 seconds, including Claude usage, ChatGPT usage, the meeting alert, and the meeting timer.
- [Short cut](https://www.figma.com/design/Xw7pn5j4QZ8Ns237keo3ev/MacThing?node-id=327-1691):
  14 seconds, with the same new scenes. A diagnostic export was checked at each new scene and
  the return to Now Playing.
- [New screen assets](https://www.figma.com/design/Xw7pn5j4QZ8Ns237keo3ev/MacThing?node-id=328-1567):
  Claude, ChatGPT, meeting timer, and the empty Now Playing state.
- [New album assets](https://www.figma.com/design/Xw7pn5j4QZ8Ns237keo3ev/MacThing?node-id=329-1567):
  source covers, Mac-generated blurred backgrounds, and Now Playing treatments.
- [README overview](https://www.figma.com/design/Xw7pn5j4QZ8Ns237keo3ev/MacThing?node-id=333-1567):
  the six-device montage exported as `device-overview.png`.

## New album treatments

| Album | Screen | Source cover |
| --- | --- | --- |
| Björk — *Post* | Claude usage; Now Playing | [Wikipedia](https://en.wikipedia.org/wiki/Post_(Bj%C3%B6rk_album)) · [cover](artwork/post.png) |
| Do Make Say Think — *Goodbye Enemy Airship the Landlord Is Dead* | ChatGPT usage; Now Playing | [Wikipedia](https://en.wikipedia.org/wiki/Goodbye_Enemy_Airship_the_Landlord_Is_Dead) · [cover](artwork/goodbye-enemy-airship.jpg) |
| The Books — *Lost and Safe* | Meeting timer; Now Playing | [Wikipedia](https://en.wikipedia.org/wiki/Lost_and_Safe) · [cover](artwork/lost-and-safe.jpg) |

The backgrounds use `native/bin/artwork` through the bridge's `ArtworkCache`, including its
contrast tint calculation. Existing scenes retain the earlier production page's album palettes.

## Files and fixture data

The 22 screen PNGs cover Now Playing, Calendar and month view, all three Weather views, Clock,
the timer before and after starting, Settings, the meeting alert, the meeting timer, both usage
providers, the empty Now Playing state, four consecutive countdown seconds, and three new
Now Playing covers. The two `device-*.png` files are exported Figma mockups.

Fixtures use 15 October 2026 at 1:14 PM, Portland weather, and example calendar events. Claude
shows 38% session / 64% week; ChatGPT shows 28% session / 42% week. The meeting alert is three
minutes before a 2:00–2:30 PM Design sync, and the meeting timer is shown at 2:10 PM.

Before publishing, merge the dependency PRs, compare the release build on the device, and
refresh any assets affected by changes to those PRs. Device-driving scripts require permission
under [AGENTS.md](../../AGENTS.md).
