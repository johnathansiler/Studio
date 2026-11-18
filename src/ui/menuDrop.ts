/** Upward travel that closes the top menu. dy is positive when the finger moves up. */
export function menuSwipeCloses(dx: number, dy: number): boolean {
  return dy >= 28 && dy > Math.abs(dx)
}
