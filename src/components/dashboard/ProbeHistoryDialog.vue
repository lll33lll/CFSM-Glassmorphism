<script setup lang="ts">
import { computed } from 'vue'
import AppDialog from '@/components/ui/AppDialog.vue'
import type { ProbeHistorySeries } from '@/domain/probe-history'

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
    xOf,
    yOf,
    lines,
    hasData: values.length > 0,
  }
})
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

          <g v-for="line in chart.lines" :key="line.key">
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
        </svg>
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
  border-radius: 10px;
  padding: 8px 4px 2px;
  background: color-mix(in srgb, var(--glass) 45%, transparent);
}

.probe-chart__plot {
  display: block;
  width: 100%;
  height: auto;
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
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.probe-chart__point {
  stroke: var(--glass);
  stroke-width: 1;
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
