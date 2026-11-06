// SmartThings uses percentages for HSV; Matter also accepts CIE xy coordinates
// with a scale of 65536. Use the sRGB D65 primaries in both directions.
export const XY_SCALE = 65536;

export function xyToSmartThings(x: number, y: number): { hue: number; saturation: number } {
  x /= XY_SCALE;
  y /= XY_SCALE;
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y <= 0 || x + y > 1) {
    throw new Error('Invalid Matter xy color');
  }
  const X = x / y;
  const Z = (1 - x - y) / y;
  const linear = [3.2406 * X - 1.5372 - 0.4986 * Z, -0.9689 * X + 1.8758 + 0.0415 * Z, 0.0557 * X - 0.2040 + 1.0570 * Z];
  const scale = Math.max(...linear);
  const [r, g, b] = linear.map(value => {
    const v = Math.max(0, value / scale);
    return v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;
  });
  const min = Math.min(r, g, b);
  const max = Math.max(r, g, b);
  const delta = max - min;
  if (delta < 0.0001) {
    return { hue: 0, saturation: 0 };
  }
  const sector = r === max ? (g - b) / delta : g === max ? 2 + (b - r) / delta : 4 + (r - g) / delta;
  return { hue: Math.round(((sector + 6) % 6) * 100 / 6), saturation: Math.round(100 * delta / max) };
}

export function smartThingsToXy(hue: number, saturation: number): { currentX: number; currentY: number } {
  const h = (hue % 100) * 6 / 100;
  const s = saturation / 100;
  const linear = (offset: number) => {
    const k = (offset + h) % 6;
    const v = 1 - s * Math.max(0, Math.min(k, 4 - k, 1));
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const [r, g, b] = [5, 3, 1].map(linear);
  const X = 0.4124 * r + 0.3576 * g + 0.1805 * b;
  const Y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const Z = 0.0193 * r + 0.1192 * g + 0.9505 * b;
  const sum = X + Y + Z;
  return { currentX: Math.round(X / sum * XY_SCALE), currentY: Math.round(Y / sum * XY_SCALE) };
}
