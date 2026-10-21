# 1.0.0 release artwork

[Open the 1.0.0 Figma page](https://www.figma.com/design/Xw7pn5j4QZ8Ns237keo3ev/MacThing?node-id=327-1567).

Every screen here is captured from the Car Thing itself, at **800×480**, by
`npm run mock-screens` (`scripts/mock-screens.js`). It feeds the device fixture data — Thursday
15 October 2026 at 1:14 PM, Portland weather, example calendar events — and holds the page's clock
still, so countdowns read the same on every run. The screens are the same images as the Figma
page's, so after a UI change, re-run it and replace the images in Figma
([below](#updating-the-figma-page)).

## Figma

- [Full cut](https://www.figma.com/design/Xw7pn5j4QZ8Ns237keo3ev/MacThing?node-id=327-1643): 27.8 seconds.
  Now Playing, the meeting alert, Calendar and its month, the three Weather views, the Clock, the
  timer set and running, Settings, Claude usage, ChatGPT usage, the alert again and the meeting timer.
- [Short cut](https://www.figma.com/design/Xw7pn5j4QZ8Ns237keo3ev/MacThing?node-id=327-1691): 14 seconds, the same without the
  calendar month, the timer before it starts and Settings.
- [New screens cut](https://www.figma.com/design/Xw7pn5j4QZ8Ns237keo3ev/MacThing?node-id=398-1539): 15 seconds of only
  what's new in 1.0: nothing playing (the perpetual calendar), the digital clock, Claude usage with the
  meeting alert rising over it, the meeting timer, and Ovlov playing, where it ends. The alert is the
  card cut from `meeting-alert.png`, over a dimmed screen.
- [New screens](https://www.figma.com/design/Xw7pn5j4QZ8Ns237keo3ev/MacThing?node-id=328-1567): Claude, ChatGPT, the meeting timer
  and nothing playing.
- [New albums](https://www.figma.com/design/Xw7pn5j4QZ8Ns237keo3ev/MacThing?node-id=329-1567): covers, blurred backgrounds and
  Now Playing for the three albums new in 1.0.0.
- [README overview](https://www.figma.com/design/Xw7pn5j4QZ8Ns237keo3ev/MacThing?node-id=333-1567), exported as
  `device-overview.png`, and [README Now Playing](https://www.figma.com/design/Xw7pn5j4QZ8Ns237keo3ev/MacThing?node-id=327-1568),
  exported as `device-nowplaying.png`.

Each cut exports as MP4 from Figma (1920×1080, 30 fps). For GitHub they're re-encoded with
`ffmpeg -c:v libx264 -crf 22 -preset slow -pix_fmt yuv420p -movflags +faststart -an` (the full cut
comes to about 3.5 MB, the new-screens cut about 0.9 MB) and uploaded to GitHub.

## Scenes and albums

Each scene in the video sits over a blurred album: its 1920×1080 backdrop in Figma, and the same
image behind the screen on the device (the album art background). `mock-screens` sends the device
that image from `artwork/backgrounds/`, so the screen and its backdrop match.

| Screen | Album behind it | Background |
| --- | --- | --- |
| `nowplaying`, `meeting-alert` | Cate Le Bon — *Pompeii* (cover: `artwork/pompeii.jpg`) | `catelebon.jpg` |
| `calendar` | Figma layer `blur-getupkids` | `getupkids.jpg` |
| `calendar-month` | Figma layer `blur-tomrogerson` | `tomrogerson.jpg` |
| `weather` | Figma layer `blur-horselords` | `horselords.jpg` |
| `weather-today` | Figma layer `blur-sanddollar` | `sanddollar.jpg` |
| `weather-week` | Figma layer `blur-ribbons` | `ribbons.jpg` |
| `clock`, `clock-digital` | Figma layer `blur-artblakey` | `artblakey.jpg` |
| `timer` | Figma layer `blur-basic` | `basic.jpg` |
| `timer-running`, `timer-countdown-32-*` | Figma layer `blur-hug` | `hug.jpg` |
| `settings` | Figma layer `blur-deafheaven` | `deafheaven.jpg` |
| `claude`, `nowplaying-post` | Björk — *Post* ([Wikipedia](https://en.wikipedia.org/wiki/Post_(Bj%C3%B6rk_album))) | `post.jpg` |
| `chatgpt`, `nowplaying-goodbye` | Do Make Say Think — *Goodbye Enemy Airship the Landlord Is Dead* ([Wikipedia](https://en.wikipedia.org/wiki/Goodbye_Enemy_Airship_the_Landlord_Is_Dead)) | `goodbye.jpg` |
| `meeting-timer`, `nowplaying-ovlov` | Ovlov — *Am* ([Bandcamp](https://ovlov.bandcamp.com/album/am-2)) | `ovlov.jpg` |
| `nowplaying-empty` | the day's perpetual-calendar cover, drawn as the bridge draws it | `perpetual.jpg` |

The older backgrounds are exported from those layers (they came from the 0.2.3 Figma page). `post.jpg`, `goodbye.jpg` and `ovlov.jpg`
are made from the covers by `native/bin/artwork`, as the bridge makes them.

## Fixture data

- Calendar: Dinner with Sam & Alex at 5:30 PM and Book club at 7:30 PM, Design review tomorrow at 1 PM.
- Claude: session 38% used, resetting in 2.5 hours; week 64%. ChatGPT: session 28%, resetting in 4 hours; week 42%.
- Timer: 45 minutes, captured 12:38–12:41 after it starts (`timer-countdown-32-22` to `-19`; `timer-running` is 32:19).
- Meeting alert: three minutes before a 2:00–2:30 PM Design sync on Zoom. Meeting timer: started at 2:10, showing 19:59.

## Updating the Figma page

1. With the device connected (it takes the device over for about a minute), run `npm run mock-screens`.
2. Upload each screen to its layer in Figma and replace every other layer that uses the same image:
   each screen appears in the section, the original cut, both new cuts and the README frames.
   `assets.json` lists which Figma layer holds each screen.
3. Export the README frames and both cuts again.

`assets.json` records each file's SHA-256.
