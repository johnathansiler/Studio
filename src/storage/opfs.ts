export async function mirrorBlob(hash: string, bytes: Uint8Array) {
  try {
    const blobs = await directory('blobs')
    if (!blobs) return
    const handle = await blobs.getFileHandle(`${hash}.wav`, { create: true })
    const writable = await handle.createWritable()
    await writable.write(new Blob([new Uint8Array(bytes)]))
    await writable.close()
  } catch {
    /* OPFS is a second copy. IndexedDB remains the source of truth. */
  }
}

export async function mirrorProject(id: string, doc: unknown) {
  try {
    const projects = await directory('projects')
    if (!projects) return
    const handle = await projects.getFileHandle(`${id}.json`, { create: true })
    const writable = await handle.createWritable()
    await writable.write(JSON.stringify(doc))
    await writable.close()
  } catch {
    /* ignore */
  }
}

export async function removeMirror(id: string) {
  try {
    const projects = await directory('projects')
    await projects?.removeEntry(`${id}.json`)
  } catch {
    /* ignore */
  }
}

async function directory(name: string) {
  const storage = navigator.storage as StorageManager & { getDirectory?: () => Promise<FileSystemDirectoryHandle> }
  const root = await storage.getDirectory?.()
  if (!root) return null
  const cue = await root.getDirectoryHandle('cueharbor', { create: true })
  return cue.getDirectoryHandle(name, { create: true })
}
