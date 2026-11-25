import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

// ------------------------------------------------------------------ helpers
const $ = (s, el = document) => el.querySelector(s);
const nf = new Intl.NumberFormat('zh-CN');
const SUP = '⁰¹²³⁴⁵⁶⁷⁸⁹';
const sup = e => String(e).replace('-', '⁻').split('').map(c => SUP[+c] ?? c).join('');
const isNum = n => n !== null && n !== undefined && !Number.isNaN(+n);
const fmtInt = n => isNum(n) ? nf.format(Math.round(n)) : '—';
const fmtSci = n => { if (!isNum(n)) return '—'; const a = Math.abs(n); if (a >= 1e5 || (a > 0 && a < 1e-2)) { const e = Math.floor(Math.log10(a)); return `${(n / 10 ** e).toFixed(2)}×10${sup(e)}`; } return a >= 100 ? nf.format(Math.round(n)) : String(+(+n).toFixed(2)); };
const fmt = (n, d = 3) => isNum(n) ? (+n).toFixed(d) : '—';
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const TIER_COLORS = { T0: '#886337', T1: '#437961', T2: '#527b93', T3: '#766889', T3b: '#925776', T3c: '#a76053' };

// ------------------------------------------------------------------ binary loaders (formats written by src/*.py)
const bufCache = new Map();
function getBuf(url) {
  if (!bufCache.has(url)) bufCache.set(url, fetch(url).then(async r => {
    if (!r.ok) throw new Error(`${url} HTTP ${r.status}`);
    const buf = await r.arrayBuffer(); const m = String.fromCharCode(...new Uint8Array(buf, 0, 4));
    if (m === 'NSM1' || m === 'NSN1' || m === 'NSE1') return buf;
    // published builds ship the same bytes as base64 text (.bin.txt)
    const bin = atob(new TextDecoder().decode(buf).trim()); const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out.buffer;
  }));
  return bufCache.get(url);
}
function header(buf, magic) {
  const m = String.fromCharCode(...new Uint8Array(buf, 0, 4));
  if (m !== magic) throw new Error(`bad magic ${m}, expected ${magic}`);
  const hl = new DataView(buf).getUint32(4, true);
  return { hdr: JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 8, hl))), off: 8 + hl };
}
async function loadMesh(url) {
  const buf = await getBuf(url); const { hdr, off } = header(buf, 'NSM1');
  const nv = hdr.n_vertices * 12, nfc = hdr.n_faces * 12;
  return { hdr, V: new Float32Array(buf.slice(off, off + nv)), F: new Uint32Array(buf.slice(off + nv, off + nv + nfc)) };
}
async function loadNodes(url) {
  const buf = await getBuf(url); const { hdr, off } = header(buf, 'NSN1'); const n = hdr.n; let o = off;
  const xyz = new Float32Array(buf.slice(o, o + n * 12)); o += n * 12;
  const mod = new Uint8Array(buf.slice(o, o + n)); o += n;
  const logw = new Float32Array(buf.slice(o, o + n * 4));
  return { hdr, xyz, mod, logw };
}
async function loadEdges(url) {
  const buf = await getBuf(url); const { hdr, off } = header(buf, 'NSE1'); const n = hdr.n; let o = off;
  const src = new Uint32Array(buf.slice(o, o + n * 4)); o += n * 4;
  const dst = new Uint32Array(buf.slice(o, o + n * 4)); o += n * 4;
  const wc = new Uint8Array(buf.slice(o, o + n));
  return { hdr, src, dst, wc };
}

// ------------------------------------------------------------------ scene
const stage = $('#stage'), canvas = $('#gl');
const stageExpand = $('#stageExpand');
const viewerSurroundings = document.querySelectorAll('.skip-link, .site-header, .viewer-intro, .rail, .panel, .site-footer');
let expandedInPage = false;
let changingFullscreen = false;

function syncExpandedView() {
  const expanded = expandedInPage || document.fullscreenElement === stage;
  stage.classList.toggle('stage-expanded', expandedInPage);
  document.documentElement.classList.toggle('viewer-expanded', expanded);
  for (const element of viewerSurroundings) element.inert = expanded;
  stageExpand.setAttribute('aria-expanded', String(expanded));
  stageExpand.textContent = expanded ? '退出全屏' : '全屏查看';
}

stageExpand.addEventListener('click', async () => {
  if (changingFullscreen) return;
  if (expandedInPage) {
    expandedInPage = false;
    syncExpandedView();
    return;
  }

  changingFullscreen = true;
  try {
    if (document.fullscreenElement === stage) {
      await document.exitFullscreen();
    } else if (document.fullscreenEnabled && typeof stage.requestFullscreen === 'function') {
      try {
        await stage.requestFullscreen();
      } catch {
        expandedInPage = true;
      }
    } else {
      expandedInPage = true;
    }
  } finally {
    changingFullscreen = false;
    syncExpandedView();
    stageExpand.focus({ preventScroll: true });
  }
});

document.addEventListener('fullscreenchange', syncExpandedView);
document.addEventListener('keydown', event => {
  if (event.key !== 'Escape' || !expandedInPage) return;
  expandedInPage = false;
  syncExpandedView();
  stageExpand.focus({ preventScroll: true });
});
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setClearColor(getComputedStyle(stage).getPropertyValue('--viewer-canvas').trim(), 1);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(42, 1, 1, 1e7);
const controls = new OrbitControls(camera, canvas); controls.enableDamping = true; controls.dampingFactor = 0.08;
scene.add(new THREE.HemisphereLight(0xcfd8ee, 0x0e1420, 1.1));
const keyLight = new THREE.DirectionalLight(0xffffff, 0.7); keyLight.position.set(1, 0.8, 0.6); scene.add(keyLight);
const world = new THREE.Group(); scene.add(world);
const pointMat = new THREE.ShaderMaterial({
  uniforms: { uSize: { value: 1 }, uScale: { value: 300 }, uAlpha: { value: 0.85 } },
  vertexShader: `attribute float psize; attribute float vis; varying vec3 vC; varying float vV; uniform float uSize; uniform float uScale;
    void main(){ vC = color; vV = vis; vec4 mv = modelViewMatrix * vec4(position, 1.0);
      gl_PointSize = clamp(uSize * psize * uScale / max(-mv.z, 1.0), 1.0, 42.0); gl_Position = projectionMatrix * mv; }`,
  fragmentShader: `varying vec3 vC; varying float vV; uniform float uAlpha;
    void main(){ if (vV < 0.5) discard; vec2 c = gl_PointCoord - 0.5; float d = length(c); if (d > 0.5) discard;
      float a = smoothstep(0.5, 0.18, d) * uAlpha; gl_FragColor = vec4(vC, a); }`,
  transparent: true, depthWrite: false, vertexColors: true });
const edgeMat = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.28, depthWrite: false });

const state = { data: null, tier: null, nodes: null, edges: null, modVis: [], show: { mesh: true, roi: false, nodes: true, edges: true }, forebrain: false, edgeCount: 30000,
  pointScale: 1, maxDim: 1000, objs: { points: null, edges: null, meshes: [], rois: [] }, roiLoaded: false, tab: 'stats',
  dynamic: null, dynamicStep: 0, dynamicPlaying: false, dynamicTimer: null, dynamicBaseSizes: null, dynamicBaseColors: null };

function resize() {
  const w = stage.clientWidth, h = stage.clientHeight; if (!w || !h) return;
  renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix();
  pointMat.uniforms.uScale.value = h / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)));
}
new ResizeObserver(resize).observe(stage); resize();
renderer.setAnimationLoop(() => { controls.update(); renderer.render(scene, camera); });

function frame(box, up) {
  const c = box.getCenter(new THREE.Vector3()); const size = box.getSize(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z) || 1000; state.maxDim = maxDim;
  const upV = new THREE.Vector3(...up).normalize(); camera.up.copy(upV);
  const tmp = Math.abs(upV.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
  const right = new THREE.Vector3().crossVectors(upV, tmp).normalize();
  const fwd = new THREE.Vector3().crossVectors(right, upV).normalize();
  const dist = maxDim * 1.45;
  camera.position.copy(c).addScaledVector(right, 0.8 * dist).addScaledVector(fwd, 0.6 * dist).addScaledVector(upV, 0.5 * dist);
  camera.near = maxDim / 300; camera.far = maxDim * 30; camera.updateProjectionMatrix();
  controls.target.copy(c); controls.update();
  pointMat.uniforms.uSize.value = maxDim * 0.0032 * state.pointScale;
}
function disposeObj(o) { if (!o) return; world.remove(o); o.geometry?.dispose(); if (o.material && o.material !== pointMat && o.material !== edgeMat) o.material.dispose(); }
function clearWorld() { const ob = state.objs; disposeObj(ob.points); ob.meshes.forEach(disposeObj); ob.rois.forEach(disposeObj); disposeObj(ob.edges); state.objs = { points: null, edges: null, meshes: [], rois: [] }; state.roiLoaded = false; state.dynamicBaseSizes = state.dynamicBaseColors = null; }

function buildPoints() {
  const t = state.tier, nodes = state.nodes, n = nodes.hdr.n;
  const col = new Float32Array(n * 3), size = new Float32Array(n), vis = new Float32Array(n).fill(1);
  const cols = t.modules.map(m => new THREE.Color(m.color)); const mmap = t.module_map;
  for (let i = 0; i < n; i++) { const c = cols[mmap[nodes.mod[i]] ?? 0] || cols[0]; col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b; size[i] = 0.55 + 0.45 * nodes.logw[i]; }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(nodes.xyz, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.setAttribute('psize', new THREE.BufferAttribute(size, 1));
  geo.setAttribute('vis', new THREE.BufferAttribute(vis, 1));
  const pts = new THREE.Points(geo, pointMat); pts.visible = state.show.nodes; world.add(pts); state.objs.points = pts;
  state.dynamicBaseSizes = size.slice(); state.dynamicBaseColors = col.slice();
}
function buildEdges() {
  disposeObj(state.objs.edges); state.objs.edges = null;
  const t = state.tier, nodes = state.nodes, e = state.edges; if (!e) return;
  const mmap = t.module_map, cols = t.modules.map(m => new THREE.Color(m.color)), vis = state.modVis, xyz = nodes.xyz;
  const pos = [], col = [];
  const nE = Math.min(e.hdr.n, state.edgeCount);
  for (let i = 0; i < nE; i++) {
    const s = e.src[i], d = e.dst[i]; const gs = mmap[nodes.mod[s]] ?? 0, gd = mmap[nodes.mod[d]] ?? 0;
    if (!vis[gs] || !vis[gd]) continue;
    const c = cols[gs]; const b = 0.45 + 0.55 * Math.min(e.wc[i], 7) / 7;
    pos.push(xyz[s * 3], xyz[s * 3 + 1], xyz[s * 3 + 2], xyz[d * 3], xyz[d * 3 + 1], xyz[d * 3 + 2]);
    col.push(c.r * b, c.g * b, c.b * b, c.r * b * 0.55, c.g * b * 0.55, c.b * b * 0.55);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
  geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(col), 3));
  const ls = new THREE.LineSegments(geo, edgeMat); ls.visible = state.show.edges; world.add(ls); state.objs.edges = ls;
}
function addMesh(m, spec, list) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(m.V, 3)); geo.setIndex(new THREE.BufferAttribute(m.F, 1)); geo.computeVertexNormals();
  const mat = new THREE.MeshPhongMaterial({ color: new THREE.Color(spec.color || '#8fb3e8'), transparent: true, opacity: spec.opacity ?? 0.1, side: THREE.DoubleSide, depthWrite: false, shininess: 20 });
  const mesh = new THREE.Mesh(geo, mat); if (spec.scale) mesh.scale.setScalar(spec.scale); mesh.renderOrder = -1;
  mesh.visible = list === 'rois' ? state.show.roi : state.show.mesh; world.add(mesh); state.objs[list].push(mesh); return mesh;
}
async function loadROIs(t) {
  if (state.roiLoaded || !t.roi?.length) return; state.roiLoaded = true;
  const tierId = t.id;
  await Promise.all(t.roi.map(r => loadMesh(r.file).then(m => { if (state.tier?.id !== tierId) return; addMesh(m, { color: r.centroid[2] > 400 ? '#437961' : '#527b93', opacity: 0.07 }, 'rois'); }).catch(e => console.warn(e))));
}
function applyModuleVisibility() {
  const pts = state.objs.points; if (pts) { const vis = pts.geometry.getAttribute('vis'); const mmap = state.tier.module_map, mod = state.nodes.mod; for (let i = 0; i < vis.count; i++) vis.array[i] = state.modVis[mmap[mod[i]] ?? 0] ? 1 : 0; vis.needsUpdate = true; }
  buildEdges();
}

// ------------------------------------------------------------------ tier switching
function setLoading(msg) { const el = $('#loading'); el.hidden = !msg; if (msg) el.textContent = msg; }
async function showTier(id) {
  const t = state.data.tiers.find(x => x.id === id); if (!t) return;
  stopDynamic();
  state.tier = t; renderRail(); renderHudTitle(t, ''); setLoading('载入网络数据…'); clearWorld();
  const useFB = state.forebrain && t.nodes_forebrain;
  state.nodes = state.edges = null;
  try {
    const [nodes, edges] = await Promise.all([loadNodes(useFB ? t.nodes_forebrain : t.nodes), loadEdges(useFB ? t.edges_forebrain : t.edges).catch(e => { console.warn(e); return null; })]);
    if (state.tier !== t) return;
    state.nodes = nodes; state.edges = edges; state.modVis = t.modules.map(() => true); buildPoints(); buildEdges();
  } catch (e) { console.warn(e); renderHudTitle(t, `该层级的网络数据尚未生成（${e.message}）`); }
  const meshPromises = (t.meshes || []).map(m => loadMesh(m.file).then(mm => { if (state.tier === t) return addMesh(mm, m, 'meshes'); }).catch(e => console.warn(e)));
  if (state.show.roi) loadROIs(t);
  let box = null;
  if (state.nodes) { box = new THREE.Box3(); const p = state.nodes.xyz; const v = new THREE.Vector3(); for (let i = 0; i < p.length; i += 3) { v.set(p[i], p[i + 1], p[i + 2]); box.expandByPoint(v); } }
  else { const ms = (await Promise.all(meshPromises)).filter(Boolean); if (state.tier !== t) return; box = new THREE.Box3(); ms.forEach(m => box.expandByObject(m)); }
  if (box && !box.isEmpty()) frame(box, t.up);
  try { renderControls(t); renderLegend(t); renderFrame(t); renderPanel(t); }
  finally { setLoading(null); }
}

// ------------------------------------------------------------------ UI: rail, hud, legend
function renderRail() {
  const d = state.data;
  $('#rail').innerHTML = `<h3>网络层级</h3><div class="tier-list">` + d.tiers.map(t => `<button class="tier ${t === state.tier ? 'on' : ''}" data-id="${t.id}" aria-pressed="${t === state.tier}">
      <div class="id">${t.id}</div><div class="nm">${esc(t.name)}</div>
      <div class="n">${fmtSci(t.N_true)} 神经元</div><span class="kind">${esc(t.kind)}</span></button>`).join('') +
    `</div><details class="scale-strip"><summary>真实尺度（脑长，对数）</summary>${scaleStrip(d.tiers)}</details>`;
  $('#rail').querySelectorAll('.tier').forEach(b => b.addEventListener('click', () => showTier(b.dataset.id)));
}
function scaleStrip(tiers) {
  const W = 200, rowH = 18, lens = tiers.map(t => t.brain_length_mm), lmax = Math.log10(Math.max(...lens) * 1.3), lmin = Math.log10(0.5);
  const rows = tiers.map((t, i) => { const w = (Math.log10(t.brain_length_mm) - lmin) / (lmax - lmin) * (W - 62); const y = i * rowH;
    return `<rect x="0" y="${y + 4}" width="${w.toFixed(1)}" height="9" rx="2" fill="${TIER_COLORS[t.id]}" opacity=".85"/><text x="${(w + 5).toFixed(1)}" y="${y + 12}" font-size="9.5" fill="#536459" font-family="IBM Plex Mono,monospace">${t.id} ${t.brain_length_mm} mm</text>`; }).join('');
  return `<svg viewBox="0 0 ${W} ${tiers.length * rowH + 2}" role="img" aria-label="各层级脑长度对比">${rows}</svg>`;
}
function renderHudTitle(t, msg) {
  $('#hudTitle').innerHTML = `<div class="hud-title">${esc(t.name)}</div><div class="hud-sub">${esc(t.species)} · ${esc(t.kind)}</div>${msg ? `<div class="hud-msg">${esc(msg)}</div>` : ''}`;
}
function renderControls(t) {
  const hasFB = !!t.nodes_forebrain;
  $('#hudCtl').innerHTML = `<div class="ctl">
    <div class="row"><label><input type="checkbox" id="cMesh" ${state.show.mesh ? 'checked' : ''}> 脑区网格</label><label><input type="checkbox" id="cNodes" ${state.show.nodes ? 'checked' : ''}> 神经元</label><label><input type="checkbox" id="cEdges" ${state.show.edges ? 'checked' : ''}> 连接</label></div>
    ${t.roi?.length ? `<label><input type="checkbox" id="cRoi" ${state.show.roi ? 'checked' : ''}> ${t.roi.length} 个 ROI 网格</label>` : ''}
    ${hasFB ? `<label><input type="checkbox" id="cFB" ${state.forebrain ? 'checked' : ''}> 只看前脑子网（皮层系 + 基底节 + 丘脑）</label>` : ''}
    <div class="row"><span>点大小</span><input type="range" id="rSize" min="0.3" max="3" step="0.1" value="${state.pointScale}"></div>
    <div class="row"><span>连接不透明度</span><input type="range" id="rEdge" min="0.05" max="1" step="0.05" value="${edgeMat.opacity}"></div>
    <div class="row"><span>连接数量 <span id="nEdgeLbl">${fmtInt(state.edgeCount)}</span></span><input type="range" id="rCount" min="5000" max="250000" step="5000" value="${state.edgeCount}"></div>
    <div class="row"><button id="bReset" type="button">重置视角</button><span style="color:var(--ink3)">拖动旋转 · 滚轮缩放 · 右键平移</span></div></div>`;
  $('#cMesh').onchange = e => { state.show.mesh = e.target.checked; state.objs.meshes.forEach(m => m.visible = state.show.mesh); };
  $('#cNodes').onchange = e => { state.show.nodes = e.target.checked; if (state.objs.points) state.objs.points.visible = state.show.nodes; };
  $('#cEdges').onchange = e => { state.show.edges = e.target.checked; if (state.objs.edges) state.objs.edges.visible = state.show.edges; };
  const cr = $('#cRoi'); if (cr) cr.onchange = e => { state.show.roi = e.target.checked; state.objs.rois.forEach(m => m.visible = state.show.roi); if (state.show.roi) loadROIs(t); };
  const cf = $('#cFB'); if (cf) cf.onchange = e => { state.forebrain = e.target.checked; showTier(t.id); };
  $('#rSize').oninput = e => { state.pointScale = +e.target.value; pointMat.uniforms.uSize.value = state.maxDim * 0.0032 * state.pointScale; };
  $('#rEdge').oninput = e => { edgeMat.opacity = +e.target.value; };
  $('#rCount').oninput = e => { state.edgeCount = +e.target.value; $('#nEdgeLbl').textContent = fmtInt(state.edgeCount); };
  $('#rCount').onchange = () => buildEdges();
  $('#bReset').onclick = () => { if (state.objs.points) { const b = new THREE.Box3().setFromObject(state.objs.points); frame(b, t.up); } };
}
function renderLegend(t) {
  const sys = {}; t.modules.forEach((m, i) => { (sys[m.system] ||= []).push([m, i]); });
  const rows = Object.entries(sys).map(([s, ms]) => `<tr><td class="sys" colspan="3">${esc(s)}</td></tr>` + ms.map(([m, i]) => `<tr class="${state.modVis[i] ? '' : 'off'}">
      <td><label><input type="checkbox" data-i="${i}" ${state.modVis[i] ? 'checked' : ''}><span class="sw" style="background:${m.color}"></span>${esc(m.label)}</label></td>
      <td class="num">${fmtInt(m.count)}</td><td class="num" title="真实数量">${fmtSci(m.N_true)}</td></tr>`).join('')).join('');
  $('#hudLegend').innerHTML = `<div class="legend"><h3>模块 · 渲染数 / 真实数</h3><table>${rows}</table></div>`;
  $('#hudLegend').querySelectorAll('input').forEach(cb => cb.onchange = () => { state.modVis[+cb.dataset.i] = cb.checked; cb.closest('tr').classList.toggle('off', !cb.checked); applyModuleVisibility(); });
}
function renderFrame(t) {
  const n = state.nodes?.hdr.n; const fb = state.forebrain && t.nodes_forebrain ? '（前脑子网）' : '';
  const dyn = t.id === 'M1' && state.tab === 'dynamic' && state.dynamic ? `<br><span style="color:var(--good)">动态投影：step ${state.dynamic.full_run.trace[state.dynamicStep]?.step || 1}/100</span>（模块级聚合，不是逐神经元记录）` : '';
  $('#hudFrame').innerHTML = `<div class="frame">${esc(t.frame)}<br>渲染 ${fmtInt(n)} 个节点${fb}，${fmtInt(Math.min(state.edges?.hdr.n ?? 0, state.edgeCount))} / ${fmtInt(state.edges?.hdr.n)} 条连接（按突触数加权采样，胞体连线为抽象表示）<br>采样比 1 : ${fmtInt(t.sampling_ratio)}${dyn}</div>`;
}

// ------------------------------------------------------------------ panel
const METRICS = [
  ['平均出度 ⟨k⟩', 'k_mean', 1], ['出度变异系数', 'kout_cv', 2], ['互惠率', 'reciprocity', 3],
  ['聚类系数 C（全局）', 'clustering_global', 4], ['平均局部聚类', 'clustering_avg_local', 4],
  ['平均有向路径 L', 'path_len_directed', 2], ['平均无向路径', 'path_len_undirected', 2], ['有向可达比例', 'reach_frac_directed', 2],
  ['小世界指数 S', 'small_world_S', 0], ['模块度 Q（解剖模块）', 'Q_modules', 3], ['模块度 Q（Leiden）', 'Q_leiden', 3],
  ['Leiden 社区数', 'n_communities_leiden', 0], ['最大强连通分量占比', 'scc_largest_frac', 2], ['前 1% 枢纽承载的边', 'hub_top1pct_edge_share', 2]];
function tile(k, v, s, est) { return `<div class="tile ${est ? 'est' : ''}"><div class="k">${k}</div><div class="v">${v}</div><div class="s">${s}</div></div>`; }
function renderPanel(t) {
  const fly = state.data.tiers[0];
  const measured = t.measured ? '<span class="badge m">实测</span>' : '<span class="badge e">估算</span>';
  const tiles = tile('神经元', fmtSci(t.N_true), measured, !t.measured) + tile('有向连接', fmtSci(t.E_true), measured, !t.measured) +
    tile('突触', fmtSci(t.synapses), measured, !t.measured) + tile('每对连接的突触', fmt(t.syn_per_pair, 1), `平均 ${fmtInt(t.partners_mean)} 个下游伙伴`, !t.measured) +
    tile('突触事件 / 秒', fmtSci(t.compute.syn_events_per_s), '平均发放 1 Hz', true) + tile('等价算力', `${fmtSci(t.compute.flops)} FLOP/s`, t.compute.gpu_equiv >= 1 ? `≈ ${fmtSci(t.compute.gpu_equiv)} 块 RTX 5060 Ti` : `≈ 1/${fmtInt(1 / t.compute.gpu_equiv)} 块 RTX 5060 Ti`, true);
  let cols, note;
  if (t.id === 'T0') { cols = [['实测 w≥1', t.stats], ['实测 w≥5', t.stats_w5], ['生成对照', t.stats_control]]; note = '生成对照：同样的胞体位置、超类连接矩阵、指数距离核与对数正态度分布生成的网络，用来检验生成器能复现哪些真实结构。'; }
  else { cols = [['本层级', t.stats], ['前脑子网', t.stats_forebrain], ['果蝇实测', fly.stats]]; note = `同规模对照：与果蝇胞体子图相同的节点数（${fmtInt(t.stats?.N)}）与平均度，只改变架构。`; }
  const head = `<tr><th>指标</th>${cols.map(c => `<th>${c[0]}</th>`).join('')}</tr>`;
  const body = METRICS.map(([lab, key, d]) => `<tr><td>${lab}</td>${cols.map((c, ci) => `<td class="v ${ci === 0 ? 'hi' : ''}">${c[1] ? fmt(c[1][key], d) : '—'}</td>`).join('')}</tr>`).join('');
  $('#pane-stats').innerHTML = `<h3>真实尺度</h3><div class="tiles">${tiles}</div>${t.assumptions ? `<div class="note">${esc(t.assumptions)}</div>` : ''}
    <h3>同规模网络指标</h3><div class="note">${note}</div><table class="stats">${head}${body}</table>`;
  // notes
  const types = t.types ? `<div class="note">${fmtInt(t.types.n_types)} 个细胞类型；每型中位数 ${fmt(t.types.per_type_median, 0)} 个、均值 ${fmt(t.types.per_type_mean, 1)} 个。最大的类型：${Object.entries(t.types.top).slice(0, 6).map(([k, v]) => `${esc(k)} ${fmtInt(v)}`).join('，')}。</div>` : '';
  $('#pane-notes').innerHTML = `<h3>${esc(t.id)} 推演要点</h3><ul class="notes">${(t.notes || []).map(n => `<li>${esc(n)}</li>`).join('')}</ul>${types}` +
    (t.id === 'T0' ? '' : `<h3>相对果蝇的结构变化</h3><ul class="notes">${architectureNotes(t).map(n => `<li>${n}</li>`).join('')}</ul>`);
  renderDynamics(t);
  renderDist(t);
}
function architectureNotes(t) {
  const ctx = t.modules.filter(m => m.system === '皮层系').reduce((a, m) => a + m.N_true, 0) / t.N_true;
  const cb = t.modules.filter(m => m.system === '小脑').reduce((a, m) => a + m.N_true, 0) / t.N_true;
  const th = t.modules.find(m => m.role === 'th');
  const lamC = t.modules.find(m => m.role === 'cortex')?.lambda_per_mm;
  const flyLam = state.data.tiers.find(x => x.id === 'T0')?.edr?.lambda_per_mm;
  return [`皮层系占神经元总数的 ${(ctx * 100).toFixed(0)}%，小脑占 ${(cb * 100).toFixed(0)}%（果蝇：视叶 51%、中央脑内在 19%）。`,
    `丘脑枢纽 ${fmtSci(th?.N_true)} 个神经元，占 ${(th.N_true / t.N_true * 100).toFixed(2)}%，却按投射矩阵接收皮层 6% 的输出并把 75% 的输出送回皮层：极少数节点承担全局路由。`,
    `皮层长程连接的指数距离规则 λ = ${lamC}/mm（果蝇胞体层面拟合 ${flyLam == null ? '—' : fmt(flyLam, 1)}/mm），衰减长度 ${fmtInt(1000 / lamC)} µm。`];
}

// ------------------------------------------------------------------ full-scale dynamics
function dynamicPlot(title, cap, series, { includeZero = false, valueFmt = v => fmt(v, 4) } = {}) {
  const trace = state.dynamic.full_run.trace, W = 380, H = 104, L = 50, R = 8, T = 10, B = 20;
  const values = series.flatMap(s => s.values).filter(Number.isFinite);
  let lo = Math.min(...values), hi = Math.max(...values);
  if (includeZero) { lo = Math.min(0, lo); hi = Math.max(0, hi); }
  const pad = (hi - lo || Math.max(Math.abs(hi), 1)) * 0.08; lo -= pad; hi += pad;
  const X = i => L + i / Math.max(trace.length - 1, 1) * (W - L - R);
  const Y = v => T + (1 - (v - lo) / (hi - lo || 1)) * (H - T - B);
  const gridVals = [lo, (lo + hi) / 2, hi];
  const grid = gridVals.map(v => `<line class="grid" x1="${L}" x2="${W - R}" y1="${Y(v).toFixed(2)}" y2="${Y(v).toFixed(2)}"/><text class="axis" x="${L - 5}" y="${(Y(v) + 3).toFixed(2)}" text-anchor="end">${valueFmt(v)}</text>`).join('');
  const lines = series.map(s => `<polyline fill="none" stroke="${s.color}" stroke-width="${s.width || 1.8}" ${s.dash ? 'stroke-dasharray="4 3"' : ''} points="${s.values.map((v, i) => `${X(i).toFixed(2)},${Y(v).toFixed(2)}`).join(' ')}"/>`).join('');
  const legend = series.length > 1 ? `<div class="lg">${series.map(s => `<span style="--c:${s.color}">${esc(s.name)}</span>`).join('')}</div>` : '';
  return `<div class="dynamic-chart"><h4>${esc(title)}</h4><div class="cap">${esc(cap)}</div><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(title)}">
    ${grid}${includeZero ? `<line x1="${L}" x2="${W - R}" y1="${Y(0).toFixed(2)}" y2="${Y(0).toFixed(2)}" stroke="#586960"/>` : ''}${lines}
    <line class="cursor" data-dynamic-cursor x1="${L}" x2="${L}" y1="${T}" y2="${H - B}"/>
    <rect class="hit" data-dynamic-hit x="${L}" y="${T}" width="${W - L - R}" height="${H - T - B}"/>
    <text class="axis" x="${L}" y="${H - 4}">10 ms</text><text class="axis" x="${W - R}" y="${H - 4}" text-anchor="end">1,000 ms 模型时间</text></svg>${legend}</div>`;
}

function renderDynamics(t) {
  const pane = $('#pane-dynamic');
  if (t.id !== 'M1') {
    pane.innerHTML = `<div class="empty-dynamic">全量动态轨迹只对应 M1 小鼠级网络。<button id="toM1" type="button">切换到 M1</button></div>`;
    $('#toM1').onclick = async () => { selectTab('dynamic'); await showTier('M1'); };
    return;
  }
  const d = state.dynamic;
  if (!d?.full_run?.trace?.length) { pane.innerHTML = '<div class="empty-dynamic">动态结果未载入。</div>'; return; }
  const run = d.full_run, trace = run.trace, verify = d.verification, ladder = d.scale_ladder;
  const moduleOrder = run.interfaces.module_order;
  const moduleRows = moduleOrder.map((id, i) => {
    const m = t.modules.find(x => x.id === id) || { label: id, color: '#536459' };
    return `<div class="module-row" data-dynamic-module="${i}"><span class="name">${esc(m.label)}</span><div class="module-track"><div class="module-fill" style="width:0;background:${m.color}"></div></div><span class="rate">0.000%</span></div>`;
  }).join('');
  const gateRows = ladder.rows.map(r => `<tr><td>${r.nodes === run.graph.nodes ? '70M 全量' : fmtSci(r.nodes)}</td><td class="v">${fmtSci(r.nodes)}</td><td class="v">${fmtSci(r.edges_in_runtime)}</td><td class="v">${fmt(r.seconds_100_bins, 3)} s</td><td class="v">${fmt(r.peak_gpu_gib, 2)} GiB</td><td class="v pass">${r.passed ? '通过' : '未通过'}</td></tr>`).join('');
  pane.innerHTML = `<div class="dynamic-head"><div><h3>70M 全量动态运行</h3><div class="hud-sub">稀疏延迟 · 快慢双状态 · 100 × 10 ms</div></div><span class="dynamic-status ${run.runtime_gate_passed && verify.verification_passed ? '' : 'fail'}">${run.runtime_gate_passed && verify.verification_passed ? '运行与独立验证通过' : '存在未通过项'}</span></div>
    <p class="dynamic-summary">这里回放的是后端全量运行的真实聚合轨迹。左侧 3D 脑图只把每个脑区的活动率投影到采样节点，不伪装成 70M 个逐神经元轨迹。</p>
    <div class="dynamic-controls"><div class="row"><button id="dynamicPlay" type="button">播放</button><input id="dynamicStep" type="range" min="0" max="${trace.length - 1}" value="${state.dynamicStep}" aria-label="动态步数"><span class="dynamic-time" id="dynamicTime">—</span></div>
      <div class="dynamic-readout" aria-live="polite"><div class="cell"><div class="key">活跃神经元</div><div class="val" id="dynActive">—</div></div><div class="cell"><div class="key">活跃比例</div><div class="val" id="dynFraction">—</div></div><div class="cell"><div class="key">本步调度连接</div><div class="val" id="dynEdges">—</div></div><div class="cell"><div class="key">动作差值 L−R</div><div class="val" id="dynAction">—</div></div></div></div>
    ${dynamicPlot('全脑活跃比例', '每个 10 ms 时间箱中，绝对状态超过阈值的神经元比例。', [{ name: '活跃比例', color: '#437961', values: trace.map(r => r.active_neuron_fraction * 100) }], { valueFmt: v => v.toFixed(2) + '%' })}
    ${dynamicPlot('快状态与慢状态', '全量 70,999,999 个状态槽的平均绝对值。', [{ name: '快状态', color: '#527b93', values: trace.map(r => r.mean_abs_fast) }, { name: '慢状态', color: '#886337', values: trace.map(r => r.mean_abs_slow) }], { includeZero: true, valueFmt: v => v.toFixed(4) })}
    ${dynamicPlot('动作读出差值', '工程接口 action_left − action_right；不等同于已经学会行为。', [{ name: '动作差值', color: '#925776', values: trace.map(r => r.action_margin) }], { includeZero: true, valueFmt: v => v.toExponential(1) })}
    <h3>当前时间箱 · 各模块活跃源比例</h3><div class="note">按该模块的真实神经元数归一化；条形满刻度为 4%，3D 点亮强度使用同一组模块级比例。</div><div class="module-bars">${moduleRows}</div>
    <h3>规模阶梯</h3><table class="stats gate-table"><tr><th>门槛</th><th>神经元</th><th>运行内连接</th><th>100 箱耗时</th><th>GPU 峰值</th><th>状态</th></tr>${gateRows}</table>
    <h3>独立复核</h3><table class="stats"><tr><td>全量状态槽</td><td class="v">${fmtInt(run.graph.nodes)}</td></tr><tr><td>全图连接，无边界排除</td><td class="v">${fmtInt(run.graph.edges)}</td></tr><tr><td>fast / slow 检查点最大误差</td><td class="v">${verify.comparisons['fast.npy'].max_absolute_error} / ${verify.comparisons['slow.npy'].max_absolute_error}</td></tr><tr><td>delay queue 最大误差</td><td class="v">${fmtSci(verify.comparisons['delay_queue.npy'].max_absolute_error)}</td></tr><tr><td>峰值 GPU 已分配</td><td class="v">${fmt(run.execution.peak_gpu_allocated_gib, 2)} GiB</td></tr><tr><td>连续运行总耗时</td><td class="v">${fmt(run.execution.uninterrupted_seconds, 2)} s</td></tr></table>
    <div class="boundary"><strong>结论边界：</strong>当前证明的是 70M 神经元、28.27 亿连接的工程动态可运行性与检查点可复现性。生物权重/延迟、可塑性、学习行为和“小鼠级智能”仍未验证。</div>`;
  $('#dynamicPlay').onclick = toggleDynamic;
  $('#dynamicStep').oninput = e => { stopDynamic(); setDynamicStep(+e.target.value); };
  pane.querySelectorAll('[data-dynamic-hit]').forEach(hit => hit.addEventListener('pointerdown', e => {
    const box = e.currentTarget.getBoundingClientRect();
    const i = Math.round(Math.max(0, Math.min(1, (e.clientX - box.left) / box.width)) * (trace.length - 1));
    stopDynamic(); setDynamicStep(i);
  }));
  setDynamicStep(Math.min(state.dynamicStep, trace.length - 1));
}

function stopDynamic() {
  if (state.dynamicTimer) clearInterval(state.dynamicTimer);
  state.dynamicTimer = null; state.dynamicPlaying = false;
  const b = $('#dynamicPlay'); if (b) b.textContent = '播放';
}
function toggleDynamic() {
  if (state.dynamicPlaying) { stopDynamic(); return; }
  const trace = state.dynamic?.full_run?.trace || [];
  if (!trace.length) return;
  if (state.dynamicStep >= trace.length - 1) setDynamicStep(0);
  state.dynamicPlaying = true; $('#dynamicPlay').textContent = '暂停';
  const delay = matchMedia('(prefers-reduced-motion: reduce)').matches ? 320 : 140;
  state.dynamicTimer = setInterval(() => {
    if (state.dynamicStep >= trace.length - 1) { stopDynamic(); return; }
    setDynamicStep(state.dynamicStep + 1);
  }, delay);
}
function setDynamicStep(index) {
  const trace = state.dynamic?.full_run?.trace; if (!trace?.length) return;
  state.dynamicStep = Math.max(0, Math.min(trace.length - 1, index));
  const row = trace[state.dynamicStep], bin = state.dynamic.full_run.execution.time_bin_ms;
  const slider = $('#dynamicStep'); if (slider) slider.value = state.dynamicStep;
  const put = (id, value) => { const el = $(id); if (el) el.textContent = value; };
  put('#dynamicTime', `step ${row.step}/100 · ${fmtInt(row.step * bin)} ms`);
  put('#dynActive', fmtInt(row.active_neurons));
  put('#dynFraction', (row.active_neuron_fraction * 100).toFixed(3) + '%');
  put('#dynEdges', fmtInt(row.active_edges_dispatched));
  put('#dynAction', row.action_margin.toExponential(3));
  const x = 50 + state.dynamicStep / Math.max(trace.length - 1, 1) * (380 - 50 - 8);
  document.querySelectorAll('[data-dynamic-cursor]').forEach(line => { line.setAttribute('x1', x); line.setAttribute('x2', x); });
  const t = state.tier;
  if (t?.id === 'M1') {
    state.dynamic.full_run.interfaces.module_order.forEach((id, i) => {
      const m = t.modules.find(x => x.id === id), rate = m?.N_true ? row.module_active_sources[i] / m.N_true : 0;
      const el = paneModule(i); if (!el) return;
      el.querySelector('.module-fill').style.width = Math.min(100, rate * 100 / 0.04) + '%';
      el.querySelector('.rate').textContent = (rate * 100).toFixed(3) + '%';
    });
    if (state.tab === 'dynamic') { applyDynamicProjection(row); renderFrame(t); }
  }
}
function paneModule(i) { return $(`[data-dynamic-module="${i}"]`, $('#pane-dynamic')); }
function applyDynamicProjection(row) {
  const pts = state.objs.points, t = state.tier, nodes = state.nodes;
  if (!pts || !nodes || t?.id !== 'M1' || !state.dynamicBaseSizes || !state.dynamicBaseColors) return;
  const order = state.dynamic.full_run.interfaces.module_order;
  const rates = order.map((id, i) => { const m = t.modules.find(x => x.id === id); return m?.N_true ? row.module_active_sources[i] / m.N_true : 0; });
  const maxRate = Math.max(...rates, 1e-9), size = pts.geometry.getAttribute('psize'), color = pts.geometry.getAttribute('color'), mmap = t.module_map;
  for (let i = 0; i < size.count; i++) {
    const moduleIndex = mmap[nodes.mod[i]] ?? 0, intensity = Math.sqrt(Math.max(0, rates[moduleIndex] || 0) / maxRate), ci = i * 3;
    size.array[i] = state.dynamicBaseSizes[i] * (0.55 + 1.75 * intensity);
    const brightness = 0.24 + 0.9 * intensity;
    color.array[ci] = Math.min(1, state.dynamicBaseColors[ci] * brightness);
    color.array[ci + 1] = Math.min(1, state.dynamicBaseColors[ci + 1] * brightness);
    color.array[ci + 2] = Math.min(1, state.dynamicBaseColors[ci + 2] * brightness);
  }
  size.needsUpdate = color.needsUpdate = true;
}
function resetDynamicProjection() {
  const pts = state.objs.points; if (!pts || !state.dynamicBaseSizes || !state.dynamicBaseColors) return;
  pts.geometry.getAttribute('psize').array.set(state.dynamicBaseSizes);
  pts.geometry.getAttribute('color').array.set(state.dynamicBaseColors);
  pts.geometry.getAttribute('psize').needsUpdate = pts.geometry.getAttribute('color').needsUpdate = true;
}
function selectTab(name) {
  state.tab = name;
  $('#tabs .on')?.classList.remove('on');
  $(`#tabs [data-tab="${name}"]`)?.classList.add('on');
  $('#tabs').querySelectorAll('[role="tab"]').forEach(b => b.setAttribute('aria-selected', b.dataset.tab === name ? 'true' : 'false'));
  document.querySelectorAll('.pane').forEach(p => p.classList.toggle('on', p.id === 'pane-' + name));
  if (name === 'dynamic' && state.tier?.id === 'M1') setDynamicStep(state.dynamicStep); else { stopDynamic(); resetDynamicProjection(); }
}

// ------------------------------------------------------------------ charts (plain SVG)
const tip = $('#tip');
function showTip(ev, html) { tip.innerHTML = html; tip.hidden = false; tip.style.left = (ev.clientX + 12) + 'px'; tip.style.top = (ev.clientY + 12) + 'px'; }
function hideTip() { tip.hidden = true; }
function logTicks(lo, hi) { const t = []; for (let e = Math.floor(Math.log10(lo)); e <= Math.ceil(Math.log10(hi)); e++) t.push(10 ** e); return t.filter(v => v >= lo / 1.01 && v <= hi * 1.01); }
function lineChart(el, { title, cap, series, xlog = true, ylog = true, xlab, ylab, yfmt = v => fmt(v, 3), xfmt = v => fmtSci(v) }) {
  const W = 380, H = 230, L = 46, R = 10, T = 10, B = 34;
  const pts = series.flatMap(s => s.pts); if (!pts.length) { el.innerHTML = `<h4>${title}</h4><div class="cap">暂无数据</div>`; return; }
  const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
  const xmin = Math.min(...xs), xmax = Math.max(...xs), ymin = Math.min(...ys), ymax = Math.max(...ys);
  const X = v => L + (xlog ? (Math.log10(v) - Math.log10(xmin)) / (Math.log10(xmax) - Math.log10(xmin) || 1) : (v - xmin) / (xmax - xmin || 1)) * (W - L - R);
  const Y = v => T + (1 - (ylog ? (Math.log10(v) - Math.log10(ymin)) / (Math.log10(ymax) - Math.log10(ymin) || 1) : (v - ymin) / (ymax - ymin || 1))) * (H - T - B);
  const xt = xlog ? logTicks(xmin, xmax) : [xmin, (xmin + xmax) / 2, xmax];
  const yt = ylog ? logTicks(ymin, ymax) : [ymin, (ymin + ymax) / 2, ymax];
  const grid = yt.map(v => `<line x1="${L}" x2="${W - R}" y1="${Y(v).toFixed(1)}" y2="${Y(v).toFixed(1)}" stroke="#d5dccf" stroke-width="1"/><text x="${L - 6}" y="${(Y(v) + 3.5).toFixed(1)}" text-anchor="end" font-size="9.5" fill="#536459" font-family="IBM Plex Mono,monospace">${ylog ? '10' + sup(Math.round(Math.log10(v))) : yfmt(v)}</text>`).join('') +
    xt.map(v => `<text x="${X(v).toFixed(1)}" y="${H - B + 14}" text-anchor="middle" font-size="9.5" fill="#536459" font-family="IBM Plex Mono,monospace">${xlog ? '10' + sup(Math.round(Math.log10(v))) : xfmt(v)}</text>`).join('');
  const paths = series.map((s, si) => { const d = s.pts.map((p, i) => `${i ? 'L' : 'M'}${X(p[0]).toFixed(1)},${Y(p[1]).toFixed(1)}`).join('');
    const dots = s.pts.map(p => `<circle cx="${X(p[0]).toFixed(1)}" cy="${Y(p[1]).toFixed(1)}" r="2.6" fill="${s.color}" data-s="${si}" data-x="${p[0]}" data-y="${p[1]}"/>`).join('');
    return `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="${s.width || 1.8}" ${s.dash ? 'stroke-dasharray="4 3"' : ''} opacity=".9"/>${dots}`; }).join('');
  el.innerHTML = `<h4>${title}</h4><div class="cap">${cap || ''}</div><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${title}">
    <line x1="${L}" x2="${W - R}" y1="${H - B}" y2="${H - B}" stroke="#aab8ac"/><line x1="${L}" x2="${L}" y1="${T}" y2="${H - B}" stroke="#aab8ac"/>${grid}${paths}
    <text x="${W - R}" y="${H - 4}" text-anchor="end" font-size="9.5" fill="#586960">${xlab || ''}</text><text x="${L + 2}" y="${T + 9}" font-size="9.5" fill="#586960">${ylab || ''}</text></svg>
    <div class="lg">${series.map(s => `<span style="--c:${s.color}">${esc(s.name)}</span>`).join('')}</div>`;
  el.querySelectorAll('circle').forEach(c => { c.addEventListener('mousemove', ev => showTip(ev, `${esc(series[+c.dataset.s].name)}<br>${xlab || 'x'} = ${xfmt(+c.dataset.x)}<br>${ylab || 'y'} = ${yfmt(+c.dataset.y)}`)); c.addEventListener('mouseleave', hideTip); });
}
function histSeries(h, N) { if (!h || !h.edges?.length) return []; const out = []; for (let i = 0; i < h.counts.length; i++) { const c = h.counts[i]; if (c > 0) out.push([Math.sqrt(h.edges[i] * h.edges[i + 1]), c / N]); } return out; }
function barRows(el, { title, cap, labels, values, colors, vfmt }) {
  const vmax = Math.max(...values.filter(isNum), 1e-9), W = 380, rowH = 16, L = 118;
  const rows = labels.map((lab, i) => { const v = values[i]; const w = isNum(v) ? Math.max(v / vmax * (W - L - 60), 0) : 0; const y = i * rowH;
    return `<text x="${L - 6}" y="${y + 11.5}" text-anchor="end" font-size="10" fill="#536459">${esc(lab)}</text><rect x="${L}" y="${y + 3}" width="${w.toFixed(1)}" height="10" rx="2" fill="${colors[i]}" opacity=".9"/><text x="${(L + w + 5).toFixed(1)}" y="${y + 11.5}" font-size="10" fill="#26312b" font-family="IBM Plex Mono,monospace">${isNum(v) ? vfmt(v) : '—'}</text>`; }).join('');
  el.innerHTML = `<h4>${title}</h4><div class="cap">${cap || ''}</div><svg viewBox="0 0 ${W} ${labels.length * rowH + 2}" role="img" aria-label="${title}">${rows}</svg>`;
}
function renderDist(t) {
  const d = state.data, fly = d.tiers[0], pane = $('#pane-dist'); pane.innerHTML = '';
  const mk = () => { const el = document.createElement('div'); el.className = 'chart'; pane.appendChild(el); return el; };
  const cur = t.stats, ctrl = t.id === 'T0' ? t.stats_control : t.stats_forebrain;
  const ser = [];
  if (cur) ser.push({ name: t.id === 'T0' ? '果蝇实测' : `${t.id} ${t.name}`, color: TIER_COLORS[t.id], pts: histSeries(cur.hist_kout, cur.N) });
  if (ctrl) ser.push({ name: t.id === 'T0' ? '生成对照' : '前脑子网', color: t.id === 'T0' ? '#846145' : '#776788', dash: true, pts: histSeries(ctrl.hist_kout, ctrl.N) });
  if (t.id !== 'T0' && fly.stats) ser.push({ name: '果蝇实测', color: TIER_COLORS.T0, width: 1.2, pts: histSeries(fly.stats.hist_kout, fly.stats.N) });
  lineChart(mk(), { title: '出度分布', cap: '对数分箱；纵轴为落入该箱的节点占比。重尾表明少数枢纽神经元连接极多。', series: ser, xlab: '出度 k', ylab: '节点占比', yfmt: v => v.toExponential(2), xfmt: v => fmtInt(v) });
  const rc = []; const addRc = (name, color, st, dash) => { if (st?.rich_club?.length) rc.push({ name, color, dash, pts: st.rich_club.filter(r => r.phi > 0).map(r => [r.k, r.phi]) }); };
  if (t.id === 'T0') { addRc('果蝇实测', TIER_COLORS.T0, t.stats); addRc('生成对照', '#846145', t.stats_control, true); addRc('实测 w≥5', '#8a6a24', t.stats_w5, true); }
  else { addRc(`${t.id} ${t.name}`, TIER_COLORS[t.id], t.stats); addRc('前脑子网', '#776788', t.stats_forebrain, true); addRc('果蝇实测', TIER_COLORS.T0, fly.stats); }
  lineChart(mk(), { title: 'Rich-club 系数 φ(k)', cap: '度大于 k 的节点之间的连接密度。曲线上扬 = 枢纽之间彼此紧密相连（“富人俱乐部”）。', series: rc, xlab: '度阈值 k', ylab: 'φ(k)', ylog: false, yfmt: v => fmt(v, 3), xfmt: v => fmtInt(v) });
  if (cur?.path_hist_directed) { const ph = cur.path_hist_directed; const tot = ph.reduce((a, b) => a + b, 0) || 1; const labels = ph.map((_, i) => `${i} 步`).filter((_, i) => i > 0 && ph[i] > 0);
    barRows(mk(), { title: '有向最短路径分布', cap: `从 200 个随机源神经元出发，到达其他神经元所需的突触步数（平均 ${fmt(cur.path_len_directed, 2)} 步）。`, labels, values: ph.filter((v, i) => i > 0 && v > 0).map(v => v / tot), colors: labels.map(() => TIER_COLORS[t.id]), vfmt: v => (v * 100).toFixed(1) + '%' }); }
  if (t.id === 'T0' && d.edr_curve) { const c = d.edr_curve; const pts = c.x.map((x, i) => [x, c.rel_prob[i]]).filter(p => p[1] > 0 && p[0] >= 25 && p[0] <= 900);
    const lam = c.lambda_per_mm / 1000; const p0 = pts.find(p => p[0] >= 100) || pts[0]; const fitPts = pts.map(p => [p[0], p0[1] * Math.exp(-lam * (p[0] - p0[0]))]).filter(p => p[1] > 1e-4);
    lineChart(mk(), { title: '连接概率 vs 胞体距离', cap: `相对连接概率（目标距离分布 ÷ 随机对距离分布）；虚线为指数距离规则拟合 λ = ${fmt(c.lambda_per_mm, 1)}/mm。`, series: [{ name: '果蝇实测', color: TIER_COLORS.T0, pts }, { name: '指数拟合', color: '#846145', dash: true, pts: fitPts }], xlog: false, ylog: true, xlab: '胞体距离 µm', ylab: '相对概率', xfmt: v => fmtInt(v), yfmt: v => fmt(v, 3) }); }
  // cross-tier comparison
  const cmp = d.compare; if (cmp?.labels?.length) {
    const colors = cmp.labels.map(l => l.includes('前脑') ? '#776788' : l.includes('对照') ? '#846145' : (l.startsWith('T3c') ? TIER_COLORS.T3c : l.startsWith('T3b') ? TIER_COLORS.T3b : TIER_COLORS[l.slice(0, 2)]) || '#536459');
    const defs = [['clustering_global', '聚类系数 C', v => fmt(v, 4)], ['path_len_directed', '平均有向路径 L', v => fmt(v, 2)], ['small_world_S', '小世界指数 S', v => fmt(v, 0)],
      ['Q_modules', '模块度 Q（解剖模块）', v => fmt(v, 3)], ['hub_top1pct_edge_share', '前 1% 枢纽承载的边', v => (v * 100).toFixed(0) + '%'], ['reciprocity', '互惠率', v => fmt(v, 3)]];
    const h = document.createElement('h3'); h.textContent = '跨层级对比（同节点数、同平均度）'; pane.appendChild(h);
    defs.forEach(([k, lab, f]) => barRows(mk(), { title: lab, labels: cmp.labels, values: cmp.metrics[k] || [], colors, vfmt: f }));
  }
  renderScale(pane);
  renderLesion(pane);
}
const LESION_LABELS = { baseline: '完整网络', random_5pct: '随机切除 5%', random_20pct: '随机切除 20%', hubs_top1pct: '切除前 1% 枢纽', hubs_top5pct: '切除前 5% 枢纽', anatomical: '解剖性损毁' };
function renderLesion(pane) {
  const le = state.data.lesion; if (!le) return; const t = state.tier; const cur = le[t.id]; if (!cur) return;
  const h = document.createElement('h3'); h.textContent = '损毁实验（神经外科视角）'; pane.appendChild(h);
  const mk = () => { const el = document.createElement('div'); el.className = 'chart'; pane.appendChild(el); return el; };
  const conds = Object.keys(cur.conditions); const labels = conds.map(c => c === 'anatomical' ? `解剖性损毁（${cur.anatomical_label.split('（')[0]}）` : LESION_LABELS[c] || c);
  const colors = conds.map(c => c.startsWith('hubs') ? '#a84e51' : c === 'anatomical' ? '#a1623f' : c === 'baseline' ? TIER_COLORS[t.id] : '#536459');
  barRows(mk(), { title: '有向可达比例', cap: `切除后仍能从随机源到达的节点比例（完整网络 ${(cur.conditions.baseline.reach * 100).toFixed(1)}%）。切除枢纽与切除随机节点的差距就是网络对"关键结构"的依赖。`, labels, values: conds.map(c => cur.conditions[c].reach), colors, vfmt: v => (v * 100).toFixed(1) + '%' });
  barRows(mk(), { title: '平均有向路径（可达对）', cap: '切除后幸存通路的平均步数。', labels, values: conds.map(c => cur.conditions[c].L_dir), colors, vfmt: v => fmt(v, 2) });
  barRows(mk(), { title: '全局效率', cap: '可达对的 1/距离 之和除以对数；越高越好。', labels, values: conds.map(c => cur.conditions[c].efficiency), colors, vfmt: v => fmt(v, 4) });
  const tiers = Object.keys(le); const rows = tiers.map(k => { const b = le[k].conditions.baseline, a = le[k].conditions.anatomical, hb = le[k].conditions.hubs_top1pct; return `<tr><td>${k}</td><td class="v">${fmtInt(a.removed)}（${(a.removed_frac * 100).toFixed(1)}%）</td><td class="v">${(b.reach * 100).toFixed(1)}% → ${(a.reach * 100).toFixed(1)}%</td><td class="v">${fmt(b.L_dir, 2)} → ${fmt(a.L_dir, 2)}</td><td class="v">${(b.efficiency ? (a.efficiency / b.efficiency * 100).toFixed(0) : '—')}%</td><td class="v">${(hb.efficiency / b.efficiency * 100).toFixed(0)}%</td></tr>`; }).join('');
  const el = document.createElement('div'); el.innerHTML = `<h4 style="font-size:13px;font-weight:500;margin:4px 0">解剖性损毁的跨层级对比</h4><div class="note">果蝇：切除全部上行/下行神经元（脑与腹神经索之间的桥接，相当于颈髓横断）；哺乳类模型：切除整个丘脑模块。最后两列为损毁后全局效率占完整网络的百分比。</div><table class="stats"><tr><th>层级</th><th>切除节点</th><th>可达比例</th><th>有向路径</th><th>效率保留（解剖）</th><th>效率保留（前 1% 枢纽）</th></tr>${rows}</table>`; pane.appendChild(el);
}
function renderScale(pane) {
  const sc = state.data.scale; if (!sc?.runs?.length) return;
  const tier = 'T1'; const runs = sc.runs.filter(r => r.tier === tier).sort((a, b) => a.N - b.N); if (runs.length < 2) return;
  const fits = sc.fits?.[tier]?.fits, ex = sc.fits?.[tier]?.extrapolation_fixed_k;
  const h = document.createElement('h3'); h.textContent = '固定架构、改变规模（小鼠蓝图，⟨k⟩ = 166 不变）'; pane.appendChild(h);
  const mk = () => { const el = document.createElement('div'); el.className = 'chart'; pane.appendChild(el); return el; };
  const curve = key => { const f = fits?.[key]; if (!f) return []; const out = []; for (let e = Math.log10(runs[0].N); e <= 11.01; e += 0.25) { const N = 10 ** e; const v = f.form.startsWith('a +') ? f.a + f.b * Math.log(N) : Math.exp(f.a) * N ** f.b; if (v > 0) out.push([N, v]); } return out; };
  lineChart(mk(), { title: '聚类系数 C 随 N 的变化', cap: '点：生成网络实测；虚线：幂律拟合并外推到 10¹¹。固定平均度时，局域三角形随规模稀释。', series: [{ name: '生成网络', color: TIER_COLORS.T1, pts: runs.map(r => [r.N, r.clustering_global]) }, { name: '拟合外推', color: '#4fa37a', dash: true, pts: curve('clustering_global') }], xlab: 'N', ylab: 'C', yfmt: v => fmt(v, 4), xfmt: v => fmtSci(v) });
  lineChart(mk(), { title: '平均有向路径 L 随 N 的变化', cap: 'L ≈ a + b·ln N。固定 ⟨k⟩ = 166 时的上界；真实脑的 ⟨k⟩ 高 1–2 个数量级，L 会更短。', series: [{ name: '生成网络', color: TIER_COLORS.T1, pts: runs.map(r => [r.N, r.path_len_directed]) }, { name: '拟合外推', color: '#4fa37a', dash: true, pts: curve('path_len_directed') }], ylog: false, xlab: 'N', ylab: 'L', yfmt: v => fmt(v, 2), xfmt: v => fmtSci(v) });
  if (ex) {
    const rows = Object.entries(ex).map(([t, e]) => `<tr><td>${t}</td><td class="v">${fmtSci({ T0: 165122, T1: 7.1e7, T2: 8.6e10, T3: 4.84e11 }[t])}</td><td class="v">${fmt(e.clustering_global, 4)}</td><td class="v">${fmt(e.path_len_directed, 2)}</td><td class="v">${fmt(e.small_world_S, 0)}</td></tr>`).join('');
    const el = document.createElement('div'); el.innerHTML = `<h4 style="font-size:13px;font-weight:500;margin:4px 0">按拟合外推到真实神经元数（固定 ⟨k⟩ = 166）</h4><table class="stats"><tr><th>层级</th><th>N</th><th>C</th><th>L 有向</th><th>S</th></tr>${rows}</table>`; pane.appendChild(el);
  }
}

// ------------------------------------------------------------------ tabs & boot
$('#tabs').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; selectTab(b.dataset.tab); renderFrame(state.tier); });
(async function boot() {
  try {
    const [data, dynamic] = await Promise.all([
      fetch('data/tiers.json').then(r => { if (!r.ok) throw new Error(`tiers.json HTTP ${r.status}`); return r.json(); }),
      fetch('data/dynamics.json').then(r => { if (!r.ok) throw new Error(`dynamics.json HTTP ${r.status}`); return r.json(); })
    ]);
    state.data = data; state.dynamic = dynamic;
    $('#topMeta').textContent = `70M dynamics · ${dynamic.verification.verification_passed ? 'verified' : 'unverified'} · ${data.generated}`;
    await showTier('M1'); selectTab('dynamic'); renderFrame(state.tier);
  } catch (e) { console.error(e); setLoading(`数据载入失败：${e.message}`); }
})();
