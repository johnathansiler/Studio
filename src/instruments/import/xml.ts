export interface XmlEl {
  name: string
  attrs: Record<string, string>
  children: XmlEl[]
  text: string
}

function decode(value: string) {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

/** A small element parser for DecentSampler files. It ignores comments and the XML declaration. */
export function parseXml(source: string): XmlEl {
  const root: XmlEl = { name: 'root', attrs: {}, children: [], text: '' }
  const stack = [root]
  let i = 0
  const text: string[] = []
  const flush = () => {
    if (!text.length) return
    stack[stack.length - 1].text += text.join('')
    text.length = 0
  }
  while (i < source.length) {
    if (source.startsWith('<!--', i)) {
      const end = source.indexOf('-->', i + 4)
      i = end < 0 ? source.length : end + 3
      continue
    }
    if (source[i] !== '<') {
      text.push(source[i])
      i += 1
      continue
    }
    if (source.startsWith('<?', i) || source.startsWith('<!', i)) {
      const end = source.indexOf('>', i + 2)
      i = end < 0 ? source.length : end + 1
      continue
    }
    flush()
    const close = source.startsWith('</', i)
    const end = source.indexOf('>', i + 1)
    if (end < 0) break
    const body = source.slice(i + (close ? 2 : 1), end).trim()
    i = end + 1
    if (close) {
      const name = body.split(/\s/)[0].toLowerCase()
      for (let depth = stack.length - 1; depth > 0; depth--) {
        const popped = stack.pop()
        if (popped?.name === name) break
      }
      continue
    }
    const self = body.endsWith('/')
    const head = self ? body.slice(0, -1).trim() : body
    const space = head.search(/\s/)
    const name = (space < 0 ? head : head.slice(0, space)).toLowerCase()
    const attrs: Record<string, string> = {}
    const attr = /([A-Za-z_][\w:.-]*)\s*=\s*("([^"]*)"|'([^']*)')/g
    const raw = space < 0 ? '' : head.slice(space)
    for (const match of raw.matchAll(attr)) attrs[match[1]] = decode(match[3] ?? match[4] ?? '')
    const el: XmlEl = { name, attrs, children: [], text: '' }
    stack[stack.length - 1].children.push(el)
    if (!self) stack.push(el)
  }
  flush()
  return root
}

export function firstChild(el: XmlEl, name: string) {
  return el.children.find((child) => child.name === name) ?? null
}

export function descendants(el: XmlEl, name: string): XmlEl[] {
  const out: XmlEl[] = []
  const walk = (node: XmlEl) => {
    for (const child of node.children) {
      if (child.name === name) out.push(child)
      walk(child)
    }
  }
  walk(el)
  return out
}
