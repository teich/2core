// The original claude-zones WebGPU shaders, connected to confirmed server state.
// Designed for current iPhones over HTTPS; CSS remains a device-loss fallback.
const VESSEL_WGSL = /* wgsl */`
struct U {
  res: vec2f, time: f32, level: f32,
  agit: f32, tilt: f32, shape: f32, dark: f32,
  bub: f32, pad: f32, textOn: f32, alpha: f32,
  tint: vec4f, deep: vec4f, glass: vec4f, hi: vec4f,
};
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var tex: texture_2d<f32>;
struct VO { @builtin(position) pos: vec4f, @location(0) uv: vec2f, };
@vertex fn vs(@builtin(vertex_index) i: u32) -> VO {
  var q = array<vec2f, 3>(vec2f(-1.0, -3.0), vec2f(-1.0, 1.0), vec2f(3.0, 1.0));
  var o: VO;
  o.pos = vec4f(q[i], 0.0, 1.0);
  o.uv = q[i] * vec2f(0.5, -0.5) + vec2f(0.5);
  return o;
}
fn hash(n: f32) -> f32 { return fract(sin(n * 127.1) * 43758.5453); }
@fragment fn fs(v: VO) -> @location(0) vec4f {
  let t = u.time;
  let asp = u.res.x / u.res.y;
  var p = v.uv * 2.0 - vec2f(1.0);
  p.y = -p.y;
  p.x = p.x * asp;
  let px = 2.0 / u.res.y;
  let circ = u.shape < 0.5;
  let R = select(1.0, 0.88, circ);
  let sd = select(-1.0, length(p) - R, circ);
  let inside = 1.0 - smoothstep(-px, px, sd);
  let lvl = -R + u.level * 2.0 * R;
  let a = u.agit;
  let w = a * (0.05 * sin(p.x * 4.5 + t * 2.4) + 0.03 * sin(p.x * 10.0 - t * 3.7) + 0.015 * sin(p.x * 21.0 + t * 6.3))
        + 0.012 * sin(p.x * 3.0 + t * 1.2);
  let s = lvl + u.tilt * p.x + w;
  let below = s - p.y;
  let has = smoothstep(0.0, 0.015, u.level);
  let water = smoothstep(-px, px, below) * inside * has;
  let depth = clamp(below / (2.0 * R), 0.0, 1.0);
  let wc = mix(u.tint.rgb, u.deep.rgb, sqrt(depth));
  let q = p * 5.5;
  let c1 = sin(q.x + t * 1.1 + sin(q.y * 1.4 + t * 0.9)) * sin(q.y * 1.2 - t * 0.8 + sin(q.x * 0.8 - t * 0.6));
  let caus = pow(abs(c1), 5.0) * (1.0 - depth * 0.7);
  var bub = 0.0;
  for (var k = 0; k < 18; k = k + 1) {
    let fk = f32(k);
    let spd = 0.16 + hash(fk * 3.1) * 0.34;
    let bx = (hash(fk + 0.5) * 2.0 - 1.0) * R * 0.72 + 0.025 * sin(t * 2.7 + fk * 1.9);
    let yy = -R + fract(hash(fk * 7.3) + t * spd) * max(lvl + R, 0.0);
    let br = (0.012 + hash(fk * 1.7) * 0.022) * R;
    let d = length(p - vec2f(bx, yy));
    bub = bub + (1.0 - smoothstep(br - px, br + px, d)) * (0.3 + 0.7 * smoothstep(br * 0.45, br, d));
  }
  bub = clamp(bub, 0.0, 1.0) * u.bub * water * smoothstep(0.0, 0.03, below);
  let menis = exp(-abs(below) / (px * 2.2)) * inside * has;
  let refr = vec2f(0.010 * sin(p.y * 17.0 + t * 2.1) + 0.006 * sin(p.x * 8.0 - t * 1.6),
                   0.008 * sin(p.x * 13.0 + t * 1.8)) * (0.5 + a) * water;
  let tx = textureSampleLevel(tex, samp, v.uv + refr, 0.0) * u.textOn;
  var col = u.glass.rgb * u.glass.a * inside;
  var al = u.glass.a * inside;
  let wa = water * u.alpha;
  col = wc * wa + col * (1.0 - wa);
  al = wa + al * (1.0 - wa);
  let hl = clamp(bub * 0.85 + menis * 0.75 + caus * 0.22 * water, 0.0, 1.0);
  col = u.hi.rgb * hl + col * (1.0 - hl);
  al = hl + al * (1.0 - hl);
  let trgb = mix(tx.rgb, u.deep.rgb * tx.a, 0.3 * water);
  col = trgb + col * (1.0 - tx.a);
  al = tx.a + al * (1.0 - tx.a);
  let rimW = select(0.0, 1.0, circ);
  let rim = exp(-abs(sd + 0.012) / 0.01) * (0.3 + 0.35 * p.y / R) * rimW * inside;
  let sp = exp(-pow(length((p - vec2f(-0.42, 0.5) * R) * vec2f(1.0, 1.8)) / (0.16 * R), 2.0)) * 0.3 * rimW * inside;
  let g = clamp(rim + sp, 0.0, 1.0);
  col = u.hi.rgb * g + col * (1.0 - g);
  al = g + al * (1.0 - g);
  return vec4f(min(col, vec3f(al)), al);
}`;

const POND_WGSL = /* wgsl */`
struct P {
  res: vec2f, time: f32, rain: f32,
  scale: f32, dark: f32, count: f32, pad: f32,
  rip: array<vec4f, 16>,
  ripc: array<vec4f, 16>,
};
@group(0) @binding(0) var<uniform> u: P;
struct VO { @builtin(position) pos: vec4f, };
@vertex fn vs(@builtin(vertex_index) i: u32) -> VO {
  var q = array<vec2f, 3>(vec2f(-1.0, -3.0), vec2f(-1.0, 1.0), vec2f(3.0, 1.0));
  var o: VO;
  o.pos = vec4f(q[i], 0.0, 1.0);
  return o;
}
fn h21(p: vec2f) -> f32 { return fract(sin(dot(p, vec2f(127.1, 311.7))) * 43758.5453); }
fn wave(d: f32, age: f32, spd: f32, k: f32, wd: f32, dec: f32) -> f32 {
  let x = d - age * spd;
  return sin(x * k) * exp(-x * x / (wd * wd)) * exp(-age * dec);
}
fn height(p: vec2f) -> f32 {
  var h = 0.0;
  let n = i32(u.count);
  for (var i = 0; i < 16; i = i + 1) {
    if (i >= n) { break; }
    let r = u.rip[i];
    let age = u.time - r.z;
    if (age > 0.0 && age < 5.0) {
      h = h + r.w * wave(distance(p, r.xy), age, 300.0, 0.07, 70.0, 0.8) * smoothstep(0.0, 0.08, age);
    }
  }
  if (u.rain > 0.001) {
    let cs = 150.0;
    let c0 = floor(p / cs);
    for (var j = -1; j <= 1; j = j + 1) {
      for (var i = -1; i <= 1; i = i + 1) {
        let c = c0 + vec2f(f32(i), f32(j));
        let per = 2.0 + h21(c) * 2.6;
        let tt = u.time + h21(c + vec2f(13.7, 3.1)) * per;
        let k = floor(tt / per);
        let age = tt - k * per;
        let sd = c + vec2f(k * 1.37, k * 2.11);
        let on = step(h21(sd + vec2f(5.3, 1.1)), u.rain);
        let ctr = (c + vec2f(h21(sd), h21(sd + vec2f(1.7, 9.2)))) * cs;
        h = h + on * 0.5 * wave(distance(p, ctr), age, 60.0, 0.2, 16.0, 1.4) * smoothstep(0.0, 0.1, age);
      }
    }
  }
  return h;
}
fn tint(p: vec2f) -> vec4f {
  var c = vec3f(0.0);
  var ws = 0.0;
  let n = i32(u.count);
  for (var i = 0; i < 16; i = i + 1) {
    if (i >= n) { break; }
    let r = u.rip[i];
    let age = u.time - r.z;
    if (age > 0.0 && age < 5.0) {
      let x = distance(p, r.xy) - age * 300.0;
      let e = exp(-x * x / 8100.0) * exp(-age * 0.9) * r.w;
      c = c + u.ripc[i].rgb * e;
      ws = ws + e;
    }
  }
  return vec4f(c, ws);
}
@fragment fn fs(v: VO) -> @location(0) vec4f {
  let p = v.pos.xy / u.scale;
  let e = 1.5;
  let h0 = height(p);
  let gx = (height(p + vec2f(e, 0.0)) - h0) / e;
  let gy = (height(p + vec2f(0.0, e)) - h0) / e;
  let n = normalize(vec3f(-gx * 10.0, -gy * 10.0, 1.0));
  let L = normalize(vec3f(-0.45, -0.65, 0.62));
  let dif = dot(n, L) - L.z;
  let sp = pow(max(dot(reflect(-L, n), vec3f(0.0, 0.0, 1.0)), 0.0), 40.0);
  let lit = clamp(dif * 2.2 + sp * 0.8, -1.0, 1.0);
  let tc = tint(p);
  let tw = clamp(tc.w, 0.0, 1.0);
  let tcol = select(vec3f(1.0), tc.rgb / max(tc.w, 0.0001), tc.w > 0.0001);
  let dark = u.dark > 0.5;
  let hiBase = select(vec3f(1.0), vec3f(0.72, 0.88, 1.0), dark);
  let hiCol = mix(hiBase, tcol, tw * 0.8);
  let hiA = max(lit, 0.0) * select(0.6, 0.4, dark);
  let shA = max(-lit, 0.0) * select(0.14, 0.4, dark);
  let glowA = tw * 0.1 * select(1.0, 1.4, dark);
  let col = hiCol * hiA + tcol * glowA;
  let al = clamp(hiA + glowA + shA, 0.0, 1.0);
  return vec4f(min(col, vec3f(al)), al);
}`;


export function createWaterFX() {
  const $ = id => document.getElementById(id);
  const RM = matchMedia('(prefers-reduced-motion: reduce)');
  const DM = matchMedia('(prefers-color-scheme: dark)');
  const ripples = [];
  const clock = () => performance.now() / 1000;
  const mix = (a,b,t) => [0,1,2].map(i => a[i]+(b[i]-a[i])*t);
  let gpu, pal, ring, tank, pond, frameId = 0, last = 0, state = {}, previousZone;
  const visible = new Set();
  const visibility = new IntersectionObserver(entries => { for (const entry of entries) entry.isIntersecting ? visible.add(entry.target.id) : visible.delete(entry.target.id); wake(); });
  for (const id of ['vessel','tank']) visibility.observe($(id));
  function readPal() {
    const dark = DM.matches;
    pal = { dark, water: dark ? [.24,.70,.96] : [.043,.52,.81], leaf: dark ? [.30,.77,.48] : [.18,.60,.35],
      idle:dark ? [.16,.37,.40] : [.45,.66,.68], amber:[.95,.70,.20],
      glass:dark ? [.13,.20,.19,.88] : [.96,.99,1,.85],
      inkCss:dark ? '#eaf2ee' : '#0f1d19', ink2Css:dark ? '#a9bfb6' : '#52635d', leafCss:dark ? '#4cc47a' : '#2e9a58' };
  }
  function tones(tone) {
    const b = pal[tone] || pal.water, W = [1,1,1], K = [0,0,0];
    return pal.dark ? { tint:mix(b,K,.25),deep:mix(b,K,.62),hi:mix(b,W,.72),alpha:.82 }
      : { tint:mix(b,W,.55),deep:mix(b,W,.08),hi:W,alpha:.72 };
  }
  class Vessel {
    constructor(canvas, shape, withText) {
      this.c = canvas; this.shape = shape; this.withText = withText;
      this.ctx = canvas.getContext('webgpu');
      this.ctx.configure({ device: gpu.dev, format: gpu.fmt, alphaMode: 'premultiplied' });
      this.buf = gpu.dev.createBuffer({ size: 112, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      this.u = new Float32Array(28);
      this.s = { level: 0, lv: 0, target: 0, tilt: 0, tv: 0, agit: 0.1, agitT: 0.1, bub: 0, bubT: 0, tint: null, tone: 'idle' };
      this.text = withText ? document.createElement('canvas') : null;
      this.textKey = ''; this.dirty = true;
      this.ro = new ResizeObserver(() => this.resize()); this.ro.observe(canvas);
      this.resize();
    }
    resize() {
      const dpr = Math.min(devicePixelRatio || 1, 3), w = Math.max(1, Math.round(this.c.clientWidth * dpr)), h = Math.max(1, Math.round(this.c.clientHeight * dpr));
      if (w === this.c.width && h === this.c.height && this.tex) return;
      this.c.width = w; this.c.height = h;
      const tw = this.text ? w : 1, th = this.text ? h : 1;
      if (this.text) { this.text.width = tw; this.text.height = th; }
      this.tex?.destroy();
      this.tex = gpu.dev.createTexture({ size: [tw, th], format: 'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT });
      this.bind = gpu.dev.createBindGroup({ layout: gpu.vpipe.getBindGroupLayout(0), entries: [
        { binding: 0, resource: { buffer: this.buf } }, { binding: 1, resource: gpu.samp }, { binding: 2, resource: this.tex.createView() }] });
      this.dirty = true; wake();
    }
    setText(o) {
      const key = JSON.stringify(o) + (pal.dark ? 'd' : 'l');
      if (key !== this.textKey) { this.textKey = key; this.o = o; this.dirty = true; }
    }
    paintText() {
      if (!this.text || !this.o) return;
      const g = this.text.getContext('2d'), W_ = this.text.width, o = this.o;
      const font = (wt, px) => `${wt} ${px}px ui-rounded, "SF Pro Rounded", -apple-system, system-ui, sans-serif`;
      g.clearRect(0, 0, W_, W_); g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillStyle = pal.ink2Css; g.font = font(700, Math.round(W_ * 0.044));
      try { g.letterSpacing = `${Math.round(W_ * 0.006)}px`; } catch {}
      g.fillText(o.label, W_ / 2, W_ * 0.29);
      try { g.letterSpacing = '0px'; } catch {}
      g.fillStyle = pal.inkCss;
      if (o.num === '✓') {
        g.lineWidth = W_ * 0.035; g.lineCap = g.lineJoin = 'round'; g.strokeStyle = pal.inkCss;
        g.beginPath(); g.moveTo(W_ * 0.38, W_ * 0.5); g.lineTo(W_ * 0.47, W_ * 0.59); g.lineTo(W_ * 0.63, W_ * 0.41); g.stroke();
      } else {
        g.font = font(700, Math.round(W_ * (o.num.length > 1 ? 0.34 : 0.36)));
        g.fillText(o.num, W_ / 2, W_ * 0.5);
      }
      g.fillStyle = o.hot ? pal.leafCss : pal.ink2Css; g.font = font(600, Math.round(W_ * 0.074));
      g.fillText(o.time, W_ / 2, W_ * 0.72);
      gpu.dev.queue.copyExternalImageToTexture({ source: this.text }, { texture: this.tex, premultipliedAlpha: true }, [W_, this.text.height]);
    }
    set(v) { const s = this.s; s.target = v.level; s.agitT = RM.matches ? 0 : v.agit; s.bubT = RM.matches ? 0 : v.bub; s.tone = v.tone; }
    step(dt) {
      const s = this.s;
      if (RM.matches) { s.level = s.target; s.tilt = 0; s.lv = 0; s.tv = 0; s.agit = 0; s.bub = 0; }
      s.lv += ((s.target - s.level) * 34 - s.lv * 8.5) * dt; s.level = Math.max(0, Math.min(1, s.level + s.lv * dt));
      s.tv += (-s.tilt * 55 - s.tv * 3.2) * dt; s.tilt = Math.max(-0.45, Math.min(0.45, s.tilt + s.tv * dt));
      const k = 1 - Math.exp(-dt * 2.5);
      s.agit += (s.agitT - s.agit) * k; s.bub += (s.bubT - s.bub) * k;
      const tn = tones(s.tone);
      if (!s.tint) s.tint = { ...tn };
      for (const key of ['tint', 'deep', 'hi']) s.tint[key] = mix(s.tint[key], tn[key], 1 - Math.exp(-dt * 4));
      s.tint.alpha = tn.alpha;
    }
    draw(t, dt) {
      if (!this.c.clientWidth) return;
      this.step(dt);
      if (this.dirty) { this.paintText(); this.dirty = false; }
      const s = this.s, u = this.u, glass = this.shape === 0 ? pal.glass : [0, 0, 0, 0];
      u.set([this.c.width, this.c.height, t, s.level, s.agit, s.tilt, this.shape, pal.dark ? 1 : 0, s.bub, 0, this.text ? 1 : 0, s.tint.alpha,
        ...s.tint.tint, 1, ...s.tint.deep, 1, glass[0], glass[1], glass[2], glass[3], ...s.tint.hi, 1]);
      gpu.dev.queue.writeBuffer(this.buf, 0, u);
      const enc = gpu.dev.createCommandEncoder();
      const pass = enc.beginRenderPass({ colorAttachments: [{ view: this.ctx.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] }] });
      pass.setPipeline(gpu.vpipe); pass.setBindGroup(0, this.bind); pass.draw(3); pass.end();
      gpu.dev.queue.submit([enc.finish()]);
    }
    destroy() { this.ro.disconnect(); try { this.ctx.unconfigure(); } catch {} this.tex?.destroy(); this.buf.destroy(); }
  }

  /* ---- the water surface behind everything ---- */
  class Pond {
    constructor(canvas) {
      this.c = canvas; this.ctx = canvas.getContext('webgpu');
      this.ctx.configure({ device: gpu.dev, format: gpu.fmt, alphaMode: 'premultiplied' });
      this.buf = gpu.dev.createBuffer({ size: 544, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      this.bind = gpu.dev.createBindGroup({ layout: gpu.ppipe.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: this.buf } }] });
      this.u = new Float32Array(136); this.rain = 0; this.clean = false; this.frame = 0;
      this.scale = 1; this.resize(); addEventListener('resize', () => this.resize());
    }
    resize() {
      this.c.style.height = `${innerHeight}px`;
      this.c.width = Math.round(innerWidth * this.scale); this.c.height = Math.round(innerHeight * this.scale); this.clean = false; wake();
    }
    draw(t, rainT) {
      this.rain += (rainT - this.rain) * 0.03;
      while (ripples.length && t - ripples[0].t0 > 5) ripples.shift();
      const active = this.rain > 0.01 || ripples.length;
      if (!active && this.clean) return;
      if (active && t - (this.lastDraw || 0) < 1 / 30) return;
      this.lastDraw = t;
      const u = this.u; u.fill(0);
      u.set([this.c.width, this.c.height, t, active ? this.rain : 0, this.scale, pal.dark ? 1 : 0, ripples.length, 0]);
      ripples.slice(-16).forEach((r, i) => { u.set([r.x, r.y, r.t0, r.str], 8 + i * 4); u.set([...r.rgb, 0], 72 + i * 4); });
      gpu.dev.queue.writeBuffer(this.buf, 0, u);
      const enc = gpu.dev.createCommandEncoder();
      const pass = enc.beginRenderPass({ colorAttachments: [{ view: this.ctx.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] }] });
      if (active) { pass.setPipeline(gpu.ppipe); pass.setBindGroup(0, this.bind); pass.draw(3); }
      pass.end(); gpu.dev.queue.submit([enc.finish()]);
      this.clean = !active;
    }
  }


  function fallback(error) {
    cancelAnimationFrame(frameId); frameId = 0;
    $('water-orb').classList.remove('gpu'); $('tank').parentElement.classList.remove('gpu');
    for (const id of ['vessel','tank','pond']) $(id).hidden = true;
    document.documentElement.dataset.waterRenderer = 'css';
    ring?.ro.disconnect(); tank?.ro.disconnect();
    const device = gpu?.dev; gpu = null; device?.destroy();
    if (error) console.warn('WebGPU water unavailable:',error.message || error);
  }
  function applyState() {
    if (!ring || !gpu) return;
    ring.set({ level:state.level ?? .16, agit:state.running ? 1 : .24, bub:state.running ? 1 : .15, tone:state.running ? 'water' : 'idle' });
    ring.setText({ label:'ZONE',num:state.number || '—',time:state.running ? state.time : 'READY',hot:false });
    tank.set({ level:.10+.8*(state.minutes || 5)/60,agit:.6,bub:.4,tone:'water' });
    if (previousZone !== state.number && !RM.matches) { ring.s.level = .02; ring.s.lv = 0; ring.s.tv += 1.6; }
    previousZone = state.number;
    wake();
  }
  function frame(ts) {
    frameId = 0;
    if (!gpu || document.hidden || !state.enabled) return;
    const dt = Math.min(.05,(ts-last)/1000 || .016); last = ts;
    const t = RM.matches ? 0 : clock();
    try {
      pond.draw(t,RM.matches ? 0 : state.flow || 0);
      if (state.walk && !state.modal && visible.has('vessel')) { ring.draw(t,dt); $('water-orb').classList.add('gpu'); }
      if (state.sheet && visible.has('tank')) { tank.draw(t,dt); $('tank').parentElement.classList.add('gpu'); }
    } catch (error) { fallback(error); return; }
    const vesselVisible = (state.walk && !state.modal && visible.has('vessel')) || (state.sheet && visible.has('tank'));
    if (!RM.matches && (vesselVisible || pond.rain > .01 || ripples.length || state.flow > 0)) frameId = requestAnimationFrame(frame);
  }
  function wake() { if (!frameId && gpu && !document.hidden && state.enabled) frameId = requestAnimationFrame(frame); }
  async function init() {
    try {
      if (!navigator.gpu) { fallback(); return; }
      const adapter = await navigator.gpu.requestAdapter({ powerPreference:'high-performance' });
      if (!adapter) { fallback(); return; }
      const dev = await adapter.requestDevice(), fmt = navigator.gpu.getPreferredCanvasFormat();
      dev.pushErrorScope('validation');
      const make = async code => {
        const module = dev.createShaderModule({ code });
        return dev.createRenderPipelineAsync({ layout:'auto', vertex:{module,entryPoint:'vs'}, fragment:{module,entryPoint:'fs',targets:[{format:fmt}]},primitive:{topology:'triangle-list'} });
      };
      gpu = { dev,fmt,vpipe:await make(VESSEL_WGSL),ppipe:await make(POND_WGSL),samp:dev.createSampler({magFilter:'linear',minFilter:'linear'}) };
      const error = await dev.popErrorScope(); if (error) throw error;
      dev.lost.then(info => { if (gpu?.dev === dev) fallback(info); });
      dev.addEventListener('uncapturederror',event => fallback(event.error));
      readPal();
      ring = new Vessel($('vessel'),0,true); tank = new Vessel($('tank'),1,false); pond = new Pond($('pond'));
      document.documentElement.dataset.waterRenderer = 'webgpu';
      applyState();
    } catch (error) { fallback(error); }
  }
  DM.addEventListener('change',()=> { readPal(); if (ring) { ring.textKey=''; ring.dirty=true; } applyState(); });
  RM.addEventListener('change',()=> { ripples.length=0; if (pond) { pond.rain=0; pond.clean=false; } applyState(); });
  document.addEventListener('visibilitychange',()=> {
    if (document.hidden) { cancelAnimationFrame(frameId); frameId=0; } else { last=performance.now(); wake(); }
  });
  function ripple(x,y,strong,tone) {
    if (!gpu || RM.matches || !state.enabled) return;
    ripples.push({x,y,t0:clock(),str:strong,rgb:(pal[tone] || pal.water).slice(0,3)});
    if (ripples.length>16) ripples.shift(); wake();
  }
  document.addEventListener('pointerdown',e=> {
    ripple(e.clientX,e.clientY,e.target.closest('button') ? 1.5 : .7,e.target.closest('.stop') ? 'amber' : 'water');
    if (!RM.matches && tank && state.sheet) tank.s.tv += .7;
  },{passive:true});
  // Keyboard activation gets the same visual response without requiring a touch.
  document.addEventListener('click',e=> { if (e.detail === 0 && e.target.closest('button')) { const r=e.target.getBoundingClientRect(); ripple(r.x+r.width/2,r.y+r.height/2,1.3,'water'); } });
  let dragX = null;
  $('water-orb').addEventListener('pointerdown',e=>{dragX=e.clientX;});
  window.addEventListener('pointermove',e=> { if (dragX === null || RM.matches || !ring) return; ring.s.tv -= (e.clientX-dragX)*.012; dragX=e.clientX; wake(); },{passive:true});
  for (const event of ['pointerup','pointercancel']) window.addEventListener(event,()=>{dragX=null;});
  init();
  return { update(next) { state=next; applyState(); }, slosh() { if (tank && !RM.matches) tank.s.tv += 1.8; wake(); } };
}
