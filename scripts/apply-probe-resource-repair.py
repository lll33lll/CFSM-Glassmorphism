from pathlib import Path
import subprocess

def edit(path, old, new, count=1):
    p = Path(path); s = p.read_text()
    assert s.count(old) == count, (path, old[:80], s.count(old))
    p.write_text(s.replace(old, new))

# Only actual sample timestamps may advance state; old replay frames are ignored.
edit('src/services/cfsm/adapters.ts', '  const input = sample.data\n  const normalized = normalizeServer', '''  const sampleTime = numberValue(sample.timestamp)
  const sampledAt = sampleTime !== null && sampleTime > 0
    ? (sampleTime < 1_000_000_000_000 ? sampleTime * 1000 : sampleTime) : receivedAt
  const previousTime = server.lastUpdated ?? server.timestamp
  const previousAt = previousTime === null ? 0
    : previousTime < 1_000_000_000_000 ? previousTime * 1000 : previousTime
  if (sampleTime !== null && previousAt <= receivedAt + 60_000 && sampledAt <= previousAt) return server
  const input = sample.data
  const normalized = normalizeServer''')
edit('src/services/cfsm/adapters.ts', '    lastUpdated: receivedAt,\n    timestamp: sample.timestamp ?? receivedAt,', '    lastUpdated: sampledAt,\n    timestamp: sampledAt,')

# Reconnect snapshots must not roll fresh live metrics back to cached probe values.
edit('src/stores/servers.ts', 'const FIVE_MINUTES_MS = 5 * 60 * 1000', '''const FIVE_MINUTES_MS = 5 * 60 * 1000

function preserveFreshMetrics(snapshot: CfsmServer, previous: CfsmServer | undefined, now: number): CfsmServer {
  if (!previous) return snapshot
  const before = timestampMilliseconds(previous.lastUpdated ?? previous.timestamp) ?? 0
  const after = timestampMilliseconds(snapshot.lastUpdated ?? snapshot.timestamp) ?? 0
  if (before <= after || before > now + 60_000) return snapshot
  const fields = ['cpu', 'load1', 'load5', 'load15', 'networkInSpeed', 'networkOutSpeed',
    'networkReceived', 'networkTransmitted', 'processes', 'tcpConnections', 'udpConnections',
    'latency', 'packetLoss', 'memoryTotal', 'memoryUsed', 'swapTotal', 'swapUsed',
    'diskTotal', 'diskUsed', 'diskIo', 'gpus', 'bootTime', 'lastUpdated', 'timestamp'] as const
  return { ...snapshot, ...Object.fromEntries(fields.map((field) => [field, previous[field]])) }
}''')
edit('src/stores/servers.ts', '              refreshed,\n            )', '''              preserveFreshMetrics(refreshed, previousByBase.get(collection.source.base)?.servers.find((item) => item.id === refreshed.id), Date.now()),
            )''')

# The plot clock is stable within each minute, like LuminaPlus.
edit('src/views/HomeView.vue', 'const probeClock = useTimestamp({ interval: 60_000 })', '''const probeClock = useTimestamp({ interval: 1_000 })
const probeMinute = computed(() => Math.floor(probeClock.value / 60_000) * 60_000)''')
edit('src/views/HomeView.vue', 'app.config, Math.max(probeClock.value, Date.now())', 'app.config, probeMinute.value')

# Version the old receive-time cache; read existing Lumina measurements on the same origin.
edit('src/services/cfsm/probe-live.ts', "const STORAGE_KEY = 'cfsm-glassmorphism:probe-live:v1'", "const STORAGE_KEY = 'cfsm-glassmorphism:probe-live:v2'\nconst LUMINA_STORAGE_KEY = 'cfsm-luminaplus:ping-live:v1'\nconst luminaSeeded = new Set<string>()")
edit('src/services/cfsm/probe-live.ts', '''    left.latency[target] === right.latency[target] && left.loss[target] === right.loss[target]''', '''    probeNumber(left.latency[target]) === probeNumber(right.latency[target])
      && probeNumber(left.loss[target]) === probeNumber(right.loss[target])''')
edit('src/services/cfsm/probe-live.ts', 'function persistNow(): void {', '''/** Read only: Lumina's own cache is never rewritten or cleared. */
function seedLuminaSamples(key: string): void {
  if (luminaSeeded.has(key) || typeof location === 'undefined') return
  const separator = key.indexOf(':')
  if (separator < 0) return
  try {
    if (decodeURIComponent(key.slice(0, separator)) !== location.origin) return
  } catch { return }
  luminaSeeded.add(key)
  const store = storage()
  if (!store) return
  try {
    const raw = store.getItem(LUMINA_STORAGE_KEY)
    if (!raw) return
    const data = JSON.parse(raw) as { nodes?: Record<string, unknown> }
    const entries = data.nodes?.[key.slice(separator + 1)]
    if (!Array.isArray(entries)) return
    const now = Date.now()
    const byTime = new Map<number, ProbeLiveValue>()
    for (const sample of samplesByServer.get(key) ?? EMPTY) if (isFresh(sample, now)) byTime.set(sample.time, sample)
    let added = 0
    for (const entry of entries) {
      const sample = fromPersisted(entry)
      if (!sample || !isFresh(sample, now) || !hasAnyValue(sample)) continue
      byTime.set(sample.time, sample)
      added += 1
    }
    if (!added) return
    samplesByServer.set(key, thinSamples([...byTime.values()].sort((a, b) => a.time - b.time)))
    revisionsByServer.set(key, (revisionsByServer.get(key) ?? 0) + 1)
    schedulePersist()
  } catch { /* absent or corrupt external cache: retain backend-window fallback */ }
}

function persistNow(): void {''')
edit('src/services/cfsm/probe-live.ts', '  hydrate()\n', '  hydrate()\n  seedLuminaSamples(key)\n', count=4)

# Normal aggregation cadence is not an outage. Keep explicit nulls and long gaps.
edit('src/domain/server-detail.ts', 'const GAP_FACTOR = 2', 'const GAP_FACTOR = 3')
edit('src/domain/server-detail.ts', 'export function buildChartRows(', '''export function resolveChartGapMs(timestamps: readonly number[], minimum = 0): number {
  const ordered = [...new Set(timestamps)].sort((a, b) => a - b)
  const gaps = ordered.slice(1).map((time, index) => time - ordered[index]!).filter((gap) => gap > 0).sort((a, b) => a - b)
  const normal = median(gaps)
  if (normal === null) return minimum
  const upper = Math.min(gaps[Math.floor((gaps.length - 1) * 0.9)] ?? normal, normal * 2)
  return Math.max(normal * GAP_FACTOR, upper * 2, minimum) + 1000
}

export function buildChartRows(''')
edit('src/domain/server-detail.ts', '  if (interval === null) return samples\n', '  if (interval === null) return samples\n  const gapLimit = resolveChartGapMs(samples.map((sample) => sample.timestamp))\n')
edit('src/domain/server-detail.ts', 'gap > interval * GAP_FACTOR', 'gap > gapLimit')
edit('src/domain/server-detail.ts', '  const rows: ChartRow[] = []\n  samples.forEach((sample, index) => {', '  const gapLimit = resolveChartGapMs(samples.map((sample) => sample.timestamp), gapMs * 2)\n  const rows: ChartRow[] = []\n  samples.forEach((sample, index) => {')
edit('src/domain/server-detail.ts', 'sample.timestamp - previous.timestamp > gapMs', 'sample.timestamp - previous.timestamp > gapLimit')

# Resource charts use real time coordinates; category axes hide unequal sample spacing.
edit('src/domain/detail-chart-options.ts', '    const items = (Array.isArray(params) ? params : [params]) as AxisTooltipItem[]', '''    const items = ((Array.isArray(params) ? params : [params]) as AxisTooltipItem[]).map((item) => {
      const value = (item as { value?: unknown }).value
      return { ...item, value: finite(Array.isArray(value) ? value[1] : value) }
    })''')
p = Path('src/domain/detail-chart-options.ts')
s = p.read_text()
s += '''

/** Preserve actual time spacing without manufacturing intermediate metric samples. */
function withTimeAxis<T extends { xAxis: ReturnType<typeof categoryAxis>; series: ReturnType<typeof line>[] }>(context: LoadChartContext, option: T) {
  const { xAxis, series, ...rest } = option
  return {
    ...rest,
    xAxis: {
      ...xAxis, type: 'time' as const,
      axisLabel: { ...xAxis.axisLabel, formatter: (value: number) => formatAxisTime(value, context.hours >= 24) },
    },
    series: series.map((item) => ({
      ...item, lineStyle: { ...item.lineStyle, type: 'solid' as const },
      data: item.data.map((value, index) => [context.rows[index]!.timestamp, value] as [number, Value]),
    })),
  }
}
'''
p.write_text(s)
node_code = r'''
const fs = require('node:fs'); const ts = require(process.cwd() + '/node_modules/typescript');
const path = 'src/domain/detail-chart-options.ts'; let text = fs.readFileSync(path, 'utf8');
const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
const names = new Set(['cpuChartOption','memoryChartOption','diskChartOption','networkChartOption','gpuChartOption','connectionsChartOption','processChartOption','diskIoChartOption']);
const edits = [];
for (const item of file.statements) {
  if (!ts.isFunctionDeclaration(item) || !item.name || !names.has(item.name.text)) continue;
  const ret = item.body.statements.find(ts.isReturnStatement);
  if (!ret || !ret.expression || !ts.isObjectLiteralExpression(ret.expression)) throw Error(item.name.text);
  const start = ret.expression.getStart(file), end = ret.expression.end;
  edits.push([start,end,'withTimeAxis(context, '+text.slice(start,end)+')']);
}
if (edits.length !== 8) throw Error('Expected 8 resource chart builders');
for (const [start,end,replacement] of edits.sort((a,b)=>b[0]-a[0])) text=text.slice(0,start)+replacement+text.slice(end);
fs.writeFileSync(path,text);
'''
Path('/tmp/cfsm-resource-time-axis.cjs').write_text(node_code)
subprocess.run(['node', '/tmp/cfsm-resource-time-axis.cjs'], check=True)

edit('src/stores/server-detail.ts', '    current = mergeRealtimeSample(current, sample, receivedAt)\n    const timestamp = normalizeTimestampMilliseconds(sample.timestamp) ?? receivedAt\n    nextPoints = appendLivePoint', '    const timestamp = normalizeTimestampMilliseconds(sample.timestamp) ?? receivedAt\n    const previous = normalizeTimestampMilliseconds(current.lastUpdated ?? current.timestamp) ?? 0\n    if (previous <= receivedAt + 60_000 && timestamp <= previous) continue\n    current = mergeRealtimeSample(current, sample, receivedAt)\n    nextPoints = appendLivePoint')

edit('src/services/cfsm/probe-live.ts', 'JSON.stringify({ v: 1, savedAt: now, nodes })', 'JSON.stringify({ v: 2, savedAt: now, nodes })')
