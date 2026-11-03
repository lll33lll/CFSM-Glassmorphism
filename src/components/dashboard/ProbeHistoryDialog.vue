<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import AppDialog from '@/components/ui/AppDialog.vue'
import type { ProbeHistorySeries } from '@/domain/probe-history'
import { formatLatency, formatProbePercent } from '@/utils/format'

/**
 * 首页节点卡的「延迟 / 丢包」时间曲线弹窗。
 *
 * 点击卡片里的延迟或丢包面板时打开，不再跳到节点详情页。数据就是
 * `/api/servers` 已经返回的 20 个时间桶，按探测目标分组绘制；`null` / `false`
 * 保持断点，不用 0 补齐。
 */
const props = defineProps<{
  serverName: string
  metric: 'latency' | 'loss'
  series: ProbeHistorySeries[]
}>()

const open = defineModel<boolean>('open', { required: true })

const metricLabel = computed(() => (props.metric === 'latency' ? '延迟' : '丢包'))
const unit = computed(() => (props.metric === 'latency' ? 'ms' : '%'))

const CHART = { width: 340, height: 158, left: 34, right: 8, top: 10, bottom: 22 }

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

const timeFormatter = new Intl.DateTimeFormat('zh-CN', {
  hour: '2-digit',
  minute: '2-digit',
})

function formatTime(timestamp: number): string {
  return timeFormatter.format(new Date(timestamp))
}

function formatTick(value: number): string {
  if (props.metric === 'loss') {
    return value >= 10 ? value.toFixed(0) : value.toFixed(1)
  }
  return value.toFixed(0)
}

const chart = computed(() => {
  const allPoints = props.series.flatMap((item) => item.points)
  const timestamps = allPoints
    .map((point) => point.timestamp)
    .filter((timestamp) => Number.isFinite(timestamp))
  const xMin = timestamps.length > 0 ? Math.min(...timestamps) : 0
  const xMaxRaw = timestamps.length > 0 ? Math.max(...timestamps) : 1
  const xMax = xMaxRaw > xMin ? xMaxRaw : xMin + 1

  const values = allPoints
    .map((point) => point.value)
    .filter(isNumber)
    .map((value) => Math.max(0, value))
  const rawMax = values.length > 0 ? Math.max(...values) : 0
  const yMax = props.metric === 'latency'
    ? Math.max(60, Math.ceil((rawMax * 1.15) / 20) * 20)
    : Math.max(2, Math.ceil(rawMax * 1.2 * 2) / 2)

  const plotWidth = CHART.width - CHART.left - CHART.right
  const plotHeight = CHART.height - CHART.top - CHART.bottom
  const xOf = (timestamp: number): number => (
    CHART.left + ((timestamp - xMin) / (xMax - xMin)) * plotWidth
  )
  const yOf = (value: number): number => (
    CHART.top + (1 - Math.min(Math.max(value, 0), yMax) / yMax) * plotHeight
  )

  const lines = props.series.map((item) => {
    const segments: string[] = []
    let current: string[] = []
    const dots: { x: number, y: number }[] = []

    for (const point of item.points) {
      if (!isNumber(point.value)) {
        if (current.length > 1) segments.push(current.join(' '))
        current = []
        continue
      }
      const x = xOf(point.timestamp)
      const y = yOf(point.value)
      current.push(`${current.length === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`)
      dots.push({ x, y })
    }
    if (current.length > 1) segments.push(current.join(' '))

    return { ...item, segments, dots }
  })

  const yTicks = [0, yMax / 2, yMax]
  const xTicks = [xMin, xMin + (xMax - xMin) / 2, xMax]
  const buckets = [...new Set(timestamps)].sort((a, b) => a - b)

  return {
    width: CHART.width,
    height: CHART.height,
    left: CHART.left,
    right: CHART.right,
    top: CHART.top,
    bottom: CHART.bottom,
    yMax,
    yTicks,
    xTicks,
    buckets,
    xOf,
    yOf,
    lines,
    hasData: values.length > 0,
  }
})

const hoverIndex = ref<number | null>(null)

watch(() => props.metric, () => {
  hoverIndex.value = null
})

const hover = computed(() => {
  const index = hoverIndex.value
  const current = chart.value
  if (index === null || !current.hasData) return null
  const timestamp = current.buckets[index]
  if (timestamp === undefined) return null

  const items = props.series.map((item) => {
    const point = item.points.find((sample) => sample.timestamp === timestamp)
    const valueText = point === undefined
      ? '—'
      : props.metric === 'latency'
        ? formatLatency(point.value)
        : formatProbePercent(point.value)
    const y = point !== undefined && typeof point.value === 'number' && Number.isFinite(point.value)
      ? current.yOf(point.value)
      : null
    return { key: item.key, label: item.label, color: item.color, valueText, y }
  })

  const x = current.xOf(timestamp)
  const leftPercent = Math.min(82, Math.max(18, (x / current.width) * 100))

  return {
    time: formatTime(timestamp),
    x,
    items,
    leftPercent,
  }
})

function handlePointerMove(event: PointerEvent): void {
  const svg = event.currentTarget
  if (!(svg instanceof SVGElement)) return
  const current = chart.value
  if (!current.hasData || current.buckets.length === 0) return

  const rect = svg.getBoundingClientRect()
  const xInView = ((event.clientX - rect.left) / rect.width) * current.width
  let nearest = 0
  let nearestDistance = Number.POSITIVE_INFINITY
  current.buckets.forEach((timestamp, index) => {
    const distance = Math.abs(current.xOf(timestamp) - xInView)
    if (distance < nearestDistance) {
      nearestDistance = distance
      nearest = index
    }
  })
  hoverIndex.value = nearest
}

function clearPointer(): void {
  hoverIndex.value = null
}
</script>

<template>
  <AppDialog
    v-model:open="open"
    :title="`${props.serverName} · ${metricLabel}`"
    description="窗口内每个时间桶的采样值，断线表示无采样或探测点未配置"
  >
    <div class="probe-chart">
      <div class="probe-chart__legend">
        <span v-for="item in props.series" :key="item.key" class="probe-chart__legend-item">
          <i class="probe-chart__dot" :style="{ background: item.color }" aria-hidden="true" />
          <span>{{ item.label }}</span>
          <strong>{{ item.valueText }}</strong>
        </span>
      </div>

      <div v-if="chart.hasData" class="probe-chart__plot-wrap">
        <svg
          class="probe-chart__plot"
          :viewBox="`0 0 ${chart.width} ${chart.height}`"
          role="img"
          :aria-label="`${props.serverName} ${metricLabel}时间曲线`"
          @pointermove="handlePointerMove"
          @pointerdown="handlePointerMove"
          @pointerleave="clearPointer"
        >
          <g class="probe-chart__grid">
            <line
              v-for="tick in chart.yTicks"
              :key="`grid-${tick}`"
              :x1="chart.left"
              :x2="chart.width - chart.right"
              :y1="chart.yOf(tick)"
              :y2="chart.yOf(tick)"
            />
          </g>

          <g class="probe-chart__axis">
            <text
              v-for="tick in chart.yTicks"
              :key="`y-${tick}`"
              :x="chart.left - 6"
              :y="chart.yOf(tick)"
              text-anchor="end"
              dominant-baseline="middle"
            >{{ formatTick(tick) }}</text>
            <text
              v-for="(tick, index) in chart.xTicks"
              :key="`x-${tick}`"
              :x="chart.xOf(tick)"
              :y="chart.height - 6"
              :text-anchor="index === 0 ? 'start' : index === chart.xTicks.length - 1 ? 'end' : 'middle'"
            >{{ formatTime(tick) }}</text>
          </g>

          <g v-for="line in chart.lines" :key="line.key" class="probe-chart__series">
            <path
              v-for="(segment, index) in line.segments"
              :key="`${line.key}-${index}`"
              :d="segment"
              class="probe-chart__line"
              :style="{ stroke: line.color }"
              vector-effect="non-scaling-stroke"
            />
            <circle
              v-for="(dot, index) in line.dots"
              :key="`${line.key}-dot-${index}`"
              :cx="dot.x"
              :cy="dot.y"
              r="1.7"
              class="probe-chart__point"
              :style="{ fill: line.color }"
            />
          </g>

          <g v-if="hover" class="probe-chart__cursor">
            <line
              :x1="hover.x"
              :x2="hover.x"
              :y1="chart.top"
              :y2="chart.height - chart.bottom"
            />
            <template v-for="item in hover.items" :key="`active-${item.key}`">
              <circle
                v-if="item.y !== null"
                :cx="hover.x"
                :cy="item.y"
                r="3.2"
                class="probe-chart__point probe-chart__point--active"
                :style="{ fill: item.color }"
              />
            </template>
          </g>
        </svg>

        <div
          v-if="hover"
          class="probe-chart__tooltip"
          :style="{ left: `${hover.leftPercent}%` }"
        >
          <div class="probe-chart__tooltip-time">
            {{ hover.time }}
          </div>
          <div
            v-for="item in hover.items"
            :key="item.key"
            class="probe-chart__tooltip-row"
          >
            <i class="probe-chart__dot" :style="{ background: item.color }" aria-hidden="true" />
            <span>{{ item.label }}</span>
            <strong>{{ item.valueText }}</strong>
          </div>
        </div>
      </div>

      <p v-else class="probe-chart__empty">
        这个窗口里没有可绘制的采样值。
      </p>

      <p class="probe-chart__hint">
        横轴为采样时间，纵轴单位 {{ unit }}；每个点对应一个时间桶。
      </p>
    </div>
  </AppDialog>
</template>

<style scoped>
.probe-chart {
  display: flex;
  flex-direction: column;
  gap: 12px;
  animation: probe-chart-enter 240ms cubic-bezier(0.22, 1, 0.36, 1) both;
}

@keyframes probe-chart-enter {
  from {
    opacity: 0;
    transform: translateY(8px) scale(0.98);
  }
  to {
    opacity: 1;
    transform: translateY(0) scale(1);
  }
}

.probe-chart__legend {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 14px;
}

.probe-chart__legend-item {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--muted);
  font-size: 12px;
}

.probe-chart__legend-item strong {
  color: var(--ink);
  font-weight: 500;
  font-variant-numeric: tabular-nums;
}

.probe-chart__dot {
  width: 8px;
  height: 8px;
  flex: none;
  border-radius: 999px;
}

.probe-chart__plot-wrap {
  position: relative;
  border-radius: 10px;
  padding: 8px 4px 2px;
  background: color-mix(in srgb, var(--glass) 45%, transparent);
}

.probe-chart__plot {
  display: block;
  width: 100%;
  height: auto;
  cursor: crosshair;
  touch-action: pan-y;
}

.probe-chart__grid line {
  stroke: color-mix(in srgb, var(--muted) 18%, transparent);
  stroke-width: 1;
}

.probe-chart__axis text {
  fill: var(--muted);
  font-size: 9px;
  font-variant-numeric: tabular-nums;
}

.probe-chart__line {
  fill: none;
  stroke-width: 2.4;
  stroke-linecap: round;
  stroke-linejoin: round;
}

/* 整条曲线从左往右揭开，避免对折线做 dash 动画时出现虚线。 */
.probe-chart__series {
  clip-path: inset(0 100% 0 0);
  animation: probe-series-reveal 720ms ease-in-out forwards;
}

@keyframes probe-series-reveal {
  to {
    clip-path: inset(0 0 0 0);
  }
}

.probe-chart__point {
  stroke: var(--glass);
  stroke-width: 1;
}

.probe-chart__point--active {
  opacity: 1;
  animation: none;
  stroke: var(--glass);
  stroke-width: 1.5;
}

.probe-chart__cursor line {
  stroke: color-mix(in srgb, var(--ink) 35%, transparent);
  stroke-width: 1;
  stroke-dasharray: 3 3;
  vector-effect: non-scaling-stroke;
}

.probe-chart__tooltip {
  position: absolute;
  top: 8px;
  z-index: 2;
  min-width: 116px;
  padding: 7px 9px;
  border-radius: 8px;
  background: color-mix(in srgb, var(--glass) 82%, transparent);
  box-shadow: 0 10px 26px rgb(15 23 42 / 22%);
  transform: translateX(-50%);
  pointer-events: none;
  backdrop-filter: blur(14px);
  -webkit-backdrop-filter: blur(14px);
}

.probe-chart__tooltip-time {
  margin-bottom: 4px;
  color: var(--muted);
  font-size: 10px;
  font-variant-numeric: tabular-nums;
}

.probe-chart__tooltip-row {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--muted);
  font-size: 11px;
  line-height: 1.5;
}

.probe-chart__tooltip-row strong {
  margin-left: auto;
  color: var(--ink);
  font-weight: 500;
  font-variant-numeric: tabular-nums;
}

@media (prefers-reduced-motion: reduce) {
  .probe-chart,
  .probe-chart__series {
    animation: none;
    clip-path: none;
  }
}

.probe-chart__empty {
  margin: 0;
  padding: 24px 12px;
  border-radius: 10px;
  background: color-mix(in srgb, var(--glass) 45%, transparent);
  color: var(--muted);
  font-size: 12px;
  text-align: center;
}

.probe-chart__hint {
  margin: 0;
  color: var(--muted);
  font-size: 11px;
}
</style>
