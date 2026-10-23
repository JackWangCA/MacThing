// Draws one emoji with the Mac's Apple Color Emoji into a square PNG (see emoji.js).
// osascript -l JavaScript emoji.jxa.js <emoji> <out.png> <pixels>
ObjC.import('Cocoa');
function run([text, out, size]) {
  const px = Number(size);
  const font = $.NSFont.fontWithNameSize('Apple Color Emoji', px * 0.92);
  if (!font || font.isNil()) throw new Error('Apple Color Emoji is missing');
  const attrs = $.NSDictionary.dictionaryWithObjectForKey(font, $.NSFontAttributeName);
  const rep = $.NSBitmapImageRep.alloc.initWithBitmapDataPlanesPixelsWidePixelsHighBitsPerSampleSamplesPerPixelHasAlphaIsPlanarColorSpaceNameBytesPerRowBitsPerPixel(
    null, px, px, 8, 4, true, false, $.NSDeviceRGBColorSpace, 0, 0);
  $.NSGraphicsContext.setCurrentContext($.NSGraphicsContext.graphicsContextWithBitmapImageRep(rep));
  // The line box is taller than the glyph (room for descenders), so centre on the glyph's square,
  // which Apple draws from a little below the baseline: lift it so its ink has even margins top
  // and bottom (about 5% each), which RailText's CSS relies on.
  const line = $(text).sizeWithAttributes(attrs);
  const lift = (px - font.pointSize) / 2 + font.descender + px * 0.107;
  $(text).drawAtPointWithAttributes($.NSMakePoint((px - line.width) / 2, lift), attrs);
  $.NSGraphicsContext.currentContext.flushGraphics;
  if (!rep.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $()).writeToFileAtomically(out, true)) throw new Error('could not write ' + out);
}
