<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useId, watch } from 'vue'
import type { GlassLatencySample } from '@/types/glassmorphism'
import { PROBE_BAR_ACTIVE_HEIGHT, PROBE_BAR_LATENCY_GAP_HEIGHT, PROBE_GAP_COLOR, latencyTone, lossTone } from '@/utils/probe-tone'

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
const isOpen = ref(false)
const inputMode = ref<'idle' | 'touch' | 'mouse' | 'keyboard'>('idle')
const placement = ref<'above' | 'below'>('above')
const bubbleStyle = ref<Record<string, string>>({})
let hideTimer: ReturnType<typeof setTimeout> | null = null
let observer: ResizeObserver | null = null
let positionFrame: number | null = null
let lastTouchAt = 0
const emptyPoints: GlassLatencySample[] = Array.from({ length: 20 }, () => ({ timestamp: 0, value: false }))
const points = computed(() => props.points.length > 0 ? props.points : emptyPoints)
const selectionIndex = computed(() => isOpen.value ? props.activeIndex : null)
const selected = computed(() => selectionIndex.value !== null ? points.value[selectionIndex.value] : undefined)
const metricLabel = computed(() => props.metric === 'latency' ? '延迟' : '丢包')

function clearTimer(): void {
  if (hideTimer !== null) clearTimeout(hideTimer)
  hideTimer = null
}
function releasePointer(): void {
  const id = pointerId.value
  pointerId.value = null
  if (id === null) return
  try { if (root.value?.hasPointerCapture(id)) root.value.releasePointerCapture(id) } catch { /* optional capture support */ }
}
function resetLocal(): void {
  // Reset visuals immediately, not only after the parent has processed select(null).
  isOpen.value = false
  inputMode.value = 'idle'
  clearTimer()
  releasePointer()
}
function clearSelection(): void {
  resetLocal()
  emit('select', null)
}
function holdSelection(): void {
  clearTimer()
  hideTimer = setTimeout(clearSelection, 2500)
}
function selectIndex(index: number, mode: 'touch' | 'mouse' | 'keyboard'): void {
  isOpen.value = true
  inputMode.value = mode
  emit('select', Math.max(0, Math.min(points.value.length - 1, index)))
}
function selectAt(clientX: number, mode: 'touch' | 'mouse'): void {
  const rect = root.value?.getBoundingClientRect()
  if (!rect || rect.width <= 0) return
  selectIndex(Math.floor((clientX - rect.left) / rect.width * points.value.length), mode)
}
function finePointer(event: PointerEvent): boolean {
  return (event.pointerType === 'mouse' || event.pointerType === 'pen')
    && Date.now() - lastTouchAt > 1000
    && window.matchMedia('(any-hover: hover) and (any-pointer: fine)').matches
}
function onPointerDown(event: PointerEvent): void {
  if (event.button !== 0) return
  // Prevent compatibility mouse focus/click effects without blocking pan-y scrolling.
  event.preventDefault()
  clearTimer()
  if (finePointer(event)) {
    selectAt(event.clientX, 'mouse')
    return
  }
  lastTouchAt = Date.now()
  selectAt(event.clientX, 'touch')
  pointerId.value = event.pointerId
  try { root.value?.setPointerCapture(event.pointerId) } catch { /* optional capture support */ }
}
function onPointerMove(event: PointerEvent): void {
  if (finePointer(event)) {
    selectAt(event.clientX, 'mouse')
    clearTimer()
  } else if (pointerId.value === event.pointerId) {
    selectAt(event.clientX, 'touch')
    clearTimer()
  }
}
function finishPointer(event: PointerEvent): void {
  if (pointerId.value !== event.pointerId) return
  releasePointer()
  holdSelection()
}
function leavePointer(event: PointerEvent): void {
  if (finePointer(event) && pointerId.value === null) clearSelection()
}
function onClick(event: MouseEvent): void {
  if (event.detail === 0 && Date.now() - lastTouchAt > 1000) {
    selectIndex(selectionIndex.value ?? points.value.length - 1, 'keyboard')
    holdSelection()
  }
}
function onKeydown(event: KeyboardEvent): void {
  const current = selectionIndex.value ?? points.value.length - 1
  let index = current
  switch (event.key) {
    case 'ArrowLeft': index = current - 1; break
    case 'ArrowRight': index = current + 1; break
    case 'Home': index = 0; break
    case 'End': index = points.value.length - 1; break
    case 'Enter': case ' ': break
    case 'Escape': event.preventDefault(); clearSelection(); return
    default: return
  }
  event.preventDefault()
  clearTimer()
  selectIndex(index, 'keyboard')
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
  return `${point.value.toFixed(1).replace(/\.0$/, '')}${props.metric === 'loss' ? '%' : ' ms'}`
}
const tooltipText = computed(() => {
  const point = selected.value
  if (!point) return ''
  const index = selectionIndex.value ?? 0
  const next = points.value[index + 1]
  const previous = points.value[index - 1]
  const step = next ? next.timestamp - point.timestamp : previous ? point.timestamp - previous.timestamp : 0
  const end = point.endTimestamp ?? (step > 0 ? point.timestamp + step : point.timestamp)
  const time = point.timestamp > 0 && Number.isFinite(point.timestamp)
    ? `${timeText(point.timestamp)} - ${timeText(end)} · ` : ''
  return `${time}${valueText(point)}`
})
function barStyle(point: GlassLatencySample, index: number): Record<string, string> {
  const numeric = typeof point.value === 'number' && Number.isFinite(point.value) && point.value >= 0
  const active = point.offline || numeric
  const picked = selectionIndex.value === index
  const dimmed = selectionIndex.value !== null && inputMode.value === 'mouse' && !picked
  const alpha = active ? '0.94' : props.metric === 'loss' ? '0.42' : '0.55'
  // One state drives color emphasis, opacity, transform and the tooltip. No :hover latch.
  return {
    background: point.offline ? lossTone(100) : numeric
      ? (props.metric === 'loss' ? lossTone(point.value as number) : latencyTone(point.value as number)) : PROBE_GAP_COLOR,
    height: active || props.metric === 'loss' ? PROBE_BAR_ACTIVE_HEIGHT : PROBE_BAR_LATENCY_GAP_HEIGHT,
    opacity: picked ? '1' : dimmed ? '0.54' : alpha,
    transform: picked ? 'scaleY(1.55)' : 'none',
    filter: picked ? 'saturate(1.14) brightness(1.04)' : 'none',
  }
}
async function positionBubble(): Promise<void> {
  await nextTick()
  const element = root.value
  const tip = bubble.value
  if (!element || !tip || !selected.value || selectionIndex.value === null) return
  const rect = element.getBoundingClientRect()
  const viewport = window.visualViewport
  const viewportLeft = viewport?.offsetLeft ?? 0
  const viewportTop = viewport?.offsetTop ?? 0
  const viewportRight = viewportLeft + (viewport?.width ?? document.documentElement.clientWidth)
  const viewportBottom = viewportTop + (viewport?.height ?? window.innerHeight)
  const card = element.closest('.node-card')?.getBoundingClientRect()
  const leftEdge = Math.max(viewportLeft, card?.left ?? viewportLeft)
  const rightEdge = Math.min(viewportRight, card?.right ?? viewportRight)
  tip.style.maxWidth = `${Math.max(1, rightEdge - leftEdge - 8)}px`
  const width = tip.offsetWidth
  const height = tip.offsetHeight
  const center = rect.left + (selectionIndex.value + 0.5) / points.value.length * rect.width
  const min = leftEdge + 4 + width / 2
  const max = rightEdge - 4 - width / 2
  const left = min <= max ? Math.min(Math.max(center, min), max) : center
  const above = rect.top - height - 6
  placement.value = above >= viewportTop + 4 ? 'above' : 'below'
  const preferredTop = placement.value === 'above' ? above : rect.bottom + 6
  const top = Math.max(viewportTop + 4, Math.min(preferredTop, viewportBottom - height - 4))
  bubbleStyle.value = {
    left: `${left}px`, top: `${top}px`,
    '--picker-arrow-x': `${Math.max(8, Math.min(width - 8, center - left + width / 2))}px`,
  }
}
function schedulePosition(): void {
  if (!selected.value || positionFrame !== null) return
  positionFrame = requestAnimationFrame(() => {
    positionFrame = null
    void positionBubble()
  })
}
watch(() => props.activeIndex, (index) => {
  if (index === null) resetLocal()
  else if (isOpen.value) void positionBubble()
})
watch(tooltipText, () => { if (selected.value) void positionBubble() })
onMounted(() => {
  if (typeof ResizeObserver !== 'undefined' && root.value) {
    observer = new ResizeObserver(schedulePosition)
    observer.observe(root.value)
  }
  window.addEventListener('scroll', schedulePosition, { capture: true, passive: true })
  window.addEventListener('resize', schedulePosition)
  window.visualViewport?.addEventListener('resize', schedulePosition)
  window.visualViewport?.addEventListener('scroll', schedulePosition)
})
onBeforeUnmount(() => {
  clearTimer()
  releasePointer()
  observer?.disconnect()
  if (positionFrame !== null) cancelAnimationFrame(positionFrame)
  window.removeEventListener('scroll', schedulePosition, true)
  window.removeEventListener('resize', schedulePosition)
  window.visualViewport?.removeEventListener('resize', schedulePosition)
  window.visualViewport?.removeEventListener('scroll', schedulePosition)
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
    @mousedown.stop.prevent
    @dblclick.stop
    @contextmenu.prevent.stop
    @keydown.stop="onKeydown"
    @blur="clearSelection"
    @pointerenter="onPointerMove"
    @pointerdown.stop="onPointerDown"
    @pointermove.stop="onPointerMove"
    @pointerup.stop="finishPointer"
    @pointercancel.stop="finishPointer"
    @lostpointercapture.stop="finishPointer"
    @pointerleave="leavePointer"
  >
    <span class="node-probe__bars probe-bar-picker__track" :style="{ gridTemplateColumns: `repeat(${points.length}, minmax(0, 1fr))` }">
      <span v-for="(point, index) in points" :key="index" class="probe-bar-picker__bar" :style="barStyle(point, index)" aria-hidden="true" />
    </span>
    <Teleport to="body">
      <span v-show="selected" :id="tooltipId" ref="bubble" class="probe-bar-picker__tooltip" :data-placement="placement" :style="bubbleStyle" role="status" :aria-hidden="!selected" aria-live="polite">
        {{ tooltipText }}
      </span>
    </Teleport>
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
.probe-bar-picker:focus-visible { outline: 2px solid var(--emerald); outline-offset: 2px; border-radius: 3px; }
.probe-bar-picker__tooltip {
  position: fixed;
  z-index: 200;
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
.probe-bar-picker__tooltip[data-placement='below']::after {
  top: auto;
  bottom: 100%;
  border-top-color: transparent;
  border-bottom-color: #18181b;
}
@media (hover: none), (pointer: coarse) {
  :global(.node-card:hover) {
    background: var(--node-card-surface, var(--card-surface));
    box-shadow: var(--node-card-shadow, var(--card-surface-shadow));
  }
  :global(.node-card) { -webkit-tap-highlight-color: transparent; }
}
@media (prefers-reduced-motion: reduce) {
  .probe-bar-picker__bar { transition: none; }
}
</style>
