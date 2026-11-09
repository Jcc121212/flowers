import * as THREE from 'three';
import { Flower } from './flower.js';
import { HandTracker } from './hand.js';

/* ---------------- 基础环境 ---------------- */
const canvas = document.getElementById('scene');
const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
  alpha: true,
  powerPreference: 'high-performance',
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.setSize(window.innerWidth, window.innerHeight, false);

const scene = new THREE.Scene();
const CAM_Z = 5.2;
const camera = new THREE.PerspectiveCamera(42, window.innerWidth / window.innerHeight, 0.1, 60);
camera.position.set(0, 0, CAM_Z);
camera.lookAt(0, 0, 0);

const flower = new Flower(scene, renderer);

/* ---------------- 状态 ---------------- */
const state = {
  mode: 'idle',        // idle | camera | mouse
  bloom: 0,            // 当前绽放值 0~1
  target: 0.22,        // 目标绽放值
  intro: 0,            // 入场动画 0~1
  time: 0,
  hand: { present: false, x: 0.5, y: 0.5, openness: 0 },
  fingerWorld: new THREE.Vector3(99, 99, 0),
  prevFinger: new THREE.Vector3(99, 99, 0),
  fingerSpeed: 0,
  push: 0,
  lastHandSeen: -999,
  mouseDown: false,
  mouse: { x: 0.5, y: 0.5 },
};

/* ---------------- DOM ---------------- */
const gate = document.getElementById('gate');
const startBtn = document.getElementById('startBtn');
const mouseBtn = document.getElementById('mouseBtn');
const gateNote = document.getElementById('gateNote');
const statusEl = document.getElementById('status');
const statusText = document.getElementById('statusText');
const meterFill = document.getElementById('meterFill');
const meterValue = document.getElementById('meterValue');
const fingerInfo = document.getElementById('fingerInfo');
const meterEl = document.getElementById('meter');
const camCard = document.getElementById('camCard');
const hintEl = document.getElementById('hint');
const toastEl = document.getElementById('toast');

let toastTimer = 0;
function toast(msg, ms = 4200) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), ms);
}

let tracker = null;

/* ---------------- 交互：鼠标降级 ---------------- */
window.addEventListener('pointermove', (e) => {
  state.mouse.x = e.clientX / window.innerWidth;
  state.mouse.y = e.clientY / window.innerHeight;
  if (state.mode === 'mouse') {
    state.hand.present = true;
    state.hand.x = state.mouse.x;
    state.hand.y = state.mouse.y;
    state.lastHandSeen = state.time;
  }
});

window.addEventListener('pointerdown', (e) => {
  if (e.target.closest('button')) return;
  state.mouseDown = true;
});
window.addEventListener('pointerup', () => { state.mouseDown = false; });
window.addEventListener('pointercancel', () => { state.mouseDown = false; });
window.addEventListener('blur', () => { state.mouseDown = false; });

window.addEventListener('keydown', (e) => {
  if (e.code === 'Space') { e.preventDefault(); state.mouseDown = true; }
});
window.addEventListener('keyup', (e) => {
  if (e.code === 'Space') state.mouseDown = false;
});

/* ---------------- 启动流程 ---------------- */
function beginScene() {
  gate.classList.add('hide');
  setTimeout(() => { gate.style.display = 'none'; }, 950);
  state.intro = 0;
  state.introStart = performance.now();
}

startBtn.addEventListener('click', async () => {
  startBtn.disabled = true;
  startBtn.textContent = '正在唤醒…';
  gateNote.textContent = '加载手部识别模型 · 首次可能需要几秒';

  try {
    if (!tracker) tracker = new HandTracker(
      document.getElementById('video'),
      document.getElementById('skeleton')
    );
    await tracker.initMediaPipe();
    await tracker.startCamera();

    state.mode = 'camera';
    camCard.classList.add('on');
    meterEl.classList.add('on');
    statusEl.classList.add('live');
    hintEl.innerHTML = '<span class="k">握拳</span> 光笼收拢　<span class="sep">·</span>　<span class="k">张开手掌</span> 星芒绽放';
    beginScene();
  } catch (err) {
    console.error(err);
    startBtn.disabled = false;
    startBtn.textContent = '重试摄像头';
    gateNote.textContent = '摄像头或模型不可用，可先点「无摄像头体验」';
    toast('无法启动摄像头 / 模型：' + (err?.message || '未知错误') + '，已切换到鼠标模式');
    enterMouseMode();
  }
});

mouseBtn.addEventListener('click', () => enterMouseMode());

function enterMouseMode() {
  state.mode = 'mouse';
  meterEl.classList.add('on');
  statusEl.classList.add('live');
  statusText.textContent = '鼠标模式';
  hintEl.innerHTML = '移动鼠标牵引花朵　<span class="sep">·</span>　<span class="k">按住</span> 绽放　<span class="k">松开</span> 收拢';
  beginScene();
}

/* ---------------- 坐标换算 ---------------- */
function halfExtent() {
  const halfH = Math.tan(THREE.MathUtils.degToRad(camera.fov * 0.5)) * CAM_Z;
  return { halfH, halfW: halfH * camera.aspect };
}

const _world = new THREE.Vector3();

function normToWorld(nx, ny, out) {
  const { halfH, halfW } = halfExtent();
  return out.set((nx * 2 - 1) * halfW, (1 - ny * 2) * halfH, 0);
}

/* ---------------- 主循环 ---------------- */
let last = performance.now();

function frame(now) {
  requestAnimationFrame(frame);

  const dt = Math.min((now - last) / 1000, 0.05);
  last = now;
  state.time += dt;

  /* 1. 手部信号 */
  if (state.mode === 'camera' && tracker?.ready) {
    const m = tracker.update();
    state.hand.present = m.present;
    if (m.present) {
      state.hand.x = m.x;
      state.hand.y = m.y;
      state.hand.openness = m.openness;
      state.lastHandSeen = state.time;
    }
  }

  /* 2. 目标绽放值 */
  const sinceHand = state.time - state.lastHandSeen;
  if (state.mode === 'mouse') {
    state.target = state.mouseDown ? 1 : 0.16;
  } else if (state.mode === 'camera' && state.hand.present) {
    const o = state.hand.openness;
    // 张开度的轻微 S 曲线，让「半开」更有层次
    const curved = o * o * (3 - 2 * o) * 0.72 + o * 0.28;
    state.target = curved < 0.08 ? 0 : curved;
  } else {
    // 无手时轻轻呼吸，页面不会「死掉」
    state.target = 0.2 + Math.sin(state.time * 0.62) * 0.07;
  }

  /* 3. 平滑：爆开要干脆，收拢稍带阻尼 */
  const k = state.target > state.bloom ? 9.0 : 4.5;
  const ease = 1 - Math.exp(-dt * k);
  state.bloom += (state.target - state.bloom) * ease;
  state.bloom = Math.min(1, Math.max(0, state.bloom));

  /* 4. 指尖世界坐标 */
  if (state.hand.present || state.mode === 'mouse') {
    normToWorld(state.hand.x, state.hand.y, _world);
    _world.y = THREE.MathUtils.clamp(_world.y, -1.9, 1.9);
    const d = _world.distanceTo(state.prevFinger);
    const inst = dt > 0 ? d / dt : 0;
    state.fingerSpeed += (inst - state.fingerSpeed) * 0.35;
    if (state.prevFinger.x > 50) state.fingerWorld.lerp(_world, 1 - Math.exp(-dt * 18));
    else state.fingerWorld.copy(_world);
    state.prevFinger.copy(_world);
  } else {
    state.fingerSpeed *= 0.9;
    state.fingerWorld.set(99, 99, 0);
  }

  /* 5. 斥力强度：静止时是柔软的凹陷，快速划过时明显被拨动 */
  const speedNorm = Math.min(state.fingerSpeed / 2.2, 1);
  const wantPush = state.hand.present && state.mode !== 'idle'
    ? 0.05 + speedNorm * 0.16 + state.bloom * 0.03
    : 0;
  state.push += (wantPush - state.push) * (1 - Math.exp(-dt * 8));

  /* 6. 入场动画 */
  if (state.introStart) {
    const e = THREE.MathUtils.clamp((now - state.introStart) / 2100, 0, 1);
    state.intro = 1 - Math.pow(1 - e, 3);
  }

  /* 7. 花朵跟随（很轻的牵引感） */
  if (state.hand.present) {
    const followX = THREE.MathUtils.clamp(state.fingerWorld.x * 0.10, -0.5, 0.5);
    const followY = THREE.MathUtils.clamp(state.fingerWorld.y * 0.10, -0.4, 0.4);
    flower.group.position.x += (followX - flower.group.position.x) * (1 - Math.exp(-dt * 3));
    flower.group.position.y += (followY - flower.group.position.y) * (1 - Math.exp(-dt * 3));
  } else {
    flower.group.position.multiplyScalar(1 - Math.min(1, dt * 1.5));
  }

  /* 8. 更新花朵 */
  flower.update({
    time: state.time,
    bloom: state.bloom,
    intro: state.intro,
    fingerPush: state.push,
  });

  // 指尖换到花朵局部坐标系（花朵本身在缓慢自转）
  flower.group.updateMatrixWorld(true);
  if (state.fingerWorld.x < 50) {
    const local = flower.group.worldToLocal(state.fingerWorld.clone());
    flower.sparkUniforms.uFinger.value.copy(local);
  } else {
    flower.sparkUniforms.uFinger.value.set(0, 0, 40);
  }

  renderer.render(scene, camera);

  updateUI();
}

/* ---------------- UI ---------------- */
let lastUIValue = -1;
function updateUI() {
  const pct = Math.round(state.bloom * 100);
  if (pct !== lastUIValue) {
    lastUIValue = pct;
    meterFill.style.width = pct + '%';
    meterValue.textContent = pct + '%';
  }

  if (state.mode === 'idle') return;

  if (state.mode === 'mouse') {
    fingerInfo.textContent = state.mouseDown ? '按住 · 绽放中' : '松开 · 花苞';
    return;
  }

  if (!state.hand.present) {
    statusText.textContent = '寻找手部…';
    statusEl.classList.remove('live');
    fingerInfo.textContent = '把手放进画面里';
    return;
  }

  statusEl.classList.add('live');
  const o = state.hand.openness;
  if (o < 0.12) {
    statusText.textContent = '握拳 · 光笼闭合';
    fingerInfo.textContent = '张开度 ' + o.toFixed(2) + ' · 粒子收拢';
  } else if (o < 0.55) {
    statusText.textContent = '半开 · 蓄势中';
    fingerInfo.textContent = '张开度 ' + o.toFixed(2) + ' · 21 关键点';
  } else {
    statusText.textContent = '掌心张开 · 星芒绽放';
    fingerInfo.textContent = '张开度 ' + o.toFixed(2) + ' · 21 关键点';
  }
}

/* ---------------- 自适应 ---------------- */
function onResize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(w, h, false);
  flower.resize(renderer);
  if (tracker) tracker.syncCanvasSize();
}
window.addEventListener('resize', onResize);

/* ---------------- 启动 ---------------- */
onResize();
requestAnimationFrame(frame);

// 页面打开即有一朵「呼吸的花」，降低冷启动的空洞感
setTimeout(() => {
  if (state.mode === 'idle') {
    state.introStart = performance.now();
  }
}, 120);
