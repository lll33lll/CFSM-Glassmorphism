<script setup lang="ts">
import type { GlobeInstance } from 'globe.gl'
import type { Mesh, ShaderMaterial, Texture } from 'three'
import {
  useDocumentVisibility,
  useElementSize,
  useElementVisibility,
} from '@vueuse/core'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import EARTH_DAY_TEXTURE from '@/assets/earth/earth-blue-marble.jpg'
import EARTH_NIGHT_TEXTURE from '@/assets/earth/earth-night.jpg'
import EARTH_SPECULAR_MAP from '@/assets/earth/earth-water.png'
import EARTH_CLOUDS_TEXTURE from '@/assets/earth/earth-clouds'
import { useServerGeoClusters } from '@/composables/useServerGeoClusters'
import { flagUrl } from '@/utils/flags'
import type { GlassServer } from '@/types/glassmorphism'

const props = defineProps<{
  servers: readonly GlassServer[]
  stopped: boolean
  isDark: boolean
}>()

const CHINA_COORD: [number, number] = [35.8617, 104.1954]

const containerRef = ref<HTMLDivElement>()
const globeHostRef = ref<HTMLDivElement>()
const { width: containerWidth, height: containerHeight } = useElementSize(containerRef)

const documentVisibility = useDocumentVisibility()
const elementVisible = useElementVisibility(containerRef)
const shouldRender = computed(() => documentVisibility.value === 'visible' && elementVisible.value)

let globe: GlobeInstance | null = null
let globeMaterial: ShaderMaterial | null = null
let cloudMesh: Mesh | null = null
let cloudMaterial: ShaderMaterial | null = null
let cloudFrame: number | null = null
const loadedTextures: Texture[] = []
let loadingGlobe = false
let destroyed = false

/*
 * 贴图地球用「真实昼夜」着色：白天的蓝大理石贴图按太阳方向做漫反射，
 * 夜面用城市灯光贴图，再叠一层真实云层与海面高光。
 *
 * 旧实现把整张贴图交给 MeshPhongMaterial，并用 `emissive` 加蓝色底光：
 * 亮色模式下整颗星球被蓝灰色蒙版洗掉，暗色模式下又只剩一张几乎全黑的夜景图。
 * 这里改为自写着色器，颜色只来自真实贴图与白色阳光，不再给地球整体染色。
 */
const EARTH_VERTEX_SHADER = `
varying vec2 vEarthUv;
varying vec3 vEarthNormal;
varying vec3 vEarthPosition;

void main() {
  vEarthUv = uv;
  vEarthNormal = normalize(mat3(modelMatrix) * normal);
  vEarthPosition = (modelMatrix * vec4(position, 1.0)).xyz;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`

const EARTH_FRAGMENT_SHADER = `
uniform sampler2D uDayMap;
uniform sampler2D uNightMap;
uniform sampler2D uWaterMap;
uniform vec3 uSunDirection;
uniform float uNightIntensity;
uniform float uNightAmbient;
uniform float uWaterStrength;

varying vec2 vEarthUv;
varying vec3 vEarthNormal;
varying vec3 vEarthPosition;

void main() {
  vec3 normal = normalize(vEarthNormal);
  vec3 sun = normalize(uSunDirection);
  float sunAmount = dot(normal, sun);

  // 柔和的晨昏线，避免昼夜之间出现硬切边。
  float dayMix = smoothstep(-0.18, 0.18, sunAmount);

  vec3 dayColor = texture2D(uDayMap, vEarthUv).rgb;
  vec3 nightColor = texture2D(uNightMap, vEarthUv).rgb;

  // 白天：白色阳光 + 少量环境光；夜面：城市灯光 + 极弱的地表反照。
  float diffuse = clamp(sunAmount, 0.0, 1.0);
  vec3 dayLit = dayColor * (0.42 + 0.68 * diffuse);
  vec3 nightLit = nightColor * uNightIntensity + dayColor * uNightAmbient;
  vec3 color = mix(nightLit, dayLit, dayMix);

  // 海面镜面高光：earth-water 白色为海洋，陆地不反光。
  vec3 viewDir = normalize(cameraPosition - vEarthPosition);
  vec3 halfDir = normalize(sun + viewDir);
  float water = texture2D(uWaterMap, vEarthUv).r;
  float specular = pow(max(dot(normal, halfDir), 0.0), 64.0) * water;
  color += vec3(0.86, 0.93, 1.0) * specular * uWaterStrength * dayMix;

  gl_FragColor = vec4(color, 1.0);
  #include <colorspace_fragment>
}
`

const CLOUD_VERTEX_SHADER = `
varying vec2 vCloudUv;
varying vec3 vCloudNormal;

void main() {
  vCloudUv = uv;
  vCloudNormal = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`

const CLOUD_FRAGMENT_SHADER = `
uniform sampler2D uCloudMap;
uniform vec3 uSunDirection;
uniform float uCloudOpacity;
uniform float uNightAmbient;

varying vec2 vCloudUv;
varying vec3 vCloudNormal;

void main() {
  float alpha = texture2D(uCloudMap, vCloudUv).r * uCloudOpacity;
  if (alpha < 0.004) discard;

  float sunAmount = clamp(dot(normalize(vCloudNormal), normalize(uSunDirection)), 0.0, 1.0);
  float light = mix(uNightAmbient, 1.0, sunAmount);
  gl_FragColor = vec4(vec3(0.55 + 0.65 * light), alpha);
  #include <colorspace_fragment>
}
`

interface GlobePoint {
  id: string
  lat: number
  lng: number
  code: string
  servers: number
  onlineServers: number
}

interface GlobeLabel {
  id: string
  lat: number
  lng: number
  code: string
}

const {
  regionClusters,
  totalServers,
  onlineServers,
  offlineServers,
  clusterKey,
} = useServerGeoClusters(() => props.servers)

const pointsData = computed<GlobePoint[]>(() => regionClusters.value.map((cluster) => ({
  id: cluster.id,
  lat: cluster.coord[0],
  lng: cluster.coord[1],
  code: cluster.code,
  servers: cluster.servers,
  onlineServers: cluster.onlineServers,
})))

const labelsData = computed<GlobeLabel[]>(() => regionClusters.value.map((cluster) => ({
  id: cluster.id,
  lat: cluster.coord[0],
  lng: cluster.coord[1],
  code: cluster.code,
})))

function pointColor(point: object): string {
  const data = point as GlobePoint
  if (data.onlineServers > 0)
    return props.isDark ? 'rgba(34, 211, 238, 1)' : 'rgba(2, 132, 199, 0.98)'
  return props.isDark ? 'rgba(250, 204, 21, 0.92)' : 'rgba(202, 138, 4, 0.88)'
}

function createLabelElement(data: object): HTMLElement {
  const label = data as GlobeLabel
  const root = document.createElement('div')
  root.className = 'earth-label'
  root.dataset.clusterId = label.id

  const flag = document.createElement('img')
  flag.className = 'earth-label-flag'
  flag.src = flagUrl(label.code)
  flag.alt = label.code
  flag.addEventListener('error', () => {
    flag.style.visibility = 'hidden'
  })
  root.appendChild(flag)

  return root
}

function getRenderSize(): { width: number, height: number } {
  const width = containerWidth.value || globeHostRef.value?.clientWidth || 320
  const height = containerHeight.value || globeHostRef.value?.clientHeight || width
  return { width, height }
}

function resizeGlobe(): void {
  if (!globe) return
  const { width, height } = getRenderSize()
  globe.width(width).height(height)
}

function resetPointOfView(transitionMs = 0): void {
  globe?.pointOfView({ lat: CHINA_COORD[0], lng: CHINA_COORD[1], altitude: 1.95 }, transitionMs)
}

function applyControls(): void {
  if (!globe) return
  const controls = globe.controls()
  controls.autoRotate = shouldRender.value && !props.stopped
  controls.autoRotateSpeed = 1.6
  controls.enableDamping = true
  controls.enableZoom = false
  controls.enablePan = false
  controls.rotateSpeed = 0.55
}

function setUniform(material: ShaderMaterial | null, name: string, value: number): void {
  const uniform = material?.uniforms[name]
  if (uniform) uniform.value = value
}

function applyMaterialStyle(): void {
  if (!globe) return

  setUniform(globeMaterial, 'uNightIntensity', props.isDark ? 0.95 : 0.5)
  setUniform(globeMaterial, 'uNightAmbient', props.isDark ? 0.045 : 0.18)
  setUniform(globeMaterial, 'uWaterStrength', props.isDark ? 0.55 : 0.4)
  setUniform(cloudMaterial, 'uCloudOpacity', props.isDark ? 0.36 : 0.5)
  setUniform(cloudMaterial, 'uNightAmbient', props.isDark ? 0.04 : 0.2)

  globe
    .pointColor(pointColor)
    .ringColor(() => (props.isDark ? 'rgba(45, 212, 191, 0.34)' : 'rgba(14, 165, 233, 0.28)'))
    .atmosphereColor(props.isDark ? '#7dd3fc' : '#93c5fd')
    .atmosphereAltitude(props.isDark ? 0.13 : 0.1)
}

function syncDataToGlobe(): void {
  if (!globe) return
  globe
    .pointsData(pointsData.value)
    .ringsData(pointsData.value)
    .htmlElementsData(labelsData.value)
}

type ThreeModule = typeof import('three')

function loadTexture(THREE: ThreeModule, url: string, srgb: boolean): Texture {
  const texture = new THREE.TextureLoader().load(url)
  if (srgb) texture.colorSpace = THREE.SRGBColorSpace
  texture.anisotropy = 4
  loadedTextures.push(texture)
  return texture
}

function createEarthMaterial(THREE: ThreeModule): ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uDayMap: { value: loadTexture(THREE, EARTH_DAY_TEXTURE, true) },
      uNightMap: { value: loadTexture(THREE, EARTH_NIGHT_TEXTURE, true) },
      uWaterMap: { value: loadTexture(THREE, EARTH_SPECULAR_MAP, false) },
      uSunDirection: { value: new THREE.Vector3(-0.34, 0.52, 0.78).normalize() },
      uNightIntensity: { value: 1 },
      uNightAmbient: { value: 0.05 },
      uWaterStrength: { value: 0.55 },
    },
    vertexShader: EARTH_VERTEX_SHADER,
    fragmentShader: EARTH_FRAGMENT_SHADER,
  })
}

function createCloudLayer(THREE: ThreeModule, sunDirection: unknown): { mesh: Mesh, material: ShaderMaterial } {
  const material = new THREE.ShaderMaterial({
    uniforms: {
      uCloudMap: { value: loadTexture(THREE, EARTH_CLOUDS_TEXTURE, false) },
      uSunDirection: { value: sunDirection },
      uCloudOpacity: { value: 0.4 },
      uNightAmbient: { value: 0.05 },
    },
    vertexShader: CLOUD_VERTEX_SHADER,
    fragmentShader: CLOUD_FRAGMENT_SHADER,
    transparent: true,
    depthWrite: false,
    side: THREE.FrontSide,
  })

  // three-globe 的地球半径为 100，云层略高一点避免与地表共面。
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(100.45, 64, 64), material)
  // 与 three-globe 的默认球体保持一致：正对本初子午线，云图才会和地表贴图对齐。
  mesh.rotation.y = -Math.PI / 2
  mesh.renderOrder = 1
  return { mesh, material }
}

function cloudTick(): void {
  cloudFrame = null
  if (!cloudMesh || !shouldRender.value || props.stopped) return
  // 云层相对地表缓慢西移，速度约为地球自转的十分之一。
  cloudMesh.rotation.y += 0.00008
  cloudFrame = requestAnimationFrame(cloudTick)
}

function startCloudDrift(): void {
  if (cloudFrame !== null || props.stopped) return
  cloudFrame = requestAnimationFrame(cloudTick)
}

function stopCloudDrift(): void {
  if (cloudFrame === null) return
  cancelAnimationFrame(cloudFrame)
  cloudFrame = null
}

async function startGlobe(): Promise<void> {
  if (globe || loadingGlobe || !globeHostRef.value) return

  loadingGlobe = true
  await nextTick()

  try {
    const [{ default: Globe }, THREE] = await Promise.all([
      import('globe.gl'),
      import('three'),
    ])

    if (destroyed || !globeHostRef.value) return

    const { width, height } = getRenderSize()
    globe = new Globe(globeHostRef.value, {
      rendererConfig: { alpha: true, antialias: true },
    })
      .width(width)
      .height(height)
      .backgroundColor('rgba(0,0,0,0)')
      .showAtmosphere(true)
      .pointsData(pointsData.value)
      .pointLat('lat')
      .pointLng('lng')
      .pointAltitude(0.008)
      .pointRadius((point: object) => ((point as GlobePoint).onlineServers > 0 ? 0.22 : 0.13))
      .pointColor(pointColor)
      .pointsMerge(false)
      .pointsTransitionDuration(500)
      .ringsData(pointsData.value)
      .ringLat('lat')
      .ringLng('lng')
      .ringColor(() => (props.isDark ? 'rgba(45, 212, 191, 0.34)' : 'rgba(14, 165, 233, 0.28)'))
      .ringMaxRadius(1.4)
      .ringPropagationSpeed(0.8)
      .ringRepeatPeriod(2400)
      .htmlElementsData(labelsData.value)
      .htmlLat('lat')
      .htmlLng('lng')
      .htmlAltitude(0.012)
      .htmlElement(createLabelElement)
      .htmlElementVisibilityModifier((el: HTMLElement, isVisible: boolean) => {
        el.style.opacity = isVisible ? '1' : '0'
        el.style.filter = isVisible ? 'blur(0)' : 'blur(14px)'
      })
      .htmlTransitionDuration(500)

    const renderer = globe.renderer()
    renderer.setClearColor(0x000000, 0)
    renderer.domElement.style.background = 'transparent'

    const material = createEarthMaterial(THREE)
    globe.globeMaterial(material)
    globeMaterial = material

    const cloud = createCloudLayer(THREE, material.uniforms.uSunDirection?.value)
    globe.scene().add(cloud.mesh)
    cloudMesh = cloud.mesh
    cloudMaterial = cloud.material

    const frontLight = new THREE.DirectionalLight(0xFFFFFF, props.isDark ? 0.9 : 1.0)
    frontLight.position.set(1.2, 1.1, 1.6)
    const leftFill = new THREE.DirectionalLight(0xDBEAFE, props.isDark ? 0.62 : 0.48)
    leftFill.position.set(-1.2, 0.2, 1.2)
    const rearFill = new THREE.DirectionalLight(0xE0F2FE, props.isDark ? 0.52 : 0.38)
    rearFill.position.set(-1.0, -0.8, -1.2)
    globe.lights([
      new THREE.AmbientLight(0xFFFFFF, props.isDark ? 1.85 : 1.45),
      frontLight,
      leftFill,
      rearFill,
    ])

    applyMaterialStyle()
    applyControls()
    resetPointOfView(0)
    if (!shouldRender.value) globe.pauseAnimation()
    else startCloudDrift()
  } finally {
    loadingGlobe = false
  }
}

function stopGlobe(): void {
  if (!globe) return

  stopCloudDrift()
  globe.pauseAnimation()

  if (cloudMesh) globe.scene().remove(cloudMesh)
  cloudMesh?.geometry.dispose()
  cloudMaterial?.dispose()
  globeMaterial?.dispose()
  for (const texture of loadedTextures) texture.dispose()
  loadedTextures.length = 0
  cloudMesh = null
  cloudMaterial = null
  globeMaterial = null

  globe._destructor()
  globe = null
  if (globeHostRef.value) globeHostRef.value.replaceChildren()
}

onMounted(() => {
  void startGlobe()
})

onBeforeUnmount(() => {
  destroyed = true
  stopGlobe()
})

watch([containerWidth, containerHeight], ([width, height]) => {
  if (width <= 0 || height <= 0) return
  resizeGlobe()
})

watch(() => regionClusters.value.map(clusterKey).join(','), () => {
  syncDataToGlobe()
})

watch(() => props.isDark, () => {
  applyMaterialStyle()
})

watch(() => props.stopped, (stopped) => {
  applyControls()
  if (stopped) {
    resetPointOfView(300)
    stopCloudDrift()
    return
  }
  if (shouldRender.value) startCloudDrift()
})

watch(shouldRender, (visible) => {
  if (!globe) return
  if (visible) {
    globe.resumeAnimation()
    applyControls()
    resizeGlobe()
    startCloudDrift()
    return
  }
  globe.pauseAnimation()
  applyControls()
  stopCloudDrift()
})
</script>

<template>
  <div ref="containerRef" class="earth-globe-frame">
    <div ref="globeHostRef" class="earth-globe-host" />

    <div v-if="totalServers > 0" class="earth-globe-status">
      <span v-if="onlineServers > 0" class="earth-globe-status__item earth-globe-status__item--online">
        <i aria-hidden="true" />{{ onlineServers }}
      </span>
      <span v-if="offlineServers > 0" class="earth-globe-status__item earth-globe-status__item--offline">
        <i aria-hidden="true" />{{ offlineServers }}
      </span>
    </div>
  </div>
</template>

<style scoped>
.earth-globe-frame {
  position: relative;
  z-index: 0;
  aspect-ratio: 1 / 1;
  width: 100%;
  max-width: 28rem;
  margin-inline: auto;
  overflow: visible;
  transform: translateY(0.5rem);
  pointer-events: none;
}

@media (min-width: 768px) {
  .earth-globe-frame {
    transform: translateY(-0.25rem);
  }
}

.earth-globe-host {
  position: absolute;
  inset: 0;
  z-index: 0;
  width: 100%;
  height: 100%;
  transform: scale(1.06);
  contain: layout paint;
  background: transparent;
  cursor: grab;
  pointer-events: auto;
  touch-action: auto;
  user-select: none;
}

.earth-globe-host:active {
  cursor: grabbing;
}

.earth-globe-host :deep(canvas) {
  background: transparent !important;
  outline: none;
}

.earth-globe-host :deep(.scene-container) {
  background: transparent !important;
}

.earth-globe-host :deep(.earth-label) {
  pointer-events: none;
  position: relative;
  transform: translate(-50%, -118%);
  transition:
    opacity 500ms ease,
    filter 500ms ease;
  will-change: opacity, filter;
}

.earth-globe-host :deep(.earth-label-flag) {
  position: relative;
  z-index: 2;
  width: 1.2rem;
  height: 1.2rem;
  display: block;
  border-radius: 0.18rem;
  box-shadow: 0 8px 20px rgb(15 23 42 / 24%);
}

.earth-globe-status {
  position: absolute;
  top: 1.5rem;
  left: 0;
  display: flex;
  align-items: center;
  gap: 0.5rem;
  border-radius: 0.25rem;
  padding: 0.125rem 0.5rem;
  background: color-mix(in srgb, var(--glass) 60%, transparent);
  color: var(--muted);
  font-size: 10px;
  backdrop-filter: blur(16px);
  pointer-events: none;
}

@media (min-width: 768px) {
  .earth-globe-status {
    top: 3rem;
  }
}

.earth-globe-status__item {
  display: flex;
  align-items: center;
  gap: 0.25rem;
}

.earth-globe-status__item i {
  display: inline-block;
  width: 0.375rem;
  height: 0.375rem;
  border-radius: 999px;
  background: currentcolor;
  animation: earth-status-pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite;
}

.earth-globe-status__item--online {
  color: var(--emerald);
}

.earth-globe-status__item--offline {
  color: var(--amber);
}

@keyframes earth-status-pulse {
  50% {
    opacity: 0.5;
  }
}

@media (prefers-reduced-motion: reduce) {
  .earth-globe-status__item i {
    animation: none;
  }
}
</style>
