import { PROBE_TARGETS } from '@/constants/probes'
import type { ProbeValues } from '@/types/cfsm'
import type { ProbeLiveValue } from '@/types/glassmorphism'

/*
 * 首页延迟 / 丢包柱子的本地样本缓冲区。
 *
 * 为什么需要它：`/api/servers` 的 `ping` / `loss` 窗口不是按时间桶聚合出来的，而是
 * **每格取离它最近的一个样本**（实测 20 格、6 分钟一格、跨度 2 小时）。网格锚点跟着请求
 * 时间走，所以同一段过去时间每次刷新都会被重新抽样：一次丢包只要没被某个格子抽中，这次
 * 刷新就看不到那根柱子，十几分钟后彻底消失，而 `/api/history/all` 里的记录还在。
 *
 * 这里把 WebSocket（以及回退轮询时的 REST 快照）里的真实探测值攒下来，交给
 * `domain/probe-buckets` 和后端窗口合并后再分桶。规则与 LuminaPlus 一致：
 * - 值变了立刻记一条（5 秒防抖，挡住 2 秒一帧的实时推送）；
 * - 值没变按 2 分钟心跳记一条，保证长期平稳的节点也有样本；
 * - 保留 2 小时 + 15 分钟（后端窗口跨度再加余量），存 localStorage，刷新页面接着用。
 *
 * 只保存在浏览器，不请求任何额外接口，也不改 CFSM 后端。
 */

/** 与后端窗口跨度对齐：2 小时 + 15 分钟余量。 */
const SAMPLE_TTL_MS = 2 * 60 * 60 * 1000 + 15 * 60 * 1000
const MAX_SAMPLES_PER_SERVER = 320
const MIN_CHANGED_GAP_MS = 5_000
const HEARTBEAT_GAP_MS = 120_000
const PERSIST_DEBOUNCE_MS = 15_000
const STORAGE_KEY = 'cfsm-glassmorphism:probe-live:v1'

const EMPTY: readonly ProbeLiveValue[] = []

/** 紧凑格式：`[time, ...8 条延迟, ...8 条丢包]`，顺序同 `PROBE_TARGETS`。 */
type PersistedSample = Array<number | null>

const samplesByServer = new Map<string, readonly ProbeLiveValue[]>()
let hydrated = false
let persistTimer: ReturnType<typeof setTimeout> | null = null

/**
 * 缓冲区键。必须与 `glassmorphism-adapter` 里 `GlassServer.key` 同格式，
 * 否则卡片读不到自己这台节点的样本。
 */
export function probeLiveKey(sourceBase: string, id: string): string {
  return encodeURIComponent(sourceBase) + ':' + id
}

function emptyProbeValues(): ProbeValues {
  return {
    ct: false,
    cu: false,
    cm: false,
    bd: false,
    node_1: false,
    node_2: false,
    node_3: false,
    node_4: false,
  }
}

function probeNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

function hasAnyValue(sample: ProbeLiveValue): boolean {
  return PROBE_TARGETS.some((target) => (
    probeNumber(sample.latency[target]) !== null || probeNumber(sample.loss[target]) !== null
  ))
}

function sameValues(left: ProbeLiveValue, right: ProbeLiveValue): boolean {
  return PROBE_TARGETS.every((target) => (
    left.latency[target] === right.latency[target] && left.loss[target] === right.loss[target]
  ))
}

function isFresh(sample: ProbeLiveValue, now: number): boolean {
  return sample.time > 0 && now - sample.time <= SAMPLE_TTL_MS
}

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

function toPersisted(sample: ProbeLiveValue): PersistedSample {
  return [
    sample.time,
    ...PROBE_TARGETS.map((target) => probeNumber(sample.latency[target])),
    ...PROBE_TARGETS.map((target) => probeNumber(sample.loss[target])),
  ]
}

function fromPersisted(entry: unknown): ProbeLiveValue | null {
  if (!Array.isArray(entry) || entry.length < 3) return null
  const time = Number(entry[0])
  if (!Number.isFinite(time) || time <= 0) return null
  // 线路数从长度反推：老记录少几条线路时只填前几条，其余留 false（未配置）。
  const stored = Math.min(PROBE_TARGETS.length, Math.floor((entry.length - 1) / 2))
  if (stored <= 0) return null
  const latency = emptyProbeValues()
  const loss = emptyProbeValues()
  for (let index = 0; index < stored; index += 1) {
    const target = PROBE_TARGETS[index]!
    latency[target] = probeNumber(entry[1 + index])
    loss[target] = probeNumber(entry[1 + stored + index])
  }
  return { time, latency, loss }
}

function hydrate(): void {
  if (hydrated) return
  hydrated = true
  const store = storage()
  if (store === null) return
  try {
    const raw = store.getItem(STORAGE_KEY)
    if (raw === null) return
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return
    const nodes = (parsed as { nodes?: unknown }).nodes
    if (typeof nodes !== 'object' || nodes === null) return
    const now = Date.now()
    for (const [key, entries] of Object.entries(nodes as Record<string, unknown>)) {
      if (!Array.isArray(entries)) continue
      const samples = entries
        .map(fromPersisted)
        .filter((sample): sample is ProbeLiveValue => sample !== null && isFresh(sample, now))
        .sort((left, right) => left.time - right.time)
      if (samples.length > 0) samplesByServer.set(key, samples)
    }
  } catch {
    // 缓存损坏时当作没有历史，重新累积即可。
  }
}

function persistNow(): void {
  const store = storage()
  if (store === null) return
  try {
    const now = Date.now()
    const nodes: Record<string, PersistedSample[]> = {}
    let count = 0
    for (const [key, samples] of samplesByServer) {
      if (count >= 100) break
      const fresh = samples.filter((sample) => isFresh(sample, now))
      if (fresh.length === 0) continue
      nodes[key] = fresh.map(toPersisted)
      count += 1
    }
    store.setItem(STORAGE_KEY, JSON.stringify({ v: 1, savedAt: now, nodes }))
  } catch {
    // 配额用尽或隐私模式：内存里的缓冲区照常工作，只是刷新后要重新累积。
  }
}

function schedulePersist(): void {
  if (persistTimer !== null) return
  persistTimer = setTimeout(() => {
    persistTimer = null
    persistNow()
  }, PERSIST_DEBOUNCE_MS)
}

if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => {
    if (persistTimer !== null) {
      clearTimeout(persistTimer)
      persistTimer = null
    }
    if (samplesByServer.size > 0) persistNow()
  })
}

/** 超出条数上限时按时间均匀抽稀，先保新的、再保整段跨度。 */
function thinSamples(samples: readonly ProbeLiveValue[]): ProbeLiveValue[] {
  if (samples.length <= MAX_SAMPLES_PER_SERVER) return [...samples]
  const minGap = SAMPLE_TTL_MS / MAX_SAMPLES_PER_SERVER
  const kept: ProbeLiveValue[] = []
  for (let index = samples.length - 1; index >= 0; index -= 1) {
    const sample = samples[index]!
    const last = kept[kept.length - 1]
    if (last === undefined || last.time - sample.time >= minGap) kept.push(sample)
  }
  kept.reverse()
  return kept
}

/**
 * 记一次真实探测。调用方可以每个 WS 帧都调：重复值会被心跳间隔挡住，
 * 值变化时按 5 秒防抖，因此样本密度≈探测节奏。
 */
export function recordProbeSample(
  key: string,
  time: number,
  latency: ProbeValues,
  loss: ProbeValues,
): void {
  if (key === '' || !Number.isFinite(time) || time <= 0) return
  const sample: ProbeLiveValue = { time, latency, loss }
  if (!hasAnyValue(sample)) return

  hydrate()
  const previous = samplesByServer.get(key) ?? EMPTY
  const last = previous[previous.length - 1]
  if (last !== undefined) {
    if (last.time >= time) return
    const gap = time - last.time
    const minGap = sameValues(last, sample) ? HEARTBEAT_GAP_MS : MIN_CHANGED_GAP_MS
    if (gap < minGap) return
  }

  const now = Date.now()
  const next = thinSamples([...previous.filter((item) => isFresh(item, now)), sample])
  samplesByServer.set(key, next)
  schedulePersist()
}

/** 某台节点还在保留期内的样本，按时间升序。没有样本时返回同一个空数组。 */
export function getProbeLiveSamples(key: string): readonly ProbeLiveValue[] {
  hydrate()
  const samples = samplesByServer.get(key)
  if (samples === undefined) return EMPTY
  const now = Date.now()
  const fresh = samples.filter((sample) => isFresh(sample, now))
  return fresh.length === 0 ? EMPTY : fresh
}
