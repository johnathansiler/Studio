/** Triangular PDF dither, one LSB peak-to-peak at 16-bit. Final integer export only. */

export function tpdf() {
  return (Math.random() - Math.random()) / 32768
}
