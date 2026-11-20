from pathlib import Path
p = Path('src/components/dashboard/ServerCard.vue')
s = p.read_text()
s = s.replace("import ProbeHistoryDialog from '@/components/dashboard/ProbeHistoryDialog.vue'", "import ProbeBars from '@/components/dashboard/ProbeBars.vue'")
s = s.replace("import type { ProbeHistorySeries } from '@/domain/probe-history'\n", '')
for line in ['  PROBE_BAR_ACTIVE_HEIGHT,\n', '  PROBE_BAR_LATENCY_GAP_HEIGHT,\n', '  PROBE_EMPTY_COLOR,\n', '  PROBE_GAP_COLOR,\n']:
    s = s.replace(line, '')
a = s.index('const EMPTY_PING_BAR_COUNT = 20')
b = s.index('interface ProbeRow', a)
s = s[:a] + s[b:]
s = s.replace('  latencyBars: PingBar[]\n  lossBars: PingBar[]', '  latencyPoints: GlassLatencySample[]\n  lossPoints: GlassLatencySample[]')
s = s.replace("    latencyBars: buildBars(\n      'latency',\n      probeSeriesFor(props.server.history.latencySeries, probe.target),\n      latencyTone,\n    ),", "    latencyPoints: probeSeriesFor(props.server.history.latencySeries, probe.target),")
s = s.replace("    lossBars: buildBars(\n      'loss',\n      probeSeriesFor(props.server.history.packetLossSeries, probe.target),\n      lossTone,\n    ),", "    lossPoints: probeSeriesFor(props.server.history.packetLossSeries, probe.target),")
a = s.index("const activeMetric = ref<'latency' | 'loss' | null>(null)")
b = s.index('function probeTitle(', a)
s = s[:a] + '''const selectedProbe = ref<{ target: ProbeTarget; metric: 'latency' | 'loss'; index: number } | null>(null)

function selectProbe(target: ProbeTarget, metric: 'latency' | 'loss', index: number | null): void {
  if (index !== null) selectedProbe.value = { target, metric, index }
  else if (selectedProbe.value?.target === target && selectedProbe.value.metric === metric) selectedProbe.value = null
}

''' + s[b:]
a = s.index('/*\n * 一根柱子 = 一个时间桶')
b = s.index('function handleKeydown(', a)
s = s[:a] + s[b:]
a = s.index('      <div v-if="probeRows.length > 0" class="node-probes">')
b = s.index('      <div v-if="server.tags.length > 0"', a)
s = s[:a] + '''      <div v-if="probeRows.length > 0" class="node-probes">
        <div class="node-probe" @click.stop @keydown.stop>
          <div class="node-probe__head">
            <span>延迟</span>
            <span class="node-probe__hint">点柱子查看</span>
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
            <span class="node-probe__hint">点柱子查看</span>
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

''' + s[b:]
a = s.index('    <ProbeHistoryDialog\n')
b = s.index('    />', a) + len('    />\n')
s = s[:a] + s[b:]
s = s.replace('    </div>\n\n  </article>', '    </div>\n  </article>')
assert 'ProbeHistoryDialog' not in s and 'openProbeHistory' not in s and 'buildBars(' not in s
assert s.count('<ProbeBars') == 2
p.write_text(s)
p = Path('README.md')
s = p.read_text().replace('20 根柱子和点击打开曲线；列表同样显示三网。', '20 根柱子；点柱子就地显示该格时间范围与数值，手指滑动切换、松手后保留 2.5 秒，不再弹曲线卡片；列表同样显示三网。')
p.write_text(s)
