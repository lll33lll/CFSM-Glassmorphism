import type { ProbeTarget } from '@/types/cfsm'
import type {
  GlassHistorySummary,
  GlassLatencyMetric,
  GlassLatencySample,
} from '@/types/glassmorphism'

/*
 * 首页延迟 / 丢包小窗口的读取工具。
 *
 * 窗口来自 `/api/servers` 的 `servers[].ping` / `servers[].loss`，
 * 服务端按时间桶输出固定 20 个点、覆盖 2 小时，每个点含全部 8 个探测目标。
 * 序列按目标分组保存，`null`（该桶无采样）与 `false`（该探测点未配置）都必须保留：
 * 柱状图是按桶逐格渲染的，过滤空洞会让后续柱子前移、时间轴错位。
 */

export type ProbeSeriesMap = Partial<Record<ProbeTarget, GlassLatencySample[]>>

/**
 * 首页卡片 / 列表同时展示的线路数量上限。
 *
 * CFSM 的「三网详情」对应旧四线路里的 ct / cu / cm（电信 / 联通 / 移动）。
 * 站点只配置了 node_1～node_4 这类自定义探测点时没有三网概念，退回按顺序展示前三个，
 * 不做任何名称猜测，也不把未配置的线路补成 0。
 */
export const HOMEPAGE_PROBE_LIMIT = 3

/** 三网线路的固定顺序：电信 → 联通 → 移动，与运营者后台的顺序无关。 */
export const HOMEPAGE_TRIPLE_TARGETS: readonly ProbeTarget[] = ['ct', 'cu', 'cm']

/**
 * 首页要展示的探测目标。
 *
 * 有 ct / cu / cm 任意一条时只展示这三条（缺哪条就不显示哪条）；
 * 一条旧三网线路都没有时，退回 `latency` 里的前三个目标，保证自定义探测点也能看到多线路。
 */
export function homepageProbes(
  probes: readonly GlassLatencyMetric[],
): GlassLatencyMetric[] {
  const byTarget = new Map(probes.map((probe) => [probe.target, probe]))
  const triple = HOMEPAGE_TRIPLE_TARGETS
    .map((target) => byTarget.get(target))
    .filter((probe): probe is GlassLatencyMetric => probe !== undefined)
  if (triple.length > 0) return triple
  return probes.slice(0, HOMEPAGE_PROBE_LIMIT)
}

/** 取某个探测目标的窗口序列；该目标没有序列时返回空数组。 */
export function probeSeriesFor(series: ProbeSeriesMap, target: ProbeTarget): GlassLatencySample[] {
  return series[target] ?? []
}

/** 窗口里出现过序列的探测目标，按传入顺序返回。 */
export function seriesTargets(
  series: ProbeSeriesMap,
  order: readonly ProbeTarget[],
): ProbeTarget[] {
  return order.filter((target) => (series[target]?.length ?? 0) > 0)
}

/**
 * 把整个窗口压成纯数值样本，供健康度这类**聚合统计**使用。
 *
 * 这里丢弃 `null` / `false` 是正确的：平均值本来就只能由真实采样构成。
 * 但它不能用来画柱状图——那需要保留时间桶。
 */
export function numericWindowSamples(series: ProbeSeriesMap): number[] {
  return Object.values(series).flatMap((points) => (
    (points ?? []).flatMap((point) => (
      typeof point.value === 'number' && Number.isFinite(point.value) && point.value >= 0
        ? [point.value]
        : []
    ))
  ))
}

export interface ProbeWindowAverage {
  /** 窗口内真实采样的平均值；没有任何真实采样时为 null。 */
  value: number | null
  /** 参与平均的真实采样数，用于在提示里说明口径。 */
  samples: number
}

/**
 * Bucket-weighted window statistic. Loss is exactly LuminaPlus lossFromBuckets:
 * sum(bucket.loss * bucket.total) / sum(bucket.total). Missing and offline-state
 * buckets are excluded. Legacy series without weights still use one per sample.
 */
export function windowAverage(series: ProbeSeriesMap, target: ProbeTarget): ProbeWindowAverage {
  let sum = 0
  let samples = 0
  for (const point of probeSeriesFor(series, target)) {
    const value = point.value
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) continue
    // Offline red is a state marker, not a fabricated 100% measured loss.
    if (point.offline) continue
    const weight = point.weight ?? 1
    if (!Number.isFinite(weight) || weight <= 0) continue
    sum += value * weight
    samples += weight
  }
  return { value: samples === 0 ? null : sum / samples, samples }
}

/** Latest successful latency (LuminaPlus lastValue + withLiveLatency), not bucket mean. */
export function latestProbeLatency(
  history: GlassHistorySummary,
  target: ProbeTarget,
  current: number | null | false,
): number | null {
  if (typeof current === 'number' && Number.isFinite(current) && current >= 0) return current
  return history.latencyLatest?.[target] ?? null
}

/** Homepage missing samples are “—”, not “timeout”; round live latency like LuminaPlus. */
export function homepageLatencyText(value: number | null): string {
  return value === null ? '—' : `${Math.round(value)} ms`
}
export function homepageLossText(value: number | null): string {
  return value === null ? '—' : `${value.toFixed(1)}%`
}

/** 深拷贝窗口序列，用于快照导出。 */
export function cloneProbeSeries(series: ProbeSeriesMap): ProbeSeriesMap {
  return Object.fromEntries(
    Object.entries(series).map(([target, points]) => [target, (points ?? []).map((point) => ({ ...point }))]),
  ) as ProbeSeriesMap
}

/** 深拷贝整段窗口摘要。 */
export function cloneHistorySummary(history: GlassHistorySummary): GlassHistorySummary {
  return {
    latencyLatest: history.latencyLatest ? { ...history.latencyLatest } : undefined,
    latencySeries: cloneProbeSeries(history.latencySeries),
    packetLossSeries: cloneProbeSeries(history.packetLossSeries),
  }
}
