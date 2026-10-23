// Renders the MacThing boot wordmark: white on black, 800x480 as seen on the Car Thing.
// Writes preview.png (landscape, as seen) and portrait.rgba (480x800, the panel's own orientation:
// rotated 90° clockwise, the way the stock boot logo is stored).
//
// The same picture is shown twice per boot. U-boot shows the logo partition's copy (pack.js) until
// Weston takes the screen, and Weston then shows ui/images/appstart.png — preview.png, committed —
// as its background until Chromium paints, so there's no black gap between them. Weston rotates
// its output itself, which is why that one stays landscape. After changing this file, run
// `scripts/device-image.sh logo` and copy preview.png over ui/images/appstart.png.
import AppKit

let W = 800, H = 480
// Inter, from the UI's own font files, so the boot picture matches the screens that follow it:
// the lightest weight the UI ships for "Mac", the boldest for "Thing".
let fonts = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("../../ui/fonts").standardized
func font(_ weight: Int, _ size: CGFloat) -> NSFont {
  let url = fonts.appendingPathComponent("inter-latin-\(weight)-normal.woff2")
  guard let descs = CTFontManagerCreateFontDescriptorsFromURL(url as CFURL) as? [CTFontDescriptor], let d = descs.first
  else { fatalError("can't load \(url.path)") }
  return CTFontCreateWithFontDescriptor(d, size, nil) as NSFont
}
let size: CGFloat = 72
let light = font(300, size), bold = font(700, size)
let text = NSMutableAttributedString(string: "Mac", attributes: [.font: light, .foregroundColor: NSColor.white, .kern: -1.0])
text.append(NSAttributedString(string: "Thing", attributes: [.font: bold, .foregroundColor: NSColor.white, .kern: -1.0]))

func draw(_ ctx: CGContext) {
  ctx.setFillColor(.black); ctx.fill(CGRect(x: 0, y: 0, width: W, height: H))
  NSGraphicsContext.current = NSGraphicsContext(cgContext: ctx, flipped: false)
  let line = CTLineCreateWithAttributedString(text)
  var ascent: CGFloat = 0, descent: CGFloat = 0
  let width = CTLineGetTypographicBounds(line, &ascent, &descent, nil)
  // Centre on the cap height, so the word sits optically in the middle rather than its descender box.
  let cap = bold.capHeight
  ctx.textPosition = CGPoint(x: (CGFloat(W) - CGFloat(width)) / 2, y: (CGFloat(H) - cap) / 2)
  CTLineDraw(line, ctx)
}

let space = CGColorSpaceCreateDeviceRGB()
let info = CGImageAlphaInfo.premultipliedLast.rawValue
let land = CGContext(data: nil, width: W, height: H, bitsPerComponent: 8, bytesPerRow: W * 4, space: space, bitmapInfo: info)!
draw(land)
let landImage = land.makeImage()!
let rep = NSBitmapImageRep(cgImage: landImage)
try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: "preview.png"))

// Portrait: rotate the landscape picture 90° clockwise into a 480x800 buffer (rows top to bottom).
let port = CGContext(data: nil, width: H, height: W, bitsPerComponent: 8, bytesPerRow: H * 4, space: space, bitmapInfo: info)!
port.translateBy(x: 0, y: CGFloat(W))
port.rotate(by: -.pi / 2)
port.draw(landImage, in: CGRect(x: 0, y: 0, width: W, height: H))
let bytes = UnsafeBufferPointer(start: port.data!.assumingMemoryBound(to: UInt8.self), count: H * W * 4)
FileManager.default.createFile(atPath: "portrait.rgba", contents: Data(bytes))
