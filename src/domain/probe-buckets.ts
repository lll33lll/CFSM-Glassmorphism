import { PROBE_TARGETS } from '@/constants/probes'
import type { LatencyWindowSample, ProbeTarget, ProbeValue } from '@/types/cfsm'
import type {
  GlassHistorySummary,
  GlassLatencySample,
  ProbeLiveValue,
} from '@/types/glassmorphism'

/*
 * 首页延迟 / 丢包柱子的分桶。
 *
 * 输入两路：后端 `/api/servers` 的窗口（每格一个抽样点，覆盖约 2 小时）与浏览器自己攒的
 * 真实探测样本（见 `services/cfsm/probe-live.ts`）。合并规则与 LuminaPlus 一致：
 *
 * 1. 本地样本是真实测量，**它覆盖到的时刻就不再用后端那个抽样点**（半格以内算覆盖）；
 * 2. 后端窗口只补浏览器还没打开的那段，以及本地样本之间的空洞；
 * 3. 用「样本一直延续到下一个样本」的方式铺时间（sample-and-hold），每个桶按**覆盖时长**
 *    加权平均 —— 一次 16% 的丢包哪怕只占一格里的两分钟，也会如实变成那一格的百分比，
 *    而不是被相邻的 0% 样本摊平。
 *
 * 桶数固定 20，与后端窗口的 20 个槽位一一对应；时间轴跟着数据自己走（跨度夹在
 * 30 分钟到 2 小时 15 分钟之间），这样后端把窗口从 1 小时改成 2 小时也不用改常量。
 */

export const PROBE_BUCKET_COUNT = 20

const DEFAULT_STEP_MS = 6 * 60 * 1000
const MIN_STEP_MS = 60 * 1000
const MAX_STEP_MS = 30 * 60 * 1000
const MIN_WINDOW_MS = 30 * 60 * 1000
const MAX_WINDOW_MS = 2 * 60 * 60 * 1000 + 15 * 60 * 1000
/** 一个样本最多向后延续多久；至少两格，免得后端相邻两点之间被断成缝。 */
const MIN_HOLD_MS = 5 * 60 * 1000

export type ProbeMetric = 'latency' | 'loss'

export interface ProbeSeriesInput {
  target: ProbeTarget
  metric: ProbeMetric
  /** 后端窗口里该目标的序列（`null` 无采样 / `false` 未配置，都要保住位置）。 */
  windowPoints: readonly GlassLatencySample[]
  /** 浏览器累积的真实探测样本。 */
  live: readonly ProbeLiveValue[]
  now: number
  count?: number
}

export interface ProbeSeriesView {
  /** 等长时间桶，固定 `count` 个；`null` 表示这一格没有任何真实覆盖。 */
  bars: GlassLatencySample[]
  /** 合并后的原始样本点（给时间曲线弹窗用）。 */
  points: GlassLatencySample[]
  /** 整段窗口内按覆盖时长加权的平均值。 */
  average: number | null
  /** 参与平均的真实样本条数（工具提示里说明口径用）。 */
  samples: number
}

function numericValue(value: ProbeValue | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

function liveValue(sample: ProbeLiveValue, target: ProbeTarget, metric: ProbeMetric): number | null {
  const source = metric === 'latency' ? sample.latency : sample.loss
  return numericValue(source[target])
}

/** 窗口网格步长：取相邻间隔的中位数，夹在 1～30 分钟之间。 */
function resolveStepMs(points: readonly GlassLatencySample[]): number {
  const gaps: number[] = []
  for (let index = 1; index < points.length; index += 1) {
    const gap = points[index]!.timestamp - points[index - 1]!.timestamp
    if (gap > 0) gaps.push(gap)
  }
  if (gaps.length === 0) return DEFAULT_STEP_MS
  gaps.sort((left, right) => left - right)
  const median = gaps[Math.floor((gaps.length - 1) / 2)] ?? DEFAULT_STEP_MS
  return Math.min(MAX_STEP_MS, Math.max(MIN_STEP_MS, median))
}

export function probeSeriesView(input: ProbeSeriesInput): ProbeSeriesView {
  const { target, metric, now } = input
  const count = Math.min(240, Math.max(1, Math.round(input.count ?? PROBE_BUCKET_COUNT)))

  const windowPoints = input.windowPoints.filter((point) => (
    Number.isFinite(point.timestamp) && point.timestamp > 0 && point.timestamp <= now
  ))
  const step = resolveStepMs(windowPoints)
  const half = step / 2

  const livePoints: GlassLatencySample[] = []
  for (const sample of input.live) {
    if (!Number.isFinite(sample.time) || sample.time <= 0 || sample.time > now) continue
    const value = liveValue(sample, target, metric)
    if (value === null) continue
    livePoints.push({ timestamp: sample.time, value })
  }

  /* 本地实测覆盖到的窗口点丢掉；没被覆盖的留着补「浏览器打开之前」的空档。 */
  const merged: GlassLatencySample[] = []
  for (const point of windowPoints) {
    const covered = livePoints.some((live) => Math.abs(live.timestamp - point.timestamp) <= half)
    if (covered) continue
    merged.push({ timestamp: point.timestamp, value: numericValue(point.value) })
  }
  merged.push(...livePoints)
  merged.sort((left, right) => left.timestamp - right.timestamp)

  if (merged.length === 0) {
    return { bars: [], points: [], average: null, samples: 0 }
  }

  const oldest = merged[0]!.timestamp
  const windowMs = Math.min(MAX_WINDOW_MS, Math.max(MIN_WINDOW_MS, now - oldest))
  const windowStart = now - windowMs
  const bucketMs = windowMs / count
  const holdCap = Math.max(MIN_HOLD_MS, step * 2)

  const sums = new Array<number>(count).fill(0)
  const coveredMs = new Array<number>(count).fill(0)
  let totalSum = 0
  let totalCovered = 0
  let samples = 0

  for (let index = 0; index < merged.length; index += 1) {
    const point = merged[index]!
    const value = numericValue(point.value)
    // 空槽（后端那格没采样 / 探测点未配置）只当断点，不参与平均。
    if (value === null) continue
    const next = merged[index + 1]
    const end = Math.min(next === undefined ? now : next.timestamp, point.timestamp + holdCap, now)
    const start = Math.max(point.timestamp, windowStart)
    if (end <= start) continue

    samples += 1
    totalSum += value * (end - start)
    totalCovered += end - start

    for (let bucket = 0; bucket < count; bucket += 1) {
      const bucketStart = windowStart + bucket * bucketMs
      const overlap = Math.min(end, bucketStart + bucketMs) - Math.max(start, bucketStart)
      if (overlap <= 0) continue
      sums[bucket] += value * overlap
      coveredMs[bucket] += overlap
    }
  }

  const bars = Array.from({ length: count }, (_, bucket): GlassLatencySample => ({
    timestamp: windowStart + bucket * bucketMs,
    value: coveredMs[bucket]! > 0 ? sums[bucket]! / coveredMs[bucket]! : null,
  }))

  return {
    bars,
    points: merged,
    average: totalCovered > 0 ? totalSum / totalCovered : null,
    samples,
  }
}

export interface ProbeHistorySource {
  latencyWindow: readonly LatencyWindowSample[]
  packetLossWindow: readonly LatencyWindowSample[]
}

function windowSeries(
  window: readonly LatencyWindowSample[],
  target: ProbeTarget,
): GlassLatencySample[] {
  return window.map((sample) => ({ timestamp: sample.timestamp, value: sample[target] }))
}

/**
 * 把后端窗口 + 本地样本拼成 `GlassHistorySummary`。
 *
 * 某个目标在整段窗口里都是 `false`（探测点未配置）时仍然产出空序列 ——
 * 与改动前一致，卡片不会给没配的线路画柱子。
 */
export function buildProbeHistory(
  source: ProbeHistorySource,
  live: readonly ProbeLiveValue[],
  now = Date.now(),
): GlassHistorySummary {
  const latencySeries: Partial<Record<ProbeTarget, GlassLatencySample[]>> = {}
  const packetLossSeries: Partial<Record<ProbeTarget, GlassLatencySample[]>> = {}

  for (const target of PROBE_TARGETS) {
    const latencyWindow = windowSeries(source.latencyWindow, target)
    const lossWindow = windowSeries(source.packetLossWindow, target)
    if (latencyWindow.length === 0 && lossWindow.length === 0) continue

    const latencyConfigured = latencyWindow.some((point) => point.value !== false)
    const lossConfigured = lossWindow.some((point) => point.value !== false)
    if (!latencyConfigured && !lossConfigured) continue

    if (latencyConfigured) {
      const view = probeSeriesView({ target, metric: 'latency', windowPoints: latencyWindow, live, now })
      if (view.bars.length > 0) latencySeries[target] = view.bars
    }
    if (lossConfigured) {
      const view = probeSeriesView({ target, metric: 'loss', windowPoints: lossWindow, live, now })
      if (view.bars.length > 0) packetLossSeries[target] = view.bars
    }
  }

  return { latencySeries, packetLossSeries }
}
