// Shared radial grid for the 480px Clock stage. Figma guide diameters: 408 / 360 / 290.
// Marks live in the outer band; the primary dial ends at 180px and inner content at 145px.
export const DIAL = Object.freeze({
  size: 480,
  center: 240,
  outerRadius: 204,
  marksRadius: 192,
  primaryRadius: 180,
  innerRadius: 145,
  trackWidth: 28,
  dotRadius: 5,
  innerPaceGap: 13,
});

/** A point clockwise from 12 o'clock, in turns (0…1). */
export function dialPoint(radius, turns) {
  const angle = turns * 2 * Math.PI;
  return { x: DIAL.center + radius * Math.sin(angle), y: DIAL.center - radius * Math.cos(angle) };
}
