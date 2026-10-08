# Builds the app icons from the iOS AppIcon-1024 artwork (the site's mark).
# macOS: Big Sur grid, 824 px rounded tile on a 1024 canvas with a soft shadow.
# Windows: a tighter tile (952 px) in a multi-size .ico, so it reads at 16-32 px.
# Run: python3 scripts/icons.py <path to AppIcon-1024.png>
import sys
from PIL import Image, ImageDraw, ImageFilter

src = Image.open(sys.argv[1]).convert('RGBA').resize((1024, 1024), Image.LANCZOS)

def tile(size, radius_ratio, canvas=1024, shadow=False):
    art = src.resize((size, size), Image.LANCZOS)
    mask = Image.new('L', (size * 4, size * 4), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, size * 4 - 1, size * 4 - 1), radius=int(size * 4 * radius_ratio), fill=255)
    mask = mask.resize((size, size), Image.LANCZOS)
    out = Image.new('RGBA', (canvas, canvas), (0, 0, 0, 0))
    off = (canvas - size) // 2
    if shadow:
        sh = Image.new('RGBA', (canvas, canvas), (0, 0, 0, 0))
        sh.paste((0, 0, 0, 90), (off, off + 12), mask)
        out = Image.alpha_composite(out, sh.filter(ImageFilter.GaussianBlur(14)))
    layer = Image.new('RGBA', (canvas, canvas), (0, 0, 0, 0))
    layer.paste(art, (off, off), mask)
    # a hairline edge so the light tile does not vanish on light docks/desktops
    edge = Image.new('RGBA', (canvas, canvas), (0, 0, 0, 0))
    ImageDraw.Draw(edge).rounded_rectangle((off, off, off + size - 1, off + size - 1), radius=int(size * radius_ratio), outline=(0, 0, 0, 38), width=3)
    return Image.alpha_composite(Image.alpha_composite(out, layer), edge)

tile(824, 0.2237, shadow=True).save('build/icon.png')
win = tile(952, 0.18)
win.save('build/icon.ico', sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
win.resize((256, 256), Image.LANCZOS).save('build/icon-win-256.png')
print('ok')
