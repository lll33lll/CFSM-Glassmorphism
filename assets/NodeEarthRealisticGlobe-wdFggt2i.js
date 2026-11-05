const __vite__mapDeps=(i,m=__vite__mapDeps,d=(m.f||(m.f=["assets/globe.gl-CvflqtnS.js","assets/three.module-CeUF6iFM.js"])))=>i.map(i=>d[i]);
import{e as re,b3 as oe,b4 as ie,z as ne,ag as le,w as s,l as v,I as f,J as _,k as u,Q as I,K as O,F as E,r as F,a as y,n as se,_ as j,b5 as ue,Y as ce}from"./index-Cmh6vBrI.js";import{E as de,a as me}from"./earth-water-Xr8eyJUG.js";import{u as ve}from"./useServerGeoClusters-DExEU9RI.js";import{k as fe}from"./issue-copy-CIFDb0wg.js";import"./config-readiness-DOyrR1M_.js";const pe={key:0,class:"earth-globe-status"},he={key:0,class:"earth-globe-status__item earth-globe-status__item--online"},ge={key:1,class:"earth-globe-status__item earth-globe-status__item--offline"},be=`
varying vec2 vEarthUv;
varying vec3 vEarthNormal;
varying vec3 vEarthPosition;

void main() {
  vEarthUv = uv;
  vEarthNormal = normalize(mat3(modelMatrix) * normal);
  vEarthPosition = (modelMatrix * vec4(position, 1.0)).xyz;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`,De=`
uniform sampler2D uDayMap;
uniform sampler2D uWaterMap;
uniform vec3 uSunDirection;
uniform float uWaterStrength;

varying vec2 vEarthUv;
varying vec3 vEarthNormal;
varying vec3 vEarthPosition;

void main() {
  vec3 normal = normalize(vEarthNormal);
  vec3 sun = normalize(uSunDirection);

  vec3 color = texture2D(uDayMap, vEarthUv).rgb;

  // 不再分白天黑夜：整颗球同处一套环境光下，阳光只负责很轻的明暗起伏，
  // 背光面也只是稍暗，不会出现半颗黑球和城市灯光。
  float diffuse = clamp(dot(normal, sun), 0.0, 1.0);
  color *= 0.72 + 0.40 * diffuse;

  // 海面镜面高光：earth-water 白色为海洋，陆地不反光。
  vec3 viewDir = normalize(cameraPosition - vEarthPosition);
  vec3 halfDir = normalize(sun + viewDir);
  float water = texture2D(uWaterMap, vEarthUv).r;
  float specular = pow(max(dot(normal, halfDir), 0.0), 52.0) * water;
  color += vec3(0.92, 0.96, 1.0) * specular * uWaterStrength;

  // 边缘光：给球体一圈很淡的蓝，深色主题下不至于糊成一团黑。
  float rim = pow(1.0 - clamp(dot(normal, viewDir), 0.0, 1.0), 3.0);
  color += vec3(0.32, 0.54, 0.86) * rim * 0.32;

  gl_FragColor = vec4(color, 1.0);
  #include <colorspace_fragment>
}
`,_e=re({__name:"NodeEarthRealisticGlobe",props:{servers:{},stopped:{type:Boolean},isDark:{type:Boolean}},setup(K){const o=K,S=[35.8617,104.1954],p=F(),n=F(),{width:w,height:k}=oe(p),X=ue(),Y=ie(p),h=y(()=>X.value==="visible"&&Y.value);let a=null,c=null;const g=[];let b=!1,R=!1;const{regionClusters:D,totalServers:J,onlineServers:A,offlineServers:C,clusterKey:Q}=ve(()=>o.servers),d=y(()=>D.value.map(e=>({id:e.id,lat:e.coord[0],lng:e.coord[1],code:e.code,servers:e.servers,onlineServers:e.onlineServers}))),x=y(()=>D.value.map(e=>({id:e.id,lat:e.coord[0],lng:e.coord[1],code:e.code})));function M(e){return e.onlineServers>0?o.isDark?"rgba(34, 211, 238, 1)":"rgba(2, 132, 199, 0.98)":o.isDark?"rgba(250, 204, 21, 0.92)":"rgba(202, 138, 4, 0.88)"}function Z(e){const t=e,i=document.createElement("div");i.className="earth-label",i.dataset.clusterId=t.id;const r=document.createElement("img");return r.className="earth-label-flag",r.src=fe(t.code),r.alt=t.code,r.addEventListener("error",()=>{r.style.visibility="hidden"}),i.appendChild(r),i}function L(){const e=w.value||n.value?.clientWidth||320,t=k.value||n.value?.clientHeight||e;return{width:e,height:t}}function P(){if(!a)return;const{width:e,height:t}=L();a.width(e).height(t)}function T(e=0){a?.pointOfView({lat:S[0],lng:S[1],altitude:1.95},e)}function m(){if(!a)return;const e=a.controls();e.autoRotate=h.value&&!o.stopped,e.autoRotateSpeed=1.6,e.enableDamping=!0,e.enableZoom=!1,e.enablePan=!1,e.rotateSpeed=.55}function q(e,t,i){const r=e?.uniforms[t];r&&(r.value=i)}function V(){a&&(q(c,"uWaterStrength",o.isDark?.55:.4),a.pointColor(M).ringColor(()=>o.isDark?"rgba(45, 212, 191, 0.34)":"rgba(14, 165, 233, 0.28)").atmosphereColor(o.isDark?"#7dd3fc":"#93c5fd").atmosphereAltitude(o.isDark?.13:.1))}function $(){a&&a.pointsData(d.value).ringsData(d.value).htmlElementsData(x.value)}function N(e,t,i){const r=new e.TextureLoader().load(t);return i&&(r.colorSpace=e.SRGBColorSpace),r.anisotropy=4,g.push(r),r}function ee(e){return new e.ShaderMaterial({uniforms:{uDayMap:{value:N(e,me,!0)},uWaterMap:{value:N(e,de,!1)},uSunDirection:{value:new e.Vector3(.62,.48,.62).normalize()},uWaterStrength:{value:.55}},vertexShader:be,fragmentShader:De})}async function te(){if(!(a||b||!n.value)){b=!0,await se();try{const[{default:e},t]=await Promise.all([j(()=>import("./globe.gl-CvflqtnS.js"),__vite__mapDeps([0,1])),j(()=>import("./three.module-CeUF6iFM.js").then(l=>l.dv),[])]);if(R||!n.value)return;const{width:i,height:r}=L();a=new e(n.value,{rendererConfig:{alpha:!0,antialias:!0}}).width(i).height(r).backgroundColor("rgba(0,0,0,0)").showAtmosphere(!0).pointsData(d.value).pointLat("lat").pointLng("lng").pointAltitude(.008).pointRadius(l=>l.onlineServers>0?.22:.13).pointColor(M).pointsMerge(!1).pointsTransitionDuration(500).ringsData(d.value).ringLat("lat").ringLng("lng").ringColor(()=>o.isDark?"rgba(45, 212, 191, 0.34)":"rgba(14, 165, 233, 0.28)").ringMaxRadius(1.4).ringPropagationSpeed(.8).ringRepeatPeriod(2400).htmlElementsData(x.value).htmlLat("lat").htmlLng("lng").htmlAltitude(.012).htmlElement(Z).htmlElementVisibilityModifier((l,B)=>{l.style.opacity=B?"1":"0",l.style.filter=B?"blur(0)":"blur(14px)"}).htmlTransitionDuration(500);const z=a.renderer();z.setClearColor(0,0),z.domElement.style.background="transparent";const G=ee(t);a.globeMaterial(G),c=G;const U=new t.DirectionalLight(16777215,o.isDark?.9:1);U.position.set(1.2,1.1,1.6);const W=new t.DirectionalLight(14412542,o.isDark?.62:.48);W.position.set(-1.2,.2,1.2);const H=new t.DirectionalLight(14742270,o.isDark?.52:.38);H.position.set(-1,-.8,-1.2),a.lights([new t.AmbientLight(16777215,o.isDark?1.85:1.45),U,W,H]),V(),m(),T(0),h.value||a.pauseAnimation()}finally{b=!1}}}function ae(){if(a){a.pauseAnimation(),c?.dispose();for(const e of g)e.dispose();g.length=0,c=null,a._destructor(),a=null,n.value&&n.value.replaceChildren()}}return ne(()=>{te()}),le(()=>{R=!0,ae()}),s([w,k],([e,t])=>{e<=0||t<=0||P()}),s(()=>D.value.map(Q).join(","),()=>{$()}),s(()=>o.isDark,()=>{V()}),s(()=>o.stopped,e=>{m(),e&&T(300)}),s(h,e=>{if(a){if(e){a.resumeAnimation(),m(),P();return}a.pauseAnimation(),m()}}),(e,t)=>(v(),f("div",{ref_key:"containerRef",ref:p,class:"earth-globe-frame"},[_("div",{ref_key:"globeHostRef",ref:n,class:"earth-globe-host"},null,512),u(J)>0?(v(),f("div",pe,[u(A)>0?(v(),f("span",he,[t[0]||(t[0]=_("i",{"aria-hidden":"true"},null,-1)),I(O(u(A)),1)])):E("",!0),u(C)>0?(v(),f("span",ge,[t[1]||(t[1]=_("i",{"aria-hidden":"true"},null,-1)),I(O(u(C)),1)])):E("",!0)])):E("",!0)],512))}}),Re=ce(_e,[["__scopeId","data-v-19fd3f29"]]);export{Re as default};
