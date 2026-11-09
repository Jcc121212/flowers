/* =========================================================
   MediaPipe Hands 封装
   · 多 CDN 兜底加载（jsdelivr / fastly / unpkg）
   · 优先读取本地 model（assets/hand_landmarker.task），失败再走官方源
   · 输出：手掌位置（0~1，已做镜像）、张开度（0~1）、21 个关键点
   ========================================================= */

const VISION_CONST = '@mediapipe/tasks-vision@0.10.14';
const LOCAL_BASE = new URL('../vendor/mediapipe/', import.meta.url).href;

// 优先本地 vendor，失败再回退到公共 CDN
const SOURCES = [
  { bundle: LOCAL_BASE + 'vision_bundle.mjs', wasm: LOCAL_BASE + 'wasm' },
  { bundle: `https://cdn.jsdelivr.net/npm/${VISION_CONST}/vision_bundle.mjs`, wasm: `https://cdn.jsdelivr.net/npm/${VISION_CONST}/wasm` },
  { bundle: `https://fastly.jsdelivr.net/npm/${VISION_CONST}/vision_bundle.mjs`, wasm: `https://fastly.jsdelivr.net/npm/${VISION_CONST}/wasm` },
  { bundle: `https://unpkg.com/${VISION_CONST}/vision_bundle.mjs`, wasm: `https://unpkg.com/${VISION_CONST}/wasm` },
];

const MODEL_URLS = [
  './assets/hand_landmarker.task',
  'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
  'https://cdn.jsdelivr.net/gh/google-ai-edge/mediapipe-samples@main/examples/hand_landmarker/js/hand_landmarker.task',
];

const CONNECTIONS = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20],
  [0, 17],
];

const TIPS = [4, 8, 12, 16, 20];

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, (a.z || 0) - (b.z || 0));

export class HandTracker {
  constructor(video, overlayCanvas) {
    this.video = video;
    this.canvas = overlayCanvas;
    this.ctx = overlayCanvas.getContext('2d');
    this.landmarker = null;
    this.ready = false;
    this.lastVideoTime = -1;
    this.result = null;
    this.metrics = { present: false, x: 0.5, y: 0.5, openness: 0, landmarks: null };
  }

  async initMediaPipe() {
    let lastErr = null;
    let vision = null;
    let wasmBase = null;

    for (const s of SOURCES) {
      try {
        vision = await import(/* @vite-ignore */ s.bundle);
        wasmBase = s.wasm;
        break;
      } catch (err) {
        lastErr = err;
      }
    }
    if (!vision) throw lastErr || new Error('MediaPipe 运行时加载失败');

    const fileset = await vision.FilesetResolver.forVisionTasks(wasmBase);

    for (const model of MODEL_URLS) {
      for (const delegate of ['GPU', 'CPU']) {
        try {
          this.landmarker = await vision.HandLandmarker.createFromOptions(fileset, {
            baseOptions: { modelAssetPath: model, delegate },
            runningMode: 'VIDEO',
            numHands: 1,
            minHandDetectionConfidence: 0.55,
            minHandPresenceConfidence: 0.5,
            minTrackingConfidence: 0.5,
          });
          this.modelUrl = model;
          this.delegate = delegate;
          break;
        } catch (err) {
          lastErr = err;
        }
      }
      if (this.landmarker) break;
    }

    if (!this.landmarker) throw lastErr || new Error('手部模型加载失败');
    this.ready = true;
  }

  async startCamera() {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('当前浏览器不支持摄像头采集');
    }
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: 'user',
        width: { ideal: 960 },
        height: { ideal: 720 },
        frameRate: { ideal: 30, max: 60 },
      },
    });
    this.video.srcObject = stream;
    await this.video.play();
    await new Promise((resolve) => {
      if (this.video.readyState >= 2 && this.video.videoWidth) return resolve();
      this.video.addEventListener('loadeddata', () => resolve(), { once: true });
    });
    this.stream = stream;
    this.syncCanvasSize();
  }

  syncCanvasSize() {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.round((rect.width || 208) * dpr));
    const h = Math.max(1, Math.round((rect.height || 156) * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
  }

  /** 每帧调用；内部只在有新视频帧时做推理 */
  update() {
    if (!this.ready) return this.metrics;

    const v = this.video;
    if (v.readyState >= 2 && v.videoWidth) {
      if (v.currentTime !== this.lastVideoTime) {
        this.lastVideoTime = v.currentTime;
        try {
          this.result = this.landmarker.detectForVideo(v, performance.now());
        } catch (err) {
          /* 偶发推理异常，忽略本帧 */
        }
      }
    }

    const lm = this.result?.landmarks?.[0];
    if (lm && lm.length >= 21) {
      this.metrics = this.analyze(lm);
    } else {
      this.metrics = { present: false, x: 0.5, y: 0.5, openness: 0, landmarks: null };
    }

    this.draw();
    return this.metrics;
  }

  analyze(lm) {
    const wrist = lm[0];
    const midMcp = lm[9];
    const scale = Math.max(dist(wrist, midMcp), 1e-4);

    // 四指指尖到手腕的平均距离 —— 握拳时收拢，张掌时伸展
    let sum = 0;
    for (const i of [8, 12, 16, 20]) sum += dist(wrist, lm[i]);
    const meanR = sum / 4 / scale;

    // 拇指张角作为辅助（握拳时拇指贴在掌侧）
    const thumbR = dist(wrist, lm[4]) / scale;
    const thumbBoost = Math.min(Math.max((thumbR - 1.0) / 1.0, 0), 1) * 0.12;

    let open = (meanR - 1.16) / 0.70 + thumbBoost;
    open = Math.min(1, Math.max(0, open));

    // 手掌中心（腕 + 四个 MCP 的加权中心）
    const palm = { x: 0, y: 0, z: 0 };
    for (const i of [0, 5, 9, 13, 17]) {
      palm.x += lm[i].x; palm.y += lm[i].y; palm.z += (lm[i].z || 0);
    }
    palm.x /= 5; palm.y /= 5; palm.z /= 5;

    // 位置融合：手掌中心稳定，食指尖更“跟手”
    const finger = lm[8];
    const nx = palm.x * 0.62 + finger.x * 0.38;
    const ny = palm.y * 0.62 + finger.y * 0.38;

    return {
      present: true,
      // 镜像，符合自拍直觉
      x: 1 - nx,
      y: ny,
      openness: open,
      meanR,
      palm,
      tip: lm[8],
      landmarks: lm,
    };
  }

  /** 在预览画布上画出手部骨架 */
  draw() {
    const ctx = this.ctx;
    if (!ctx) return;
    const { width: W, height: H } = this.canvas;
    ctx.clearRect(0, 0, W, H);
    const m = this.metrics;
    if (!m.present || !m.landmarks) return;

    // 复刻 CSS object-fit: cover 的裁切映射
    const vw = this.video.videoWidth || 4;
    const vh = this.video.videoHeight || 3;
    const s = Math.max(W / vw, H / vh);
    const ox = (W - vw * s) / 2;
    const oy = (H - vh * s) / 2;
    const px = (p) => ox + p.x * vw * s;
    const py = (p) => oy + p.y * vh * s;

    const lm = m.landmarks;
    ctx.lineWidth = Math.max(1, W * 0.007);
    ctx.strokeStyle = 'rgba(255, 70, 48, 0.75)';
    ctx.shadowColor = 'rgba(255, 60, 30, 0.9)';
    ctx.shadowBlur = W * 0.02;

    ctx.beginPath();
    for (const [a, b] of CONNECTIONS) {
      ctx.moveTo(px(lm[a]), py(lm[a]));
      ctx.lineTo(px(lm[b]), py(lm[b]));
    }
    ctx.stroke();

    ctx.shadowBlur = 0;
    ctx.fillStyle = 'rgba(255, 235, 244, 0.92)';
    for (let i = 0; i < lm.length; i++) {
      const r = TIPS.includes(i) ? W * 0.014 : W * 0.007;
      ctx.beginPath();
      ctx.arc(px(lm[i]), py(lm[i]), r, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  stop() {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.landmarker?.close?.();
    this.ready = false;
  }
}
