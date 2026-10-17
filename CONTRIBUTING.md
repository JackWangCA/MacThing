# Contributing to MacThing

Thanks for wanting to help. MacThing is a small project I maintain myself, so this page is about making your pull request easy for me to understand and decide on.

## One change per pull request

Keep each pull request to a single change: one setting, one fix or one feature. If you have three ideas, open three pull requests. Small, focused PRs get reviewed quickly. A PR that bundles several features usually gets closed and split.

Please don't include changes the PR doesn't need:

- version bumps
- refreshed README screenshots (`docs/`)
- reformatting or unrelated docs edits

## Explain the change in the description

The pull request description should let me understand the change without reading the code first:

- **What** it changes, from the point of view of someone using the Car Thing or the Mac settings page.
- **Why:** what problem it solves, or what you wanted to be able to do.
- **How you checked it:** what you tried, and whether that was on a real Car Thing.
- **Anything you weren't sure about** or would like my opinion on.

You don't need to open an issue before a pull request. If you're unsure whether something is a good fit, opening an issue or a draft PR to ask first is welcome, and it can save you time.

## Screenshots, please

Screenshots are the most useful thing you can add. For anything that changes what's on the screen, include a screenshot of the result. You can drag or paste images straight into the PR description on GitHub.

### From the Car Thing

With the bridge running (`npm run dev` or the LaunchAgent) and the Car Thing connected:

1. Put the screen you changed on the Car Thing.
2. Save what it's showing:

   ```bash
   npm run screenshot screen.png
   ```

   This saves the 800×480 screen exactly as the device draws it, and works alongside the running bridge.

For a change that's about motion (an animation, a transition, something that happens when you press a button), a short video is better than a screenshot. A phone video of the Car Thing is fine.

### From the Mac settings page

For changes to the settings page (http://127.0.0.1:4747), a normal macOS screenshot works: press **⌘⇧4**, then **Space**, and click the browser window.

### Without a Car Thing

The device UI only shows real screens when the bridge is driving a Car Thing. Opened by itself in a browser, it just says "Waiting for your Mac". If you don't have a device, say so in the PR, add any screenshots you can (the Mac settings page, for example), and I'll check the change on mine.

## What happens after you open a pull request

Pull requests from outside contributors are labelled **needs-triage** automatically. I'll read it and reply with one of:

- **Merged as is.**
- **Changes requested:** I'll say what I'd like different. You can update the PR, or, if you've left "Allow edits by maintainers" on, I may make the changes myself.
- **Taken in part or adapted:** I may take part of a pull request, change how it works, or implement the idea differently on `main`. When I do, you'll be credited as a co-author on the commit, and I'll link it from your PR.
- **Closed:** sometimes a change doesn't fit where I want MacThing to go. I'll say why.

## Code style

Match the code around your change: its naming, its comment style and how much it comments. `AGENTS.md` has notes that apply to anyone working on the device UI, including AI coding agents.

Before opening the PR, check that it builds and the tests pass:

```bash
npm run build:ui
node --test tests/*.test.js
```

By contributing, you agree that your contribution is licensed under the project's [MIT License](LICENSE).
