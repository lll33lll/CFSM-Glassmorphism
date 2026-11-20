<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useId, watch } from 'vue'
import type { GlassLatencySample } from '@/types/glassmorphism'
import {
  PROBE_BAR_ACTIVE_HEIGHT,
  PROBE_BAR_LATENCY_GAP_HEIGHT,
  PROBE_GAP_COLOR,
  latencyTone,
  lossTone,
} from '@/utils/probe-tone'

// LuminaPlus-style inline bucket picking. It reads the exact plotted buckets;
// it never queries history or replaces a bucket with the headline average.
const props = defineProps<{
  points: readonly GlassLatencySample[]
  metric: 'latency' | 'loss'
  label: string
  activeIndex: number | null
  mini?: boolean
}>()
const emit = defineEmits<{ select: [index: number | null] }>()
const root = ref<HTMLElement | null>(null)
const bubble = ref<HTMLElement | null>(null)
const tooltipId = useId()
const pointerId = ref<number | null>(null)
let hideTimer: ReturnType<typeof setTimeout> | null = null
let observer: ResizeObserver | null = null
const bubbleStyle = ref<Record<string, string>>({})
const emptyPoints: GlassLatencySample[] = Array.from({ length: 20 }, () => ({ timestamp: 0, value: false }))
const points = computed(() => props.points.length > 0 ? props.points : emptyPoints)
const selected = computed(() => props.activeIndex !== null ? points.value[props.activeIndex] : undefined)
const metricLabel = computed(() => props.metric === 'latency' ? '延迟' : '丢包')

function clearTimer(): void {
  if (hideTimer !== null) clearTimeout(hideTimer)
  hideTimer = null
}
function clearSelection(): void {
  clearTimer()
  if (props.activeIndex !== null) emit('select', null)
}
function holdSelection(): void {
  clearTimer()
  hideTimer = setTimeout(() => {
    hideTimer = null
    if (props.activeIndex !== null) emit('select', null)
  }, 2500)
}
function selectAt(clientX: number): void {
  const rect = root.value?.getBoundingClientRect()
  if (!rect || rect.width <= 0) return
  const index = Math.max(0, Math.min(points.value.length - 1,
    Math.floor((clientX - rect.left) / rect.width * points.value.length)))
  emit('select', index)
}
function finePointer(event: PointerEvent): boolean {
  return (event.pointerType === 'mouse' || event.pointerType === 'pen')
    && window.matchMedia('(any-hover: hover) and (any-pointer: fine)').matches
}
function onPointerDown(event: PointerEvent): void {
  if (event.button !== 0) return
  selectAt(event.clientX)
  if (finePointer(event)) {
    clearTimer()
    return
  }
  pointerId.value = event.pointerId
  try { root.value?.setPointerCapture(event.pointerId) } catch { /* optional browser support */ }
  clearTimer()
}
function onPointerMove(event: PointerEvent): void {
  if (finePointer(event)) {
    selectAt(event.clientX)
    clearTimer()
  } else if (pointerId.value === event.pointerId) {
    selectAt(event.clientX)
    clearTimer()
  }
}
function finishPointer(event: PointerEvent): void {
  if (pointerId.value !== event.pointerId) return
  pointerId.value = null
  try {
    if (root.value?.hasPointerCapture(event.pointerId)) root.value.releasePointerCapture(event.pointerId)
  } catch { /* capture can already have been released by scrolling */ }
  holdSelection()
}
function leavePointer(event: PointerEvent): void {
  if (finePointer(event) && pointerId.value === null) clearSelection()
}
function onClick(event: MouseEvent): void {
  // Keyboard/screen-reader activation does not produce pointer coordinates.
  if (event.detail === 0) {
    emit('select', props.activeIndex ?? points.value.length - 1)
    holdSelection()
  }
}
function onKeydown(event: KeyboardEvent): void {
  const current = props.activeIndex ?? points.value.length - 1
  let index: number | null = current
  switch (event.key) {
    case 'ArrowLeft': index = Math.max(0, current - 1); break
    case 'ArrowRight': index = Math.min(points.value.length - 1, current + 1); break
    case 'Home': index = 0; break
    case 'End': index = points.value.length - 1; break
    case 'Enter': case ' ': break
    case 'Escape': index = null; break
    default: return
  }
  event.preventDefault()
  clearTimer()
  emit('select', index)
}
function timeText(timestamp: number): string {
  const date = new Date(timestamp)
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}
function valueText(point: GlassLatencySample): string {
  if (point.offline) return '节点离线'
  if (typeof point.value !== 'number' || !Number.isFinite(point.value) || point.value < 0) {
    return props.metric === 'latency' && (point.weight ?? 0) > 0 ? '探测失败' : '无采样'
  }
  const value = point.value.toFixed(1).replace(/\.0$/, '')
  return `${value}${props.metric === 'loss' ? '%' : ' ms'}`
}
const tooltipText = computed(() => {
  const point = selected.value
  if (!point) return ''
  const index = props.activeIndex ?? 0
  const next = points.value[index + 1]
  const previous = points.value[index - 1]
  const step = next ? next.timestamp - point.timestamp : previous ? point.timestamp - previous.timestamp : 0
  const end = point.endTimestamp ?? (step > 0 ? point.timestamp + step : point.timestamp)
  const time = point.timestamp > 0 && Number.isFinite(point.timestamp)
    ? `${timeText(point.timestamp)} - ${timeText(end)} · ` : ''
  return `${time}${valueText(point)}`
})
function barStyle(point: GlassLatencySample): Record<string, string> {
  const numeric = typeof point.value === 'number' && Number.isFinite(point.value) && point.value >= 0
  const active = point.offline || numeric
  return {
    background: point.offline ? lossTone(100) : numeric
      ? (props.metric === 'loss' ? lossTone(point.value as number) : latencyTone(point.value as number)) : PROBE_GAP_COLOR,
    height: active || props.metric === 'loss' ? PROBE_BAR_ACTIVE_HEIGHT : PROBE_BAR_LATENCY_GAP_HEIGHT,
    opacity: active ? '0.94' : props.metric === 'loss' ? '0.42' : '0.55',
  }
}
async function positionBubble(): Promise<void> {
  await nextTick()
  const element = root.value
  const tip = bubble.value
  if (!element || !tip || props.activeIndex === null) return
  const rect = element.getBoundingClientRect()
  let clip = { left: 0, right: document.documentElement.clientWidth }
  for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
    if (getComputedStyle(ancestor).overflowX !== 'visible') {
      clip = ancestor.getBoundingClientRect()
      break
    }
  }
  tip.style.maxWidth = `${Math.max(1, clip.right - clip.left - 8)}px`
  const width = tip.offsetWidth
  const center = (props.activeIndex + 0.5) / points.value.length * rect.width
  const min = clip.left - rect.left + 4 + width / 2
  const max = clip.right - rect.left - 4 - width / 2
  const left = min <= max ? Math.min(Math.max(center, min), max) : center
  const arrow = Math.max(8, Math.min(width - 8, center - left + width / 2))
  bubbleStyle.value = { left: `${left}px`, '--picker-arrow-x': `${arrow}px` }
}
watch([() => props.activeIndex, tooltipText], () => {
  if (props.activeIndex === null) clearTimer()
  else void positionBubble()
})
onMounted(() => {
  if (typeof ResizeObserver !== 'undefined' && root.value) {
    observer = new ResizeObserver(() => { void positionBubble() })
    observer.observe(root.value)
  }
})
onBeforeUnmount(() => {
  clearTimer()
  observer?.disconnect()
})
</script>

<template>
  <div
    ref="root"
    class="probe-bar-picker"
    :class="{ 'probe-bar-picker--mini': mini }"
    role="group"
    tabindex="0"
    :aria-label="`${label}${metricLabel}历史柱带，点击或用左右方向键查看时间桶`"
    :aria-describedby="selected ? tooltipId : undefined"
    @click.stop="onClick"
    @dblclick.stop
    @contextmenu.prevent.stop
    @keydown.stop="onKeydown"
    @blur="clearSelection"
    @pointerenter="onPointerMove"
    @pointerdown.stop="onPointerDown"
    @pointermove.stop="onPointerMove"
    @pointerup.stop="finishPointer"
    @pointercancel.stop="finishPointer"
    @pointerleave="leavePointer"
  >
    <span class="node-probe__bars probe-bar-picker__track" :style="{ gridTemplateColumns: `repeat(${points.length}, minmax(0, 1fr))` }">
      <span
        v-for="(point, index) in points"
        :key="index"
        class="probe-bar-picker__bar"
        :data-selected="activeIndex === index ? 'true' : undefined"
        :style="barStyle(point)"
        aria-hidden="true"
      />
    </span>
    <span v-if="selected" :id="tooltipId" ref="bubble" class="probe-bar-picker__tooltip" :style="bubbleStyle" role="status" aria-live="polite">
      {{ tooltipText }}
    </span>
  </div>
</template>

<style scoped>
.probe-bar-picker {
  --picker-bar-height: 6px;
  position: relative;
  min-width: 0;
  height: calc(var(--picker-bar-height) + 12px);
  margin-block: -6px;
  cursor: pointer;
  touch-action: pan-y;
  -webkit-tap-highlight-color: transparent;
  -webkit-touch-callout: none;
  user-select: none;
}
.probe-bar-picker--mini { --picker-bar-height: 4px; }
:global(.node-card--offline .node-probe:has(.probe-bar-picker__tooltip)) {
  opacity: 1;
  filter: none;
}
.probe-bar-picker__track {
  position: absolute;
  top: 6px;
  left: 0;
  right: 0;
  height: var(--picker-bar-height);
  min-height: var(--picker-bar-height);
  align-items: end;
  opacity: 1;
}
.probe-bar-picker__bar {
  border-radius: 1.5px;
  transform-origin: bottom;
  transition: transform 150ms ease, filter 150ms ease, opacity 150ms ease;
}
.probe-bar-picker__bar[data-selected='true'] {
  opacity: 1 !important;
  filter: saturate(1.14) brightness(1.04);
  transform: scaleY(1.55);
}
.probe-bar-picker:focus-visible { outline: 2px solid var(--emerald); outline-offset: 2px; border-radius: 3px; }
.probe-bar-picker__tooltip {
  position: absolute;
  z-index: 5;
  bottom: calc(100% + 2px);
  left: 50%;
  transform: translateX(-50%);
  width: max-content;
  max-width: 270px;
  box-sizing: border-box;
  padding: 5px 8px;
  border-radius: 6px;
  background: #18181b;
  color: #fafafa;
  font-size: 11px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  line-height: 1.35;
  white-space: nowrap;
  pointer-events: none;
  box-shadow: 0 3px 12px rgb(0 0 0 / 20%);
}
.probe-bar-picker__tooltip::after {
  content: '';
  position: absolute;
  top: 100%;
  left: var(--picker-arrow-x, 50%);
  border: 4px solid transparent;
  border-top-color: #18181b;
  transform: translateX(-50%);
}
@media (any-hover: hover) and (any-pointer: fine) {
  .probe-bar-picker:hover .probe-bar-picker__bar:not([data-selected='true']) { opacity: 0.54 !important; }
}
@media (prefers-reduced-motion: reduce) {
  .probe-bar-picker__bar { transition: none; }
}
</style>
