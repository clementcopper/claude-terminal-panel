import AppKit
let a = CommandLine.arguments
guard a.count >= 7 else { fputs("usage: render <name> <weight> <pt> <canvasPx> <#rrggbb|alpha> <out.png>\n", stderr); exit(2) }
let wm: [String: NSFont.Weight] = ["ultraLight": .ultraLight,"thin": .thin,"light": .light,
  "regular": .regular,"medium": .medium,"semibold": .semibold,"bold": .bold,"heavy": .heavy,"black": .black]
guard let w = wm[a[2]] else { fputs("unknown weight\n", stderr); exit(2) }
let pt = CGFloat(Double(a[3]) ?? 36)
let canvas = Int(a[4]) ?? 48
func parse(_ s: String) -> NSColor {
  if s == "alpha" { return .black }
  var h = s; if h.hasPrefix("#") { h.removeFirst() }
  var v: UInt64 = 0; Scanner(string: h).scanHexInt64(&v)
  return NSColor(srgbRed: CGFloat((v >> 16) & 0xff)/255, green: CGFloat((v >> 8) & 0xff)/255,
                 blue: CGFloat(v & 0xff)/255, alpha: 1)
}
guard let base = NSImage(systemSymbolName: a[1], accessibilityDescription: nil) else {
  fputs("SYMBOL NOT FOUND: \(a[1])\n", stderr); exit(1) }
guard let sym = base.withSymbolConfiguration(NSImage.SymbolConfiguration(pointSize: pt, weight: w)) else { exit(1) }
sym.isTemplate = true
let s = sym.size
guard let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: canvas, pixelsHigh: canvas,
  bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
  colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0) else { exit(1) }
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
// zentriert auf gemeinsamer Flaeche: alle Icons skalieren danach identisch
let dest = NSRect(x: (CGFloat(canvas) - s.width)/2, y: (CGFloat(canvas) - s.height)/2,
                  width: s.width, height: s.height)
sym.draw(in: dest)
parse(a[5]).set()
NSRect(x: 0, y: 0, width: CGFloat(canvas), height: CGFloat(canvas)).fill(using: .sourceAtop)
NSGraphicsContext.restoreGraphicsState()
try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: a[6]))
print("\(a[1].padding(toLength: 24, withPad: " ", startingAt: 0))  \(Int(s.width))x\(Int(s.height)) auf \(canvas)x\(canvas)  \(a[5])")
