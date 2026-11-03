import type { GlassLatencySample } from '@/types/glassmorphism'

/** 节点卡「延迟 / 丢包」时间曲线弹窗里的一条线路。 */
export interface ProbeHistorySeries {
  key: string
  label: string
  color: string
  points: GlassLatencySample[]
  /** 图上图例显示的数值（窗口平均或最近一次上报）。 */
  valueText: string
}
