<script setup lang="ts">
import { computed } from 'vue'
import type { ChartRow } from '@/domain/server-detail'
import type { ProbeTarget } from '@/types/cfsm'

/**
 * Ping 图上方的丢包色带，照 LuminaPlus 的写法：
 * 每条线路一行，横轴与主图类目轴一一对应（每个历史行一格），
 * 0% 绿 → 20% 红；没有采样的时段留空，和「丢包 0%」区分开。
 */
const props = defineProps<{
  rows: readonly ChartRow[]
  tasks: readonly { target: ProbeTarget, label: string }[]
}>()

interface LossCell {
  key: string
  tone: string
}

function lossValue(row: ChartRow, target: ProbeTarget): number | null {
  const value = row.point?.packetLoss[target]
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(Math.max(value, 0), 100) : null
}

function lossTone(value: number | null): string {
  if (value === null) return 'is-gap'
  if (value <= 1) return 'is-signal-1'
  if (value <= 3) return 'is-signal-2'
  if (value <= 6) return 'is-signal-3'
  if (value <= 9) return 'is-signal-4'
  return 'is-signal-5'
}

const bands = computed(() => props.tasks.map((task) => ({
  key: task.target,
  label: task.label,
  cells: props.rows.map((row, index): LossCell => ({
    key: `${task.target}-${index}`,
    tone: lossTone(lossValue(row, task.target)),
  })),
})))

const gridStyle = computed(() => ({
  gridTemplateColumns: `repeat(${Math.max(1, props.rows.length)}, minmax(0, 1fr))`,
}))
</script>

<template>
  <div v-if="bands.length > 0" class="ping-loss-strip" aria-label="丢包色带">
    <div v-for="band in bands" :key="band.key" class="ping-loss-strip__row">
      <span class="ping-loss-strip__label" :title="band.label">{{ band.label }}</span>
      <span class="ping-loss-strip__band" :style="gridStyle">
        <i
          v-for="cell in band.cells"
          :key="cell.key"
          :class="cell.tone"
          aria-hidden="true"
        />
      </span>
    </div>
  </div>
</template>

<style scoped>
.ping-loss-strip {
  display: flex;
  flex-direction: column;
  gap: 5px;
  margin-bottom: 8px;
  padding: 0 40px 0 72px;
}

.ping-loss-strip__row {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 8px;
}

.ping-loss-strip__label {
  overflow: hidden;
  width: 48px;
  flex: none;
  margin-left: -56px;
  color: var(--muted);
  font-size: 10px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ping-loss-strip__band {
  display: grid;
  height: 7px;
  flex: 1;
  gap: 0;
  overflow: hidden;
  border-radius: 999px;
  background: color-mix(in srgb, var(--muted) 12%, transparent);
}

.ping-loss-strip__band i {
  display: block;
  width: 100%;
  height: 100%;
}

.ping-loss-strip__band .is-signal-1 { background: var(--signal-1); }
.ping-loss-strip__band .is-signal-2 { background: var(--signal-2); }
.ping-loss-strip__band .is-signal-3 { background: var(--signal-3); }
.ping-loss-strip__band .is-signal-4 { background: var(--signal-4); }
.ping-loss-strip__band .is-signal-5 { background: var(--signal-5); }
.ping-loss-strip__band .is-gap { background: transparent; }
</style>
