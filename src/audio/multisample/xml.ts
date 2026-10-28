export interface XmlNode {
  name: string
  attrs: Record<string, string>
  children: XmlNode[]
  text: string
}

/** A small element parser for DecentSampler presets. Not a general XML stack. */
export function parseXml(source: string): XmlNode {
  let i = 0
  const text = source.charCodeAt(0) === 0xfeff ? source.slice(1) : source

  function skip() {
    while (i < text.length) {
      if (text.startsWith('<!--', i)) {
        const end = text.indexOf('-->', i + 4)
        i = end < 0 ? text.length : end + 3
        continue
      }
      if (text.startsWith('<?', i)) {
        const end = text.indexOf('?>', i + 2)
        i = end < 0 ? text.length : end + 2
        continue
      }
      const ch = text[i]
      if (ch === ' ' || ch === '\n' || ch === '\r' || ch === '\t') {
        i += 1
        continue
      }
      break
    }
  }

  function parseNode(): XmlNode | null {
    skip()
    if (text[i] !== '<' || text[i + 1] === '/') return null
    i += 1
    let name = ''
    while (i < text.length && /[A-Za-z0-9_:-]/.test(text[i])) name += text[i++]
    const attrs: Record<string, string> = {}
    while (i < text.length) {
      while (text[i] === ' ' || text[i] === '\n' || text[i] === '\r' || text[i] === '\t') i += 1
      if (text[i] === '/' || text[i] === '>' || text[i] == null) break
      let key = ''
      while (i < text.length && /[A-Za-z0-9_:-]/.test(text[i])) key += text[i++]
      while (text[i] === ' ' || text[i] === '\t') i += 1
      if (text[i] !== '=') continue
      i += 1
      while (text[i] === ' ') i += 1
      const quote = text[i]
      if (quote !== '"' && quote !== "'") continue
      i += 1
      let value = ''
      while (i < text.length && text[i] !== quote) value += text[i++]
      i += 1
      attrs[key] = decodeEntities(value)
    }
    const self = text[i] === '/'
    while (i < text.length && text[i] !== '>') i += 1
    i += 1
    const children: XmlNode[] = []
    let body = ''
    if (!self) {
      while (i < text.length) {
        if (text.startsWith('</', i)) {
          i += 2
          while (i < text.length && text[i] !== '>') i += 1
          i += 1
          break
        }
        if (text[i] === '<') {
          const child = parseNode()
          if (child) children.push(child)
          else break
        } else {
          while (i < text.length && text[i] !== '<') body += text[i++]
        }
      }
    }
    return { name, attrs, children, text: decodeEntities(body.trim()) }
  }

  const root = parseNode()
  if (!root) throw new Error('Empty instrument file')
  return root
}

export function attr(node: XmlNode, ...names: string[]) {
  for (const name of names) {
    for (const [key, value] of Object.entries(node.attrs)) {
      if (key.toLowerCase() === name.toLowerCase() && value !== '') return value
    }
  }
  return undefined
}

export function childrenNamed(node: XmlNode, name: string) {
  return node.children.filter((child) => child.name.toLowerCase() === name.toLowerCase())
}

function decodeEntities(value: string) {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}
