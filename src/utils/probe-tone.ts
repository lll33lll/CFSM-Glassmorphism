/*
 * 首页延迟 / 丢包柱子的着色，口径逐字对齐 volcano-1025/CFSM-Theme-LuminaPlus 的
 * `src/utils/metricTone.ts`（MIT）：
 *
 * - 延迟：五档离散色阶（≤60 / ≤100 / ≤160 / ≤200 / 更高），保证 53ms 与 91ms 一眼可分；
 * - 丢包：连续 HSL 热力渐变，分段上界 1% / 3% / 5% / 10%，末段跨度 20%，
 *   颜色从绿（hue 145）经黄绿、黄、橙走到红（hue 6）。
 *
 * 不复用主题里的 `--signal-1..5`：那是上游 Komari 的五档色阶，和这个主题不是同一套口径，
 * 混用就会出现「同样是 5% 丢包，颜色对不上」。
 */

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function hsl(hue: number, saturation: number, lightness: number): string {
  return `hsl(${hue.toFixed(1)} ${saturation.toFixed(1)}% ${lightness.toFixed(1)}%)`
}

/** 没有任何真实采样时的中性色。 */
export const PROBE_NEUTRAL_COLOR = 'var(--muted)'
/** 序列中间某个时间桶没有采样时的空洞色。 */
export const PROBE_GAP_COLOR = 'color-mix(in srgb, var(--muted) 15%, transparent)'
/** 整段都没有数据时的占位色。 */
export const PROBE_EMPTY_COLOR = 'color-mix(in srgb, var(--muted) 10%, transparent)'

/** 与 LuminaPlus 的 `HEALTH_LOSS_BAR_HEIGHT` 一致：所有有值的柱子都是 84% 高。 */
export const PROBE_BAR_ACTIVE_HEIGHT = '84%'
/** 延迟没有采样时是矮柱（25%），丢包没有采样时是满高但很淡（84% / 42% 透明度）。 */
export const PROBE_BAR_LATENCY_GAP_HEIGHT = '25%'

export function latencyTone(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return PROBE_NEUTRAL_COLOR
  if (ms <= 60) return '#2fc66e'
  if (ms <= 100) return '#9fe339'
  if (ms <= 160) return '#cbd83a'
  if (ms <= 200) return '#e2a928'
  return '#dc2626'
}

type HeatSegment = (t: number) => string

const LOSS_HEAT_SEGMENTS: readonly HeatSegment[] = [
  (t) => hsl(145 - 18 * t, 62 + 8 * t, 48 + 3 * t),
  (t) => hsl(127 - 47 * t, 70 + 6 * t, 51 + 1 * t),
  (t) => hsl(80 - 30 * t, 76 + 6 * t, 52 + 1 * t),
  (t) => hsl(50 - 20 * t, 82 + 4 * t, 53 - 1 * t),
  (t) => hsl(30 - 24 * t, 86 - 2 * t, 52 - 8 * t),
]

const LOSS_BOUNDS = [1, 3, 5, 10] as const
/** 末段（10% 往上）的归一化跨度。 */
const LOSS_TAIL_SPAN = 20

export function lossTone(pct: number | null | undefined): string {
  if (pct === null || pct === undefined || !Number.isFinite(pct) || pct < 0) {
    return PROBE_NEUTRAL_COLOR
  }
  const segment = (index: number, t: number): string =>
    (LOSS_HEAT_SEGMENTS[index] ?? LOSS_HEAT_SEGMENTS[0]!)(clamp(t, 0, 1))
  const [first, second, third, fourth] = LOSS_BOUNDS
  if (pct <= first) return segment(0, pct / first)
  if (pct <= second) return segment(1, (pct - first) / (second - first))
  if (pct <= third) return segment(2, (pct - second) / (third - second))
  if (pct <= fourth) return segment(3, (pct - third) / (fourth - third))
  return segment(4, (pct - fourth) / LOSS_TAIL_SPAN)
}
