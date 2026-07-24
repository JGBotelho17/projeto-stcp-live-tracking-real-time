export function clamp(value: number, min = 0, max = 1) {
  return Math.min(max, Math.max(min, value));
}

export function lerp(from: number, to: number, amount: number) {
  return from + (to - from) * amount;
}

export function lerpAngle(from: number, to: number, amount: number) {
  const delta = ((((to - from) % 360) + 540) % 360) - 180;
  return (from + delta * amount + 360) % 360;
}
