import * as THREE from 'three';

/* =========================================================
   指尖绽放 · 余烬粒子花（对齐参考视频效果）
   ---------------------------------------------------------
   一批粒子、一次 draw call，在两个形态之间按 uBloom 混合：
   · 花苞态：约 130 根纵向丝缕编成的椭圆光笼，微微扭转
   · 绽放态：粒子沿各自方向炸开的放射星芒，带螺旋涡旋，
     近核心炽白偏黄、中段橙红、外缘深红余烬
   · 指尖位置作为斥力源，划过时拨动粒子
   ========================================================= */

const SPARK_VERTEX = /* glsl */ `
  uniform float uTime;
  uniform float uBloom;
  uniform float uIntro;
  uniform float uSize;
  uniform float uPixelRatio;
  uniform vec3  uFinger;
  uniform float uFingerR;
  uniform float uFingerPush;

  attribute float aStrand;   // 丝缕编号 0~1（负值 = 内部填充粒子）
  attribute float aU;        // 沿丝缕参数 0~1（两极）
  attribute float aDist;     // 爆开距离系数 0~1
  attribute vec3  aDir;      // 爆开方向（单位球）
  attribute vec3  aRand;

  varying vec3  vColor;
  varying float vAlpha;

  const float PI = 3.14159265359;

  void main() {
    float t = aU;

    /* ---- 1. 每颗粒子错峰起爆，爆开有层次 ---- */
    float delay = 0.16 * aRand.x;
    float p = clamp((uBloom - delay) / max(1.0 - delay, 0.001), 0.0, 1.0);
    p = p * p * (3.0 - 2.0 * p);

    /* ---- 2a. 花苞：椭圆光笼（纵向丝缕，两极收拢） ---- */
    float interior = step(aStrand, -0.5);   // 1 = 内部稀疏填充
    float strand   = abs(aStrand);

    float ang = strand * 6.2831853
              + (t - 0.5) * 0.55                       // 轻微螺旋扭转
              + sin(uTime * 0.4 + strand * 40.0) * 0.015 // 呼吸微颤
              + (aRand.y - 0.5) * 0.028;

    float prof = pow(sin(PI * clamp(pow(t, 0.92), 0.001, 0.999)), 0.55);
    float wob  = 1.0 + 0.028 * sin(t * 11.0 + strand * 47.0 + uTime * 0.7);
    float rBud = 0.64 * prof * wob * (1.0 - interior * 0.22);
    float yBud = 1.02 * (2.0 * t - 1.0);
    if (interior > 0.5) ang = aRand.x * 6.2831853 + uTime * 0.04;

    // 相邻丝缕明暗交替，凸显「编织」质感
    float strandGlow = 0.68 + 0.45 * sin(strand * 94.2);

    vec3 budPos = vec3(cos(ang) * rBud, yBud, sin(ang) * rBud);

    /* ---- 2b. 绽放：放射星芒（螺旋涡旋 + 湍流） ---- */
    float swirl = (1.0 - aDist) * 2.4 + uTime * 0.15;
    float cs = cos(swirl), sn = sin(swirl);
    vec3 dir = vec3(aDir.x * cs - aDir.z * sn, aDir.y, aDir.x * sn + aDir.z * cs);

    float reach = (0.18 + aDist * 2.25)
                * (1.0 + 0.05 * sin(uTime * 0.9 + aRand.z * 6.2831));
    vec3 burstPos = dir * reach;
    burstPos += vec3(
      sin(uTime * 1.3 + aRand.x * 17.0),
      cos(uTime * 1.1 + aRand.y * 19.0),
      sin(uTime * 1.7 + aRand.z * 23.0)
    ) * 0.06 * (0.3 + aDist);
    burstPos.y *= 0.94;

    vec3 pos = mix(budPos, burstPos, p);
    pos.y -= 0.12;

    /* ---- 3. 入场：粒子从远处汇聚 ---- */
    float intro = clamp((uIntro - aRand.z * 0.35) / 0.65, 0.0, 1.0);
    intro = intro * intro * (3.0 - 2.0 * intro);
    pos   *= mix(2.5, 1.0, intro);
    pos.y += mix(1.45, 0.0, intro);

    /* ---- 4. 指尖斥力 ---- */
    vec3 toF = pos - uFinger;
    float d  = length(toF);
    float infl = 1.0 - smoothstep(0.0, uFingerR, d);
    infl *= infl;
    pos += normalize(toF + vec3(0.0001, 0.0001, 0.0)) * infl * uFingerPush;

    vec4 mv = modelViewMatrix * vec4(pos, 1.0);
    gl_Position = projectionMatrix * mv;

    /* ---- 5. 尺寸：核心粒子更大更亮 ---- */
    float sizeVar = 0.55 + 0.9 * aRand.z;
    float burstBoost = mix(1.0, 1.0 + (1.0 - aDist) * 1.1, p);
    gl_PointSize = uSize * uPixelRatio * sizeVar * burstBoost
                 * (6.0 / max(-mv.z, 0.1)) * mix(0.35, 1.0, intro);

    float twinkle = 0.72 + 0.42 * sin(uTime * 2.3 + aRand.x * 31.0);
    vAlpha = (0.58 + 0.42 * aRand.y) * twinkle
           * mix(strandGlow, 0.30, interior) * intro;

    /* ---- 6. 配色：花苞绯红丝缕 ↔ 星芒余烬梯度 ---- */
    vec3 budCol = mix(vec3(0.52, 0.065, 0.10), vec3(1.0, 0.28, 0.30),
                      0.20 + 0.80 * aRand.z);

    vec3 hot  = vec3(1.00, 0.88, 0.60);   // 炽白偏黄
    vec3 mid  = vec3(1.00, 0.32, 0.15);   // 橙红
    vec3 cold = vec3(0.46, 0.055, 0.065); // 深红余烬
    vec3 burstCol = mix(hot, mid, smoothstep(0.02, 0.30, aDist));
    burstCol = mix(burstCol, cold, smoothstep(0.30, 0.95, aDist));
    // 少量白热火花
    burstCol = mix(burstCol, vec3(1.0, 0.97, 0.86),
                   step(0.985, aRand.x) * (1.0 - smoothstep(0.0, 0.4, aDist)));

    vColor = mix(budCol, burstCol, p);
  }
`;

const SPARK_FRAGMENT = /* glsl */ `
  varying vec3  vColor;
  varying float vAlpha;

  void main() {
    vec2 c = gl_PointCoord - 0.5;
    float d = length(c);
    if (d > 0.5) discard;
    float a = smoothstep(0.5, 0.02, d);
    a = pow(a, 2.1);
    vec3 col = vColor * (0.70 + 0.85 * a);
    gl_FragColor = vec4(col * a * vAlpha, a * vAlpha);
  }
`;

const DUST_VERTEX = /* glsl */ `
  uniform float uTime;
  uniform float uPixelRatio;
  uniform float uBloom;

  attribute vec3 aRand;

  varying float vAlpha;
  varying vec3  vColor;

  void main() {
    vec3 p = position;
    float sp = 0.05 + aRand.x * 0.13;
    p.y = mod(p.y + uTime * sp + 6.0, 12.0) - 6.0;
    p.x += sin(uTime * 0.45 + aRand.y * 6.2831) * 0.30;
    p.z += cos(uTime * 0.37 + aRand.z * 6.2831) * 0.30;

    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = (1.0 + aRand.z * 2.0) * uPixelRatio * (9.0 / max(-mv.z, 0.1))
                 * (0.75 + 0.5 * uBloom);

    vAlpha = (0.10 + 0.34 * aRand.x) * (0.45 + 0.55 * sin(uTime * 1.4 + aRand.y * 12.0));
    vColor = mix(vec3(1.0, 0.42, 0.28), vec3(0.72, 0.10, 0.10), aRand.y * 0.8);
  }
`;

const DUST_FRAGMENT = /* glsl */ `
  varying float vAlpha;
  varying vec3  vColor;

  void main() {
    vec2 c = gl_PointCoord - 0.5;
    float d = length(c);
    if (d > 0.5) discard;
    float a = pow(smoothstep(0.5, 0.0, d), 1.9);
    gl_FragColor = vec4(vColor * a * vAlpha, a * vAlpha);
  }
`;

/* ---------- 工具 ---------- */

function glowTexture() {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0.0, 'rgba(255,240,210,0.95)');
  g.addColorStop(0.16, 'rgba(255,130,70,0.50)');
  g.addColorStop(0.42, 'rgba(205,40,28,0.18)');
  g.addColorStop(0.75, 'rgba(90,12,14,0.05)');
  g.addColorStop(1.0, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

export class Flower {
  constructor(scene, renderer) {
    this.scene = scene;
    this.renderer = renderer;
    this.group = new THREE.Group();
    scene.add(this.group);

    this.pixelRatio = renderer.getPixelRatio();

    /* ---------- 火花粒子 ---------- */
    const COUNT = 26000;
    const STRANDS = 130;

    const position = new Float32Array(COUNT * 3); // 占位，真实位置在着色器里算
    const aStrand = new Float32Array(COUNT);
    const aU = new Float32Array(COUNT);
    const aDist = new Float32Array(COUNT);
    const aDir = new Float32Array(COUNT * 3);
    const aRand = new Float32Array(COUNT * 3);

    // 预生成星芒的「辐条」方向：让爆开有丝缕状簇拥感
    const SPOKES = 72;
    const spokes = [];
    for (let s = 0; s < SPOKES; s++) {
      // 均匀球面分布
      const z = Math.random() * 2 - 1;
      const a = Math.random() * Math.PI * 2;
      const r = Math.sqrt(1 - z * z);
      spokes.push([Math.cos(a) * r, z, Math.sin(a) * r]);
    }

    for (let i = 0; i < COUNT; i++) {
      // 花苞：6% 内部稀疏填充，其余落在丝缕上
      if (Math.random() < 0.06) {
        aStrand[i] = -(0.5 + Math.random() * 0.5);
      } else {
        aStrand[i] = Math.floor(Math.random() * STRANDS) / STRANDS;
      }
      aU[i] = Math.random();

      // 爆开距离：核心密、长刺稀
      if (Math.random() < 0.12) {
        aDist[i] = 0.68 + Math.random() * 0.32;   // 长刺
      } else {
        aDist[i] = Math.pow(Math.random(), 1.7) * 0.85;
      }

      // 方向：吸附到辐条 + 少量散布
      const sp = spokes[Math.floor(Math.random() * SPOKES)];
      const spread = 0.16;
      let dx = sp[0] + (Math.random() - 0.5) * spread;
      let dy = sp[1] + (Math.random() - 0.5) * spread;
      let dz = sp[2] + (Math.random() - 0.5) * spread;
      const dl = Math.hypot(dx, dy, dz) || 1;
      aDir[i * 3] = dx / dl;
      aDir[i * 3 + 1] = dy / dl;
      aDir[i * 3 + 2] = dz / dl;

      aRand[i * 3] = Math.random();
      aRand[i * 3 + 1] = Math.random();
      aRand[i * 3 + 2] = Math.random();
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(position, 3));
    geo.setAttribute('aStrand', new THREE.BufferAttribute(aStrand, 1));
    geo.setAttribute('aU', new THREE.BufferAttribute(aU, 1));
    geo.setAttribute('aDist', new THREE.BufferAttribute(aDist, 1));
    geo.setAttribute('aDir', new THREE.BufferAttribute(aDir, 3));
    geo.setAttribute('aRand', new THREE.BufferAttribute(aRand, 3));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 6);

    this.sparkUniforms = {
      uTime: { value: 0 },
      uBloom: { value: 0 },
      uIntro: { value: 0 },
      uSize: { value: 2.7 },
      uPixelRatio: { value: this.pixelRatio },
      uFinger: { value: new THREE.Vector3(99, 99, 0) },
      uFingerR: { value: 0.5 },
      uFingerPush: { value: 0 },
    };

    const sparkMat = new THREE.ShaderMaterial({
      uniforms: this.sparkUniforms,
      vertexShader: SPARK_VERTEX,
      fragmentShader: SPARK_FRAGMENT,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    this.sparks = new THREE.Points(geo, sparkMat);
    this.sparks.frustumCulled = false;
    this.sparks.renderOrder = 2;
    this.group.add(this.sparks);
    this.particleCount = COUNT;

    /* ---------- 漂浮余烬 ---------- */
    const DUST = 600;
    const dPos = new Float32Array(DUST * 3);
    const dRand = new Float32Array(DUST * 3);
    for (let n = 0; n < DUST; n++) {
      const rad = 1.4 + Math.random() * 4.2;
      const a = Math.random() * Math.PI * 2;
      dPos[n * 3] = Math.cos(a) * rad;
      dPos[n * 3 + 1] = (Math.random() * 12) - 6;
      dPos[n * 3 + 2] = Math.sin(a) * rad * 0.7 - 1.2;
      dRand[n * 3] = Math.random();
      dRand[n * 3 + 1] = Math.random();
      dRand[n * 3 + 2] = Math.random();
    }
    const dGeo = new THREE.BufferGeometry();
    dGeo.setAttribute('position', new THREE.BufferAttribute(dPos, 3));
    dGeo.setAttribute('aRand', new THREE.BufferAttribute(dRand, 3));

    this.dustUniforms = {
      uTime: { value: 0 },
      uPixelRatio: { value: this.pixelRatio },
      uBloom: { value: 0 },
    };

    this.dust = new THREE.Points(dGeo, new THREE.ShaderMaterial({
      uniforms: this.dustUniforms,
      vertexShader: DUST_VERTEX,
      fragmentShader: DUST_FRAGMENT,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }));
    this.dust.frustumCulled = false;
    this.dust.renderOrder = 1;
    scene.add(this.dust);

    /* ---------- 炽热花心与暗红光晕 ---------- */
    const tex = glowTexture();

    this.aura = new THREE.Sprite(new THREE.SpriteMaterial({
      map: tex,
      color: 0xb3161c,
      transparent: true,
      opacity: 0.10,
      blending: THREE.AdditiveBlending,
      depthTest: false,
      depthWrite: false,
    }));
    this.aura.position.set(0, -0.12, -0.6);
    this.aura.scale.setScalar(4.6);
    this.aura.renderOrder = 0;
    this.group.add(this.aura);

    this.core = new THREE.Sprite(new THREE.SpriteMaterial({
      map: tex,
      color: 0xfff0cf,
      transparent: true,
      opacity: 0.18,
      blending: THREE.AdditiveBlending,
      depthTest: false,
      depthWrite: false,
    }));
    this.core.position.set(0, -0.12, 0.2);
    this.core.scale.setScalar(1.0);
    this.core.renderOrder = 3;
    this.group.add(this.core);
  }

  update({ time, bloom, intro, fingerLocal, fingerPush }) {
    const u = this.sparkUniforms;
    u.uTime.value = time;
    u.uBloom.value = bloom;
    u.uIntro.value = intro;
    u.uFingerPush.value = fingerPush;

    if (fingerLocal) u.uFinger.value.copy(fingerLocal);

    this.dustUniforms.uTime.value = time;
    this.dustUniforms.uBloom.value = bloom;

    // 光笼缓慢自转 + 极轻微摇曳（星芒本身径向对称，不需要转视角）
    this.group.rotation.y = time * 0.06;
    this.group.rotation.z = Math.sin(time * 0.33) * 0.02;

    // 绽放时炽热核心升起；花苞时只剩一枚暗红微光
    const breathe = 1 + Math.sin(time * 1.6) * 0.05;
    this.core.scale.setScalar((0.34 + bloom * 1.35) * breathe);
    this.core.material.opacity = 0.10 + bloom * 0.52;

    this.aura.scale.setScalar(3.2 + bloom * 3.2);
    this.aura.material.opacity = 0.05 + bloom * 0.20;
  }

  resize(renderer) {
    this.pixelRatio = renderer.getPixelRatio();
    this.sparkUniforms.uPixelRatio.value = this.pixelRatio;
    this.dustUniforms.uPixelRatio.value = this.pixelRatio;
  }
}
