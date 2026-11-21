import { PROBE_TARGETS } from '@/constants/probes'
import type { LatencyWindowSample, ProbeTarget, ProbeValue, ProbeValues } from '@/types/cfsm'
import type { GlassHistorySummary, GlassLatencySample, ProbeLiveValue } from '@/types/glassmorphism'
import { buildHomepageProbeSeries, HOMEPAGE_PING_BUCKET_COUNT } from './probe-lumina'

/** Same merge, 15-second sample weight and midpoint bucket model as LuminaPlus v1.2.24. */
export const PROBE_BUCKET_COUNT = HOMEPAGE_PING_BUCKET_COUNT
export type ProbeMetric = 'latency' | 'loss'
export interface ProbeSeriesInput {
  target: ProbeTarget
  metric: ProbeMetric
  windowPoints: readonly GlassLatencySample[]
  live: readonly ProbeLiveValue[]
  now: number
  count?: number
}
export interface ProbeSeriesView {
  bars: GlassLatencySample[]
  points: GlassLatencySample[]
  average: number | null
  samples: number
}
function emptyProbeValues(): ProbeValues {
  return Object.fromEntries(PROBE_TARGETS.map((target) => [target, false])) as ProbeValues
}
/** Backward-compatible metric-only accessor; production builds join both metrics below. */
export function probeSeriesView(input: ProbeSeriesInput): ProbeSeriesView {
  const window = input.windowPoints.map((point): ProbeLiveValue => {
    const latency = emptyProbeValues()
    const loss = emptyProbeValues()
    if (input.metric === 'loss') {
      loss[input.target] = point.value
      latency[input.target] = typeof point.value === 'number' ? 0 : point.value
    } else latency[input.target] = point.value
    return { time: point.timestamp, latency, loss }
  })
  const history = buildHomepageProbeSeries(window, input.live, input.now)
  const bars = (input.metric === 'loss' ? history.packetLossSeries : history.latencySeries)[input.target] ?? []
  let sum = 0
  let samples = 0
  for (const bar of bars) {
    if (typeof bar.value !== 'number' || (bar.weight ?? 0) <= 0 || bar.offline) continue
    sum += bar.value * bar.weight!
    samples += bar.weight!
  }
  const points = [...input.windowPoints, ...input.live.map((sample) => ({ timestamp: sample.time, value: sample[input.metric === 'loss' ? 'loss' : 'latency'][input.target] as ProbeValue }))].sort((a, b) => a.timestamp - b.timestamp)
  return { bars, points, average: samples > 0 ? sum / samples : null, samples }
}

export interface ProbeHistorySource {
  latencyWindow: readonly LatencyWindowSample[]
  packetLossWindow: readonly LatencyWindowSample[]
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
  options: { offlineSince?: number | null; windowMs?: number; measuredAt?: number } = {},
): GlassHistorySummary {
  // Join ping and loss on the same timestamp BEFORE merging local measurements.
  // Independent merges used to assign each metric a different timeline/weight.
  const byTime = new Map<number, ProbeLiveValue>()
  const emptyValues = (): ProbeValues => Object.fromEntries(PROBE_TARGETS.map((target) => [target, false])) as ProbeValues
  for (const [metric, points] of [['latency', source.latencyWindow], ['loss', source.packetLossWindow]] as const) {
    for (const point of points) {
      let sample = byTime.get(point.timestamp)
      if (!sample) {
        sample = { time: point.timestamp, latency: emptyValues(), loss: emptyValues() }
        byTime.set(point.timestamp, sample)
      }
      for (const target of PROBE_TARGETS) sample[metric][target] = point[target]
    }
  }
  return buildHomepageProbeSeries([...byTime.values()], live, now, options.offlineSince, options.windowMs, options.measuredAt)
}
