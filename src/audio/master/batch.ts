/** Shared-chain album export and the distribution bounce. */

import { fileSlug, runBounce, type BounceFile, type BounceJob } from '../bounce'
import { zipFiles } from '../../model/zip'
import { uid, type AudioAsset, type PluginInstance, type Project } from '../../model/types'
import type { DitherMode } from '../../model/wav'
import { MASTERING_IDS, type LoudnessTarget } from './assistant'

export function ditherShape(project: Project): DitherMode {
  const plugin = project.masterPlugins.find((item) => item.pluginId === 'dither' && item.enabled)
  const shape = plugin?.params.shape ?? 1
  if (shape >= 1.5) return 'shaped'
  if (shape >= 0.5) return 'tpdf'
  return 'none'
}

export function withSharedChain(project: Project, chain: PluginInstance[]): Project {
  const copy = JSON.parse(JSON.stringify(project)) as Project
  const meter = copy.masterPlugins.find((plugin) => plugin.pluginId === 'meter')
  copy.masterPlugins = [
    ...chain.filter((plugin) => plugin.pluginId !== 'meter').map((plugin) => ({ ...plugin, id: uid('fx'), params: { ...plugin.params } })),
    ...(meter ? [meter] : []),
  ]
  return copy
}

export function distributionJob(project: Project, assets: AudioAsset[], kind: 'wav' | 'mp3', target: LoudnessTarget, isrc: string): BounceJob {
  return {
    kind,
    project,
    assets,
    scope: 'song',
    startSample: 0,
    endSample: 0,
    tail: 'auto',
    sampleRate: kind === 'mp3' ? 48000 : project.sampleRate,
    bits: 24,
    dither: ditherShape(project),
    normalize: 'lufs',
    normalizeTarget: target.lufs,
    limiter: false,
    truePeakCeiling: target.truePeak,
    stemIds: null,
    trackId: null,
    mp3Mode: 'vbr',
    mp3Bitrate: 192,
    mp3Quality: 2,
    title: project.name,
    artist: '',
    artwork: null,
    projectAudio: 'wav',
    isrc,
    report: true,
  }
}

export async function masterDistribution(project: Project, assets: AudioAsset[], target: LoudnessTarget, isrc: string) {
  const wav = await runBounce(distributionJob(project, assets, 'wav', target, isrc))
  const mp3 = await runBounce(distributionJob(project, assets, 'mp3', target, isrc))
  return [...wav, ...mp3]
}

/** Master each song with one chain and one loudness target, then zip the WAV and MP3 files. */
export async function masterAlbum(entries: { project: Project; assets: AudioAsset[] }[], chain: PluginInstance[], target: LoudnessTarget, isrc: string): Promise<BounceFile> {
  const files: { name: string; data: Uint8Array }[] = []
  const songs = entries.slice(0, 8)
  for (const entry of songs) {
    const project = withSharedChain(entry.project, chain.length ? chain : entry.project.masterPlugins)
    const rendered = await masterDistribution(project, entry.assets, target, isrc)
    for (const file of rendered) files.push({ name: `${fileSlug(project.name)}/${file.name}`, data: file.bytes })
  }
  return { name: 'album-masters.zip', mime: 'application/zip', bytes: await zipFiles(files) }
}

export function sharedChain(project: Project) {
  return project.masterPlugins.filter((plugin) => plugin.pluginId !== 'meter' && (MASTERING_IDS as readonly string[]).includes(plugin.pluginId))
}
