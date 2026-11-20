<script setup lang="ts">
import { computed, ref } from 'vue'
import type { ProbeTarget } from '@/types/cfsm'
import type { GlassLatencySample, GlassServer } from '@/types/glassmorphism'
import type { NodeCardSize } from '@/theme/settings'
import AppIcon from '@/components/ui/AppIcon.vue'
import AppProgressThin from '@/components/ui/AppProgressThin.vue'
import ProbeBars from '@/components/dashboard/ProbeBars.vue'
import { resolveRegionCoordinates } from '@/domain/advanced-tools'
import { homepageProbes, probeSeriesFor, windowAverage, latestProbeLatency, homepageLatencyText, homepageLossText } from '@/domain/probe-window'
import {
  daysUntilExpiry,
  remainingValue,
  trafficDisplay,
  trafficDisplayPercent,
  trafficHeadText,
  trafficRatioText,
} from '@/domain/theme-presentation'
import { flagUrl, hideMissingFlag } from '@/utils/flags'
import { osDisplayName, osIconUrl } from '@/utils/os-icon'
import {
  formatCurrencyValue,
  formatDisplayBytes,
  formatDisplayMebibytes,
  formatDisplayPrice,
  formatDisplaySpeed,
  formatHomeUptimeDays,
  formatLoad,
  formatPercent,
  MISSING_TEXT,
  normalizeTimestampMilliseconds,
} from '@/utils/format'
import {
  latencyTone,
  lossTone,
} from '@/utils/probe-tone'
import { trafficStatus, trafficTextTone, usageStatus } from '@/utils/progress-status'

/**
 * 对齐 Komari `NodeCard` 的节点卡片。
 *
 * 区块顺序与上游一致：状态点 + 名称 / 收藏 + OS + 旗帜 / 运行与价格芯片 /
 * CPU·内存·硬盘·流量四项进度 / 网速·总流量·剩余或负载三列指标盒 /
 * 延迟与丢包双面板 / 自定义标签 / 离线遮罩。
 *
 * 数据全部来自既有 normalized model，不解析 wire payload，也不补造缺失值。
 */
const props = defineProps<{
  server: GlassServer
  showSource: boolean
  /** 卡片密度直接来自主题设置 `nodeCardSize`，与 Komari 的 NodeCard 一致。 */
  density: NodeCardSize
  favorite: boolean
  /** 主题级价格隐私（未登录隐藏价格）。每台节点自身的 showPrice 仍单独生效。 */
  priceVisible: boolean
}>()

const emit = defineEmits<{
  open: []
  toggleFavorite: []
}>()

const isMini = computed(() => props.density === 'mini')

function ratio(used: number | null, total: number | null): number | null {
  if (used === null || total === null || total <= 0) return null
  return Math.min(100, Math.max(0, (used / total) * 100))
}

const memoryPercent = computed(() => ratio(props.server.memory.used, props.server.memory.total))
const diskPercent = computed(() => ratio(props.server.disk.used, props.server.disk.total))
// 显示口径见 `trafficDisplay`：不限流量显示真实已用量，站点关闭流量展示时不呈现任何数值。
const trafficView = computed(() => trafficDisplay(props.server))
const trafficPercent = computed(() => trafficDisplayPercent(trafficView.value))
const trafficTone = computed(() => trafficTextTone(trafficPercent.value))
const trafficCritical = computed(() => trafficPercent.value !== null && trafficPercent.value >= 95)

/** 上游内存格挂 `Swap 已用 … / 总计 …` 的 title；CFSM 没有上报 Swap 时不挂，不写成 0。 */
const swapTooltip = computed(() => {
  const { used, total } = props.server.swap
  if (used === null) return undefined
  const usedText = formatDisplayMebibytes(Math.max(0, used))
  return total !== null && total > 0
    ? `Swap 已用 ${usedText} / 总计 ${formatDisplayMebibytes(total)}`
    : `Swap 已用 ${usedText}`
})

const osName = computed(() => osDisplayName(props.server.operatingSystem))
const regionCode = computed(() => resolveRegionCoordinates(props.server.region)?.code ?? null)

/** Komari NodeCard 的运行芯片只显示整天数（`在线 N 天`），不显示小时。 */
const uptimeText = computed(() => formatHomeUptimeDays(props.server.bootTime))
/**
 * 价格受两层控制：主题级 `hidePriceWhenLoggedOut` 与该节点自身的 `showPrice`。
 * 缺失或无法解析时返回占位符，此时不生成价格芯片，避免空标签。
 * 计费周期按 CFSM 官方枚举本地化；未知自由文本原样保留。
 */
const priceText = computed(() => {
  if (!props.priceVisible || !props.server.showPrice) return ''
  const text = formatDisplayPrice(props.server.price, props.server.currency, props.server.billingCycle)
  return text === MISSING_TEXT ? '' : text
})
const expireVisible = computed(() => props.server.showExpire && daysUntilExpiry(props.server.expireDate) !== null)
/*
 * 没有可显示到期日的付费节点：上游 NodeCard 仍画两行（`-` 与剩余价值），但它把未知到期的
 * 剩余价值算成 0，显示成「€0」。这里保留同样的两行结构，第二行如实为占位，不写成 0。
 */
const hasPublicPositivePrice = computed(() => {
  if (!props.priceVisible || !props.server.showPrice) return false
  const price = Number(props.server.price)
  return Number.isFinite(price) && price > 0
})
const expiryInfo = computed(() => {
  const days = daysUntilExpiry(props.server.expireDate)
  if (days === null) return { text: MISSING_TEXT, prefix: '', value: '', unit: '', tone: 'neutral' }
  if (days < 0) return { text: '已过期', prefix: '', value: '', unit: '', tone: 'danger' }
  if (days === 0) return { text: '今天到期', prefix: '', value: '', unit: '', tone: 'danger' }
  if (days > 36_500) return { text: '长期', prefix: '', value: '', unit: '', tone: 'neutral' }
  return {
    text: '',
    prefix: '剩余',
    value: String(days),
    unit: '天',
    tone: days <= 5 ? 'danger' : days <= 10 ? 'warning' : 'neutral',
  }
})
const expiryFullText = computed(() => {
  const info = expiryInfo.value
  return info.text || `${info.prefix} ${info.value} ${info.unit}`
})
const remainingValueText = computed(() => {
  if (!props.priceVisible || !props.server.showPrice) return ''
  const rawPrice = props.server.price?.trim()
  if (!rawPrice) return ''
  const price = Number(rawPrice)
  if (!Number.isFinite(price) || (price < 0 && price !== -1)) return ''
  if (price === 0 || price === -1) return '无'
  return formatCurrencyValue(remainingValue(props.server), props.server.currency)
})

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

/** 上游离线遮罩显示 `formatDateTime(node.time)`：`YYYY-MM-DD HH:mm:ss`，不带前缀。 */
const offlineText = computed(() => {
  const timestamp = normalizeTimestampMilliseconds(props.server.lastUpdated)
  if (timestamp === null) return '尚无上报'
  const date = new Date(timestamp)
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
})

const chips = computed(() => {
  const list: string[] = [uptimeText.value]
  if (priceText.value) list.push(priceText.value)
  if (props.showSource) list.push(props.server.sourceLabel)
  return list
})

/*
 * 延迟与丢包的柱子口径与 volcano-1025/CFSM-Theme-LuminaPlus 完全一致：
 * 柱子一律 84% 高，严重度只由颜色表达 —— 延迟是五档离散色阶，丢包是连续 HSL 热力渐变
 * （见 `utils/probe-tone`）。上游 Komari 那套 --signal-1..5 + 纹理不再使用，
 * 否则同一个 5% 丢包在两个主题里颜色对不上。
 *
 * 没有采样时：延迟是 25% 矮柱 + 55% 透明度，丢包是满高但 42% 透明度；
 * 整段都没有数据时渲染 20 根更淡的占位柱（与上游 EMPTY_PING_BAR_COUNT 一致），
 * 这样丢包为 0 时面板依然是一条完整的柱带，而不是一片空白。
 */
interface ProbeRow {
  key: ProbeTarget
  label: string
  latencyText: string
  lossText: string
  latencyTitle: string
  lossTitle: string
  latencyColor: string
  lossColor: string
  latencyPoints: GlassLatencySample[]
  lossPoints: GlassLatencySample[]
}

/*
 * 首页同时展示三网（电信 / 联通 / 移动）的延迟与丢包。
 *
 * 与 LuminaPlus v1.2.24 一致：延迟数字取最新成功探测，丢包数字按柱子的样本权重计算。
 * 丢包缺测显示 —，不回退到最新一次探测。每条线路各自一条柱带，
 * 柱带只画该线路自己的时间桶，`null` 原位保留为空洞柱。
 */
const probeRows = computed<ProbeRow[]>(() => homepageProbes(props.server.latency).map((probe) => {
  const lossWindow = windowAverage(props.server.history.packetLossSeries, probe.target)
  const latencyValue = latestProbeLatency(props.server.history, probe.target, probe.latency)
  const lossValue = lossWindow.value
  return {
    key: probe.target,
    label: probe.label,
    latencyText: homepageLatencyText(latencyValue),
    lossText: homepageLossText(lossValue),
    latencyTitle: `${probe.label}：最近一次有效延迟`,
    lossTitle: probeTitle(probe.label, '平均丢包', lossWindow.samples),
    latencyColor: typeof latencyValue === 'number' ? latencyTone(latencyValue) : '',
    lossColor: typeof lossValue === 'number' ? lossTone(lossValue) : '',
    latencyPoints: probeSeriesFor(props.server.history.latencySeries, probe.target),
    lossPoints: probeSeriesFor(props.server.history.packetLossSeries, probe.target),
  }
}))

const selectedProbe = ref<{ target: ProbeTarget; metric: 'latency' | 'loss'; index: number } | null>(null)

function selectProbe(target: ProbeTarget, metric: 'latency' | 'loss', index: number | null): void {
  if (index !== null) selectedProbe.value = { target, metric, index }
  else if (selectedProbe.value?.target === target && selectedProbe.value.metric === metric) selectedProbe.value = null
}

function probeTitle(label: string, metric: string, samples: number): string {
  return samples === 0
    ? `${label} ${metric}：暂无有效采样`
    : `${label} ${metric}：按柱带窗口内的样本时长加权计算`
}

function handleKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Enter' && event.key !== ' ') return
  event.preventDefault()
  emit('open')
}

function hideMissingImage(event: Event): void {
  const target = event.target
  if (target instanceof HTMLImageElement) target.style.display = 'none'
}
</script>

<template>
  <article
    class="node-card"
    :class="[
      `node-card--${density}`,
      { 'node-card--offline': !server.online },
    ]"
    role="button"
    tabindex="0"
    :aria-label="`查看节点 ${server.name} 详情`"
    @click="emit('open')"
    @keydown="handleKeydown"
  >
    <header class="node-card__header">
      <div class="node-card__identity">
        <span class="node-status-wrap" aria-hidden="true">
          <span
            class="node-status"
            :class="server.online ? 'node-status--online' : 'node-status--offline'"
          />
          <span
            class="node-status-pulse"
            :class="server.online ? 'node-status-pulse--online' : 'node-status-pulse--offline'"
          />
        </span>
        <span class="node-card__name" :title="server.name">{{ server.name }}</span>
      </div>
      <div class="node-card__header-extra">
        <button
          type="button"
          class="favorite-button"
          :class="{ 'is-favorite': favorite }"
          :aria-label="favorite ? `取消收藏 ${server.name}` : `收藏 ${server.name}`"
          :title="favorite ? '取消收藏' : '收藏节点'"
          @click.stop="emit('toggleFavorite')"
          @keydown.stop
        >
          <AppIcon :name="favorite ? 'tabler:star-filled' : 'tabler:star'" :size="14" />
        </button>
        <img
          class="node-card__os"
          :src="osIconUrl(server.operatingSystem)"
          :alt="osName"
          :title="server.operatingSystem ?? osName"
          @error="hideMissingImage"
        >
        <img
          v-if="regionCode"
          class="node-card__flag"
          :src="flagUrl(regionCode)"
          :alt="server.region ?? regionCode"
          :title="server.region ?? regionCode"
          @error="hideMissingFlag"
        >
      </div>
    </header>

    <div class="node-card__body">
      <div class="node-card__chips">
        <span v-for="chip in chips" :key="chip" class="node-chip">{{ chip }}</span>
      </div>

      <!--
        上游 mini 档的指标区是另一套结构（`grid-cols-[3fr_2fr]`）：左栏 CPU / 内存
        只放图标，内存用量占满左栏；右栏是带文字的流量。不是把四项挤进三列。
      -->
      <div v-if="isMini" class="node-metrics node-metrics--mini">
        <div class="node-metrics__pair">
          <div class="node-metric">
            <div class="node-metric__head">
              <span class="node-metric__label node-metric__label--cpu" role="img" title="CPU" aria-label="CPU">
                <AppIcon name="tabler:cpu" :size="12" />
              </span>
              <span class="node-metric__value">{{ formatPercent(server.cpu) }}</span>
            </div>
            <AppProgressThin :percentage="server.cpu" :status="usageStatus(server.cpu)" />
          </div>

          <div class="node-metric" :title="swapTooltip">
            <div class="node-metric__head">
              <span class="node-metric__label node-metric__label--memory" role="img" title="内存" aria-label="内存">
                <AppIcon name="icon-park-outline:memory" :size="12" />
              </span>
              <span class="node-metric__value">{{ formatPercent(memoryPercent) }}</span>
            </div>
            <AppProgressThin :percentage="memoryPercent" :status="usageStatus(memoryPercent)" />
          </div>

          <div class="node-metric__hint">
            {{ formatDisplayMebibytes(server.memory.used) }}
            /
            {{ formatDisplayMebibytes(server.memory.total) }}
          </div>
        </div>

        <div class="node-metric">
          <div class="node-metric__head">
            <span class="node-metric__label node-metric__label--traffic">
              <AppIcon name="tabler:arrows-transfer-up-down" :size="12" /><span>流量</span>
            </span>
            <span class="node-metric__value" :class="`node-metric__value--${trafficTone}`">
              {{ trafficHeadText(trafficView) }}
            </span>
          </div>
          <AppProgressThin :percentage="trafficPercent" :status="trafficStatus(trafficPercent)" />
          <div class="node-metric__hint" :class="{ 'node-metric__hint--danger': trafficCritical }">
            {{ trafficRatioText(trafficView) }}
          </div>
        </div>
      </div>

      <div v-else class="node-metrics">
        <div class="node-metric">
          <div class="node-metric__head">
            <span class="node-metric__label node-metric__label--cpu">
              <AppIcon name="tabler:cpu" :size="13" /><span>CPU</span>
            </span>
            <span class="node-metric__value">{{ formatPercent(server.cpu) }}</span>
          </div>
          <AppProgressThin :percentage="server.cpu" :status="usageStatus(server.cpu)" />
          <div class="node-metric__hint">
            {{ formatLoad(server.load.one) }}, {{ formatLoad(server.load.five) }}, {{ formatLoad(server.load.fifteen) }}
          </div>
        </div>

        <div class="node-metric" :title="swapTooltip">
          <div class="node-metric__head">
            <span class="node-metric__label node-metric__label--memory">
              <AppIcon name="icon-park-outline:memory" :size="13" /><span>内存</span>
            </span>
            <span class="node-metric__value">{{ formatPercent(memoryPercent) }}</span>
          </div>
          <AppProgressThin :percentage="memoryPercent" :status="usageStatus(memoryPercent)" />
          <div class="node-metric__hint">
            {{ formatDisplayMebibytes(server.memory.used) }}
            /
            {{ formatDisplayMebibytes(server.memory.total) }}
          </div>
        </div>

        <div class="node-metric">
          <div class="node-metric__head">
            <span class="node-metric__label node-metric__label--disk">
              <AppIcon name="tabler:server-2" :size="13" /><span>硬盘</span>
            </span>
            <span class="node-metric__value">{{ formatPercent(diskPercent) }}</span>
          </div>
          <AppProgressThin :percentage="diskPercent" :status="usageStatus(diskPercent)" />
          <div class="node-metric__hint">
            {{ formatDisplayMebibytes(server.disk.used) }}
            /
            {{ formatDisplayMebibytes(server.disk.total) }}
          </div>
        </div>

        <div class="node-metric">
          <div class="node-metric__head">
            <span class="node-metric__label node-metric__label--traffic">
              <AppIcon name="tabler:arrows-transfer-up-down" :size="13" /><span>流量</span>
            </span>
            <span class="node-metric__value" :class="`node-metric__value--${trafficTone}`">
              {{ trafficHeadText(trafficView) }}
            </span>
          </div>
          <AppProgressThin :percentage="trafficPercent" :status="trafficStatus(trafficPercent)" />
          <div class="node-metric__hint" :class="{ 'node-metric__hint--danger': trafficCritical }">
            {{ trafficRatioText(trafficView) }}
          </div>
        </div>
      </div>

      <div class="node-boxes">
        <div class="node-box">
          <span class="node-box__row node-box__row--up">
            <AppIcon name="tabler:chevron-up" :size="11" />
            <span class="node-box__text">{{ formatDisplaySpeed(server.network.outSpeed) }}</span>
          </span>
          <span class="node-box__row node-box__row--down">
            <AppIcon name="tabler:chevron-down" :size="11" />
            <span class="node-box__text">{{ formatDisplaySpeed(server.network.inSpeed) }}</span>
          </span>
        </div>
        <div class="node-box">
          <span class="node-box__row">
            <AppIcon name="tabler:upload" :size="11" />
            <span class="node-box__text">{{ formatDisplayBytes(server.network.transmitted) }}</span>
          </span>
          <span class="node-box__row">
            <AppIcon name="tabler:download" :size="11" />
            <span class="node-box__text">{{ formatDisplayBytes(server.network.received) }}</span>
          </span>
        </div>
        <div class="node-box">
          <template v-if="expireVisible">
            <!--
              上游这两行用的是 `gap-0.5`（2px），不是前两个盒子的 `gap-1`（4px）。
              三个间隙差 6px，在 303px 卡片上足以让「剩余 1653 天」被切掉。
              整行另挂原生 title，超出时至少还能读回完整值。
            -->
            <span
              class="node-box__row node-box__row--remaining"
              :class="`node-box__row--${expiryInfo.tone}`"
              :title="expiryFullText"
            >
              <AppIcon name="tabler:calendar-stats" :size="11" />
              <span v-if="expiryInfo.text" class="node-box__text">{{ expiryInfo.text }}</span>
              <template v-else>
                <span class="node-box__fixed-text">{{ expiryInfo.prefix }}</span>
                <span class="node-box__fixed-text node-box__number">{{ expiryInfo.value }}</span>
                <span class="node-box__fixed-text">{{ expiryInfo.unit }}</span>
              </template>
            </span>
            <span
              v-if="remainingValueText"
              class="node-box__row node-box__row--remaining"
              :title="remainingValueText"
            >
              <AppIcon name="tabler:coins" :size="11" />
              <span class="node-box__text">{{ remainingValueText }}</span>
            </span>
          </template>
          <template v-else-if="hasPublicPositivePrice">
            <span class="node-box__row node-box__row--remaining">
              <AppIcon name="tabler:calendar-stats" :size="11" />
              <span class="node-box__text">{{ MISSING_TEXT }}</span>
            </span>
            <span class="node-box__row node-box__row--remaining">
              <AppIcon name="tabler:coins" :size="11" />
              <span class="node-box__text">{{ MISSING_TEXT }}</span>
            </span>
          </template>
          <template v-else>
            <span class="node-box__row">
              <span class="node-box__text">{{ formatLoad(server.load.one) }}</span>
            </span>
            <span class="node-box__row">
              <span class="node-box__text">
                {{ formatLoad(server.load.five) }} / {{ formatLoad(server.load.fifteen) }}
              </span>
            </span>
          </template>
        </div>
      </div>

      <div v-if="probeRows.length > 0" class="node-probes">
        <div class="node-probe" @click.stop @keydown.stop>
          <div class="node-probe__head">
            <span>延迟</span>
          </div>
          <div v-for="row in probeRows" :key="row.key" class="node-probe__row">
            <div class="node-probe__row-head">
              <span class="node-probe__label">{{ row.label }}</span>
              <span class="node-probe__value" :title="row.latencyTitle" :style="row.latencyColor ? { color: row.latencyColor } : undefined">{{ row.latencyText }}</span>
            </div>
            <ProbeBars
              :points="row.latencyPoints"
              metric="latency"
              :label="row.label"
              :mini="isMini"
              :active-index="selectedProbe?.target === row.key && selectedProbe.metric === 'latency' ? selectedProbe.index : null"
              @select="selectProbe(row.key, 'latency', $event)"
            />
          </div>
        </div>
        <div class="node-probe" @click.stop @keydown.stop>
          <div class="node-probe__head">
            <span>丢包</span>
          </div>
          <div v-for="row in probeRows" :key="row.key" class="node-probe__row">
            <div class="node-probe__row-head">
              <span class="node-probe__label">{{ row.label }}</span>
              <span class="node-probe__value" :title="row.lossTitle" :style="row.lossColor ? { color: row.lossColor } : undefined">{{ row.lossText }}</span>
            </div>
            <ProbeBars
              :points="row.lossPoints"
              metric="loss"
              :label="row.label"
              :mini="isMini"
              :active-index="selectedProbe?.target === row.key && selectedProbe.metric === 'loss' ? selectedProbe.index : null"
              @select="selectProbe(row.key, 'loss', $event)"
            />
          </div>
        </div>
      </div>

      <div v-if="server.tags.length > 0" class="node-tags" aria-label="节点标签">
        <span v-for="tag in server.tags" :key="tag" class="node-tag">{{ tag }}</span>
      </div>

      <div v-if="!server.online" class="node-card__offline" aria-hidden="true">
        <strong>离线</strong>
        <span>{{ offlineText }}</span>
      </div>
    </div>
  </article>
</template>
