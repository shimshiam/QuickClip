import os
from PIL import Image, ImageDraw

def create_icon(size, is_tray=False):
    # Create RGBA image with transparent background
    img = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    
    # Calculate dimensions
    pad = int(size * 0.08) if not is_tray else int(size * 0.12)
    box = [pad, pad, size - pad, size - pad]
    radius = int((size - 2 * pad) * 0.28)
    
    if is_tray:
        # Tray icon: Crisp white/blue rounded rect with transparent outer background
        # Or a vibrant gradient square with transparent corners
        for y in range(box[1], box[3]):
            t = (y - box[1]) / max(1, (box[3] - box[1]))
            # Subtle gradient from #4F46E5 (Indigo) to #06B6D4 (Cyan)
            r = int(79 * (1 - t) + 6 * t)
            g = int(70 * (1 - t) + 182 * t)
            b = int(229 * (1 - t) + 212 * t)
            draw.rounded_rectangle(box, radius=radius, fill=(r, g, b, 255))
        
        # Inner white icon (Clipboard/clip mark)
        inner_pad = int(size * 0.26)
        ix0, iy0, ix1, iy1 = inner_pad, inner_pad, size - inner_pad, size - inner_pad
        draw.rounded_rectangle([ix0, iy0, ix1, iy1], radius=int(radius*0.6), outline=(255, 255, 255, 255), width=max(2, int(size*0.06)))
        # Horizontal clip line
        mid_y = (iy0 + iy1) // 2
        draw.line([(ix0 + int(size*0.08), mid_y), (ix1 - int(size*0.08), mid_y)], fill=(255, 255, 255, 255), width=max(2, int(size*0.06)))
    else:
        # Full app icon (256x256 or 512x512): Rich gradient rounded rectangle with transparent outer background
        for y in range(box[1], box[3]):
            t = (y - box[1]) / max(1, (box[3] - box[1]))
            r = int(79 * (1 - t) + 6 * t)
            g = int(70 * (1 - t) + 182 * t)
            b = int(229 * (1 - t) + 212 * t)
            draw.rounded_rectangle(box, radius=radius, fill=(r, g, b, 255))
        
        # Inner glass outline and clipboard graphic
        draw.rounded_rectangle(box, radius=radius, outline=(255, 255, 255, 100), width=max(1, int(size*0.015)))
        
        # Inner clipboard mark
        inner_pad = int(size * 0.25)
        ix0, iy0, ix1, iy1 = inner_pad, inner_pad, size - inner_pad, size - inner_pad
        draw.rounded_rectangle([ix0, iy0, ix1, iy1], radius=int(radius*0.6), outline=(255, 255, 255, 240), width=max(3, int(size*0.05)))
        mid_y = (iy0 + iy1) // 2
        draw.line([(ix0 + int(size*0.08), mid_y), (ix1 - int(size*0.08), mid_y)], fill=(255, 255, 255, 240), width=max(3, int(size*0.05)))
        draw.line([(size//2, iy0 + int(size*0.08)), (size//2, iy1 - int(size*0.08))], fill=(255, 255, 255, 240), width=max(3, int(size*0.05)))
        
    return img

os.makedirs('assets', exist_ok=True)
os.makedirs('src/pwa/icons', exist_ok=True)

# Generate tray icon (64x64 RGBA PNG)
tray_png = create_icon(64, is_tray=True)
tray_png.save('assets/tray-icon.png', 'PNG')
print('Generated assets/tray-icon.png (64x64 RGBA transparent)')

# Generate main app icon (256x256 RGBA PNG)
app_png = create_icon(256, is_tray=False)
app_png.save('assets/icon.png', 'PNG')
print('Generated assets/icon.png (256x256 RGBA transparent)')

# Generate PWA icons
pwa_192 = create_icon(192, is_tray=False)
pwa_192.save('src/pwa/icons/icon-192.png', 'PNG')
print('Generated src/pwa/icons/icon-192.png (192x192 RGBA transparent)')

pwa_512 = create_icon(512, is_tray=False)
pwa_512.save('src/pwa/icons/icon-512.png', 'PNG')
print('Generated src/pwa/icons/icon-512.png (512x512 RGBA transparent)')
