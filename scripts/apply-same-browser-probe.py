from pathlib import Path

def edit(path, old, new):
    p = Path(path); s = p.read_text()
    assert s.count(old) == 1, (path, old[:100], s.count(old))
    p.write_text(s.replace(old, new))

# A reference cache is an alternative baseline, not extra samples to add to our history.
edit('src/services/cfsm/probe-live.ts',
     '    for (const sample of samplesByServer.get(key) ?? EMPTY) if (isFresh(sample, now)) byTime.set(sample.time, sample)\n',
     '')
edit('src/services/cfsm/probe-live.ts',
     "/** Read only: Lumina's own cache is never rewritten or cleared. */",
     "/** Use fresh Lumina history as the cold-start baseline, without mixing our old cache. The reference cache stays read-only. */")
edit('src/services/cfsm/probe-live.ts',
     "import type { ProbeValues } from '@/types/cfsm'",
     "import type { LatencyWindowSample, ProbeValues } from '@/types/cfsm'")

# Lumina assigns weights only when the input changes, not on each repaint/minute tick.
p = Path('src/services/cfsm/probe-live.ts')
s = p.read_text() + '''

interface ProbeMeasurementClock {
  latency: readonly LatencyWindowSample[]
  loss: readonly LatencyWindowSample[]
  signature: string
  revision: number
  measuredAt: number
}
const measurementClocks = new Map<string, ProbeMeasurementClock>()

export function getProbeMeasurementTime(
  key: string,
  latency: readonly LatencyWindowSample[],
  loss: readonly LatencyWindowSample[],
): number {
  const revision = getProbeLiveRevision(key)
  const previous = measurementClocks.get(key)
  const signature = previous?.latency === latency && previous.loss === loss
    ? previous.signature : JSON.stringify([latency, loss])
  const measuredAt = previous?.revision === revision && previous.signature === signature
    ? previous.measuredAt : Date.now()
  measurementClocks.set(key, { latency, loss, signature, revision, measuredAt })
  return measuredAt
}
'''
p.write_text(s)

# A sample newer than the plot's minute boundary must still participate in merge/weights;
# buildPingBuckets alone decides whether it is visible yet, as in LuminaPlus.
edit('src/domain/probe-lumina.ts',
     '  windowMs?: number,\n): { latencyLatest:',
     '  windowMs?: number,\n  measuredAt = now,\n): { latencyLatest:')
edit('src/domain/probe-lumina.ts',
     'point.time > 0 && point.time <= now && now - point.time <= SAMPLE_TTL_MS',
     'point.time > 0 && measuredAt - point.time <= SAMPLE_TTL_MS')
edit('src/domain/probe-lumina.ts',
     'thinSamples(mergeWindowWithLocal(orderedWindow, orderedLocal, now))',
     'thinSamples(mergeWindowWithLocal(orderedWindow, orderedLocal, measuredAt))')
edit('src/domain/probe-buckets.ts',
     'options: { offlineSince?: number | null; windowMs?: number } = {},',
     'options: { offlineSince?: number | null; windowMs?: number; measuredAt?: number } = {},')
edit('src/domain/probe-buckets.ts',
     'buildHomepageProbeSeries([...byTime.values()], live, now, options.offlineSince, options.windowMs)',
     'buildHomepageProbeSeries([...byTime.values()], live, now, options.offlineSince, options.windowMs, options.measuredAt)')
edit('src/services/cfsm/glassmorphism-adapter.ts',
     'getProbeLiveSamples, getProbeLiveRevision, probeLiveKey',
     'getProbeLiveSamples, getProbeLiveRevision, getProbeMeasurementTime, probeLiveKey')
edit('src/services/cfsm/glassmorphism-adapter.ts',
     '        offlineSince: server.online ? null :',
     '        measuredAt: getProbeMeasurementTime(probeLiveKey(server.source.base, server.id), server.latencyWindow, server.packetLossWindow),\n        offlineSince: server.online ? null :')
edit('src/views/HomeView.vue',
     'const probeMinute = computed(() => Math.floor(probeClock.value / 60_000) * 60_000)',
     'const probeMinute = computed(() => Math.floor(probeClock.value / 60_000) * 60_000 + 25)')
