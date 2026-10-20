export function ms(value: number | null | undefined, digits = 0) {
  if (value == null || Number.isNaN(value)) return '—'
  return `${value.toFixed(digits)} ms`
}

export function downloadBlob(filename: string, data: Blob) {
  const url = URL.createObjectURL(data)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
  URL.revokeObjectURL(url)
}
