/**
 * Whether the Car Thing's screen should be lit. Pulled out of main.js as a plain function of its
 * inputs because the order of these rules is the whole of the behaviour, and it is not obvious:
 * a locked Mac and a sleeping Mac look alike from the outside and want opposite answers.
 *
 * @param {object} s
 * @param {boolean} s.manualSleep    the sleep button was held; any input clears it
 * @param {boolean} s.sleepWithMac   Settings → Sleep with Mac
 * @param {'off'|'clock'|'playing'} s.lockScreen  Settings → When Mac is locked
 * @param {boolean} s.systemAsleep   the Mac itself is asleep
 * @param {boolean} s.locked         the Mac's lock screen is up
 * @param {boolean} s.displayAsleep  the Mac's display is off
 * @param {number} s.sinceInput      ms since the last button or knob press on the device
 * @param {number} s.wakeMs          how long an input keeps it awake (config.screenWakeMs)
 */
export function screenShouldBeOn(s) {
  // Held the sleep button: off until something is pressed, whatever everything else says.
  if (s.manualSleep) return false;
  // Sleep with Mac off means exactly that — the device is a clock on the desk and stays lit.
  if (!s.sleepWithMac) return true;
  // A sleeping Mac takes the device with it. This sits above the lock test on purpose: locking
  // and then sleeping is the ordinary way a Mac is left, so by the time it sleeps it is also
  // locked, and testing lock first would leave the screen lit all night.
  if (s.systemAsleep) return false;
  // A lock is not a sleep. Its own setting decides, and 'off' is what the device did before
  // there was a setting: dark, on the grounds that what is on screen is the locked Mac's business.
  if (s.locked) return s.lockScreen !== 'off';
  if (!s.displayAsleep) return true;
  // Display asleep but the Mac awake and unlocked: a press lights the screen for a while.
  return s.sinceInput < s.wakeMs;
}
