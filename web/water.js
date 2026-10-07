import { createZoneSweep, ZONE_SWEEP_WGSL } from './zone-sweep.js';

// WebGPU water for 2core. Every visual is driven by confirmed controller state:
//   level        = time left on a confirmed run (unknown end time: a still half-full vessel)
//   beading drops + trembling surface = a command the controller hasn't confirmed yet
//   frost        = the controller hasn't been heard from recently
//   ripples      = a confirmed start (water), a confirmed stop (quiet), a failure (amber)
//   background rain = a zone is confirmed running
// The surface itself is a compute-shader wave simulation that follows the phone's tilt.
// CSS fallbacks remain for devices without WebGPU and after device loss.

const SIM_N = 128;

const SIM_WGSL = /* wgsl */ `
struct Sim { slope: f32, dt: f32, damp: f32, stir: f32, tremble: f32, time: f32, kick: f32, bound: f32, };
@group(0) @binding(0) var<uniform> sim: Sim;
@group(0) @binding(1) var<storage, read_write> hv: array<vec2f, ${SIM_N}>;
var<workgroup> hs: array<f32, ${SIM_N}>;
var<workgroup> red: array<f32, ${SIM_N}>;
@compute @workgroup_size(${SIM_N}) fn main(@builtin(local_invocation_index) i: u32) {
  let x = (f32(i) + 0.5) / ${SIM_N / 2}.0 - 1.0;
  var h = hv[i].x;
  var v = hv[i].y + sim.kick * x;
  // Simulate the deviation from the tilted rest plane; a tilt change becomes a slosh.
  var d = h - sim.slope * x;
  for (var s = 0u; s < 8u; s = s + 1u) {
    hs[i] = d;
    workgroupBarrier();
    let l = hs[select(i - 1u, 0u, i == 0u)];
    let r = hs[min(i + 1u, ${SIM_N - 1}u)];
    workgroupBarrier();
    let t = sim.time + f32(s) * sim.dt;
    let force = sim.stir * (0.6 * sin(x * 5.0 + t * 2.3) + 0.4 * sin(x * 11.0 - t * 3.1))
              + sim.tremble * 12.0 * sin(x * 37.0 + t * 41.0 + 3.0 * sin(t * 7.0));
    let a = 38000.0 * (l + r - 2.0 * d) - sim.damp * v + force;
    v = v + a * sim.dt;
    d = d + v * sim.dt;
  }
  h = d + sim.slope * x;
  // The app owns the water level, so keep the simulated mean at zero.
  red[i] = h;
  workgroupBarrier();
  for (var w = ${SIM_N / 2}u; w > 0u; w = w >> 1u) {
    if (i < w) { red[i] = red[i] + red[i + w]; }
    workgroupBarrier();
  }
  h = h - red[0] / ${SIM_N}.0;
  hv[i] = vec2f(clamp(h, -sim.bound, sim.bound), v);
}`;

const VESSEL_WGSL = /* wgsl */ `
struct U {
  res: vec2f, time: f32, level: f32,
  shape: f32, dark: f32, pend: f32, pendT: f32,
  frost: f32, textOn: f32, alpha: f32, bub: f32,
  grav: vec2f, xscale: f32, pad: f32,
  tint: vec4f, deep: vec4f, glass: vec4f, hi: vec4f,
};
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var tex: texture_2d<f32>;
@group(0) @binding(3) var<storage, read> hv: array<vec2f, ${SIM_N}>;
struct VO { @builtin(position) pos: vec4f, @location(0) uv: vec2f, };
@vertex fn vs(@builtin(vertex_index) i: u32) -> VO {
  var q = array<vec2f, 3>(vec2f(-1.0, -3.0), vec2f(-1.0, 1.0), vec2f(3.0, 1.0));
  var o: VO;
  o.pos = vec4f(q[i], 0.0, 1.0);
  o.uv = q[i] * vec2f(0.5, -0.5) + vec2f(0.5);
  return o;
}
fn hash(n: f32) -> f32 { return fract(sin(n * 127.1) * 43758.5453); }
fn surf(x: f32) -> f32 {
  let k = clamp((x / u.xscale + 1.0) * ${SIM_N / 2}.0 - 0.5, 0.0, ${SIM_N - 1}.0);
  let i0 = u32(floor(k));
  let i1 = min(i0 + 1u, ${SIM_N - 1}u);
  return mix(hv[i0].x, hv[i1].x, fract(k));
}
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
  let s = lvl + surf(p.x) * R;
  let below = s - p.y;
  let has = smoothstep(0.0, 0.012, u.level);
  let water = smoothstep(-px, px, below) * inside * has;
  let depth = clamp(below / (2.0 * R), 0.0, 1.0);
  let wc = mix(u.tint.rgb, u.deep.rgb, sqrt(depth));
  let q = p * 5.5;
  let c1 = sin(q.x + t * 1.1 + sin(q.y * 1.4 + t * 0.9)) * sin(q.y * 1.2 - t * 0.8 + sin(q.x * 0.8 - t * 0.6));
  let caus = pow(abs(c1), 5.0) * (1.0 - depth * 0.7);
  // Air carried in while the vessel fills.
  var bub = 0.0;
  for (var k = 0; k < 14; k = k + 1) {
    let fk = f32(k);
    let bx = (hash(fk + 0.5) * 2.0 - 1.0) * R * 0.7 + 0.02 * sin(t * 2.7 + fk * 1.9);
    let yy = -R + fract(hash(fk * 7.3) + t * (0.2 + hash(fk * 3.1) * 0.3)) * max(lvl + R, 0.0);
    let br = (0.012 + hash(fk * 1.7) * 0.018) * R;
    let d = length(p - vec2f(bx, yy));
    bub = bub + (1.0 - smoothstep(br - px, br + px, d)) * (0.3 + 0.7 * smoothstep(br * 0.45, br, d));
  }
  bub = clamp(bub, 0.0, 1.0) * u.bub * water * smoothstep(0.0, 0.03, below);
  // Condensation beading on the glass while a command waits for the controller.
  var drop = 0.0;
  for (var k = 0; k < 16; k = k + 1) {
    let fk = f32(k);
    let ang = 0.15 + hash(fk * 5.3) * 2.84;
    let base = vec2f(cos(ang), sin(ang) * 0.9) * R * (0.5 + 0.38 * hash(fk * 2.1));
    let c = base + u.grav * u.pendT * (0.004 + 0.012 * hash(fk * 9.1));
    let r = R * (0.016 + 0.02 * hash(fk * 3.7)) * smoothstep(0.0, 0.5, u.pend - hash(fk) * 0.5);
    let d = length(p - c);
    drop = drop + (1.0 - smoothstep(r - px, r + px, d)) * (0.35 + 0.65 * smoothstep(r * 0.2, r, d));
  }
  drop = clamp(drop, 0.0, 1.0) * inside * (1.0 - water);
  let menis = exp(-abs(below) / (px * 2.2)) * inside * has;
  let refr = vec2f(0.0035 * sin(p.y * 13.0 + t * 1.7), 0.003 * sin(p.x * 11.0 + t * 1.5)) * water;
  let tx = textureSampleLevel(tex, samp, v.uv + refr, 0.0) * u.textOn;
  var col = u.glass.rgb * u.glass.a * inside;
  var al = u.glass.a * inside;
  let wa = water * u.alpha;
  col = wc * wa + col * (1.0 - wa);
  al = wa + al * (1.0 - wa);
  let hl = clamp(bub * 0.8 + menis * 0.7 + caus * 0.2 * water + drop * 0.75, 0.0, 1.0);
  col = u.hi.rgb * hl + col * (1.0 - hl);
  al = hl + al * (1.0 - hl);
  // Frost: nothing heard from the controller lately; the water may be out of date.
  let grain = hash(dot(floor(v.uv * u.res / 2.0), vec2f(1.0, 57.0)));
  let fr = u.frost * inside * (0.55 + 0.1 * grain);
  col = u.glass.rgb * fr + col * (1.0 - fr);
  al = fr + al * (1.0 - fr);
  let trgb = mix(tx.rgb, u.deep.rgb * tx.a, 0.3 * water * (1.0 - u.frost));
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

// The water surface behind the app. Shared by the pond and by the glass dock,
// which refracts this same surface.
const POND_FN = binding => /* wgsl */ `
struct P {
  res: vec2f, time: f32, rain: f32,
  scale: f32, dark: f32, count: f32, pad: f32,
  rip: array<vec4f, 16>,
  ripc: array<vec4f, 16>,
};
@group(0) @binding(${binding}) var<uniform> pu: P;
fn h21(p: vec2f) -> f32 { return fract(sin(dot(p, vec2f(127.1, 311.7))) * 43758.5453); }
fn wave(d: f32, age: f32, spd: f32, k: f32, wd: f32, dec: f32) -> f32 {
  let x = d - age * spd;
  return sin(x * k) * exp(-x * x / (wd * wd)) * exp(-age * dec);
}
fn height(p: vec2f) -> f32 {
  var h = 0.0;
  let n = i32(pu.count);
  for (var i = 0; i < 16; i = i + 1) {
    if (i >= n) { break; }
    let r = pu.rip[i];
    let age = pu.time - r.z;
    if (age > 0.0 && age < 5.0) {
      h = h + r.w * wave(distance(p, r.xy), age, 300.0, 0.07, 70.0, 0.8) * smoothstep(0.0, 0.08, age);
    }
  }
  if (pu.rain > 0.001) {
    let cs = 150.0;
    let c0 = floor(p / cs);
    for (var j = -1; j <= 1; j = j + 1) {
      for (var i = -1; i <= 1; i = i + 1) {
        let c = c0 + vec2f(f32(i), f32(j));
        let per = 2.0 + h21(c) * 2.6;
        let tt = pu.time + h21(c + vec2f(13.7, 3.1)) * per;
        let k = floor(tt / per);
        let age = tt - k * per;
        let sd = c + vec2f(k * 1.37, k * 2.11);
        let on = step(h21(sd + vec2f(5.3, 1.1)), pu.rain);
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
  let n = i32(pu.count);
  for (var i = 0; i < 16; i = i + 1) {
    if (i >= n) { break; }
    let r = pu.rip[i];
    let age = pu.time - r.z;
    if (age > 0.0 && age < 5.0) {
      let x = distance(p, r.xy) - age * 300.0;
      let e = exp(-x * x / 8100.0) * exp(-age * 0.9) * r.w;
      c = c + pu.ripc[i].rgb * e;
      ws = ws + e;
    }
  }
  return vec4f(c, ws);
}
// Premultiplied light and shade the surface casts at p.
fn surfaceLight(p: vec2f) -> vec4f {
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
  let dark = pu.dark > 0.5;
  let hiCol = mix(select(vec3f(1.0), vec3f(0.72, 0.88, 1.0), dark), tcol, tw * 0.8);
  let hiA = max(lit, 0.0) * select(0.6, 0.4, dark);
  let shA = max(-lit, 0.0) * select(0.14, 0.4, dark);
  let glowA = tw * 0.1 * select(1.0, 1.4, dark);
  let al = clamp(hiA + glowA + shA, 0.0, 1.0);
  return vec4f(min(hiCol * hiA + tcol * glowA, vec3f(al)), al);
}`;

const FULLSCREEN_VS = /* wgsl */ `
struct VO { @builtin(position) pos: vec4f, };
@vertex fn vs(@builtin(vertex_index) i: u32) -> VO {
  var q = array<vec2f, 3>(vec2f(-1.0, -3.0), vec2f(-1.0, 1.0), vec2f(3.0, 1.0));
  var o: VO;
  o.pos = vec4f(q[i], 0.0, 1.0);
  return o;
}`;

const POND_WGSL =
  POND_FN(0) +
  FULLSCREEN_VS +
  /* wgsl */ `
@fragment fn fs(v: VO) -> @location(0) vec4f { return surfaceLight(v.pos.xy / pu.scale); }`;

// Liquid glass for the dock: real refraction of the water surface, which CSS
// backdrop blur can't bend. The HTML controls sit on top, transparent.
const GLASS_WGSL =
  POND_FN(1) +
  FULLSCREEN_VS +
  /* wgsl */ `
struct G {
  res: vec2f, time: f32, dark: f32,
  scale: f32, n: f32, sel: f32, run: f32,
  ground: vec4f, blobA: vec4f, blobB: vec4f, glass: vec4f, water: vec4f, hi: vec4f,
  lens: array<vec4f, 4>,
  lensB: array<vec4f, 4>,
};
@group(0) @binding(0) var<uniform> g: G;
fn sdRound(p: vec2f, b: vec2f, r: f32) -> f32 {
  let q = abs(p) - b + vec2f(r);
  return length(max(q, vec2f(0.0))) + min(max(q.x, q.y), 0.0) - r;
}
fn lensSd(p: vec2f, i: i32) -> f32 {
  let L = g.lens[i];
  return sdRound(p - (L.xy + L.zw * 0.5), L.zw * 0.5, g.lensB[i].x);
}
fn outerSd(p: vec2f) -> f32 {
  var d = 1e5;
  let n = i32(g.n);
  for (var i = 0; i < 4; i = i + 1) {
    if (i >= n) { break; }
    if (g.lensB[i].y != 1.0) { d = min(d, lensSd(p, i)); }
  }
  return d;
}
fn ground(q: vec2f) -> vec3f {
  let uv = q / g.res;
  let wa = clamp(1.0 - length(uv / vec2f(0.7, 0.45)) / 0.7, 0.0, 1.0);
  let wb = clamp(1.0 - length((vec2f(1.0) - uv) / vec2f(0.6, 0.45)) / 0.7, 0.0, 1.0);
  return mix(mix(g.ground.rgb, g.blobB.rgb, wb), g.blobA.rgb, wa);
}
fn scene(q: vec2f) -> vec3f {
  let l = surfaceLight(q);
  return l.rgb + ground(q) * (1.0 - l.a);
}
@fragment fn fs(v: VO) -> @location(0) vec4f {
  let p = v.pos.xy / g.scale;
  let sd = outerSd(p);
  if (sd > 2.0) { return vec4f(0.0); }
  let e = 0.75;
  let grad = normalize(vec2f(outerSd(p + vec2f(e, 0.0)) - outerSd(p - vec2f(e, 0.0)),
                             outerSd(p + vec2f(0.0, e)) - outerSd(p - vec2f(0.0, e))) + vec2f(1e-5));
  // Thick-glass bevel: light bends inward near the edge, like a lens.
  let bevel = 1.0 - smoothstep(-18.0, 0.0, sd);
  let edge = 1.0 - bevel;
  var q = p - grad * edge * edge * 16.0;
  // The selected tab is a second, stronger lens that slides between tabs.
  let si = i32(g.sel);
  var inSel = 0.0;
  if (si >= 0) {
    let S = g.lens[si];
    let sc = S.xy + S.zw * 0.5;
    inSel = 1.0 - smoothstep(-1.0, 1.0, lensSd(p, si));
    q = mix(q, sc + (q - sc) * 0.78, inSel);
  }
  var col = scene(q);
  // Colour fringing where the bevel bends light the most.
  if (edge > 0.25) {
    let off = grad * edge * edge * 3.0;
    col = vec3f(scene(q + off).r, col.g, scene(q - off).b);
  }
  // Frosted body so the labels above stay readable.
  col = mix(col, g.glass.rgb, g.glass.a);
  // Water held in the run capsule: its level is the time left on the run.
  let ri = i32(g.run);
  if (ri >= 0) {
    let L = g.lens[ri];
    let B = g.lensB[ri];
    let inRun = 1.0 - smoothstep(-1.0, 1.0, lensSd(p, ri));
    let fx = (p.x - L.x) / L.z;
    let mode = B.w;
    let t = select(g.time, 0.0, mode > 2.5);
    let lip = B.z + 0.012 * sin((p.y - L.y) * 0.22 + t * 2.4) + 0.006 * sin((p.y - L.y) * 0.5 - t * 3.3);
    var w = (1.0 - smoothstep(lip - 0.004, lip + 0.004, fx)) * inRun * select(0.0, 1.0, mode < 1.5 || mode > 2.5);
    col = mix(col, g.water.rgb, w * g.water.a * select(1.0, 0.45, mode > 2.5));
    // Waiting for the controller: a slow band of light moves through the empty capsule.
    let band = exp(-pow((fx - fract(g.time * 0.4) * 1.4 + 0.2) * 6.0, 2.0)) * inRun * select(0.0, 1.0, mode > 1.5 && mode < 2.5);
    col = mix(col, g.water.rgb, band * 0.35);
  }
  col = mix(col, g.hi.rgb, inSel * select(0.16, 0.08, g.dark > 0.5));
  // Top-lit rim with a slight prism split.
  let top = 0.45 + 0.55 * clamp(-grad.y, 0.0, 1.0);
  let rim = vec3f(exp(-pow((sd + 1.1) / 1.1, 2.0)), exp(-pow((sd + 1.5) / 1.1, 2.0)), exp(-pow((sd + 1.9) / 1.1, 2.0)));
  col = col + g.hi.rgb * rim * top * select(0.55, 0.3, g.dark > 0.5);
  let selRim = exp(-pow((lensSd(p, max(si, 0)) + 1.2) / 1.0, 2.0)) * select(0.0, 1.0, si >= 0);
  col = col + g.hi.rgb * selRim * select(0.35, 0.2, g.dark > 0.5);
  let a = 1.0 - smoothstep(-0.75, 0.75, sd);
  return vec4f(clamp(col, vec3f(0.0), vec3f(1.0)) * a, a);
}`;

export function createWaterFX() {
  const $ = id => document.getElementById(id);
  const RM = matchMedia('(prefers-reduced-motion: reduce)');
  const DM = matchMedia('(prefers-color-scheme: dark)');
  const ripples = [];
  const clock = () => performance.now() / 1000;
  const mix = (a, b, t) => [0, 1, 2].map(i => a[i] + (b[i] - a[i]) * t);
  const hex = s => {
    s = s.trim();
    if (s[0] === '#') {
      const d = s.slice(1),
        n = parseInt(d.length === 3 ? [...d].map(c => c + c).join('') : d, 16);
      return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255, 1];
    }
    const m = s.match(/[\d.]+/g)?.map(Number) ?? [0, 0, 0, 1];
    return [m[0] / 255, m[1] / 255, m[2] / 255, m[3] ?? 1];
  };
  let gpu = null,
    pal,
    ring,
    tank,
    pond,
    glass,
    frameId = 0,
    last = 0,
    state = { enabled: false };
  const zoneSweep = createZoneSweep({
    getGPU: () => gpu,
    getSurface: () => pal.surface,
    canAnimate: () => !RM.matches && !document.hidden && state.enabled && state.tab === 'plan',
    wake,
  });
  // Tilt: gravity direction in screen space (x right, y up); slope of the water's rest plane.
  const tilt = { on: false, slope: 0, target: 0, grav: [0, -1] };

  function readPal() {
    const cs = getComputedStyle(document.documentElement),
      v = n => hex(cs.getPropertyValue(n));
    const water = v('--water');
    pal = {
      dark: DM.matches,
      water,
      leaf: v('--leaf'),
      amber: v('--amber'),
      idle: mix(v('--ink-3'), water, 0.3),
      glass: v('--glass-strong'),
      ground: v('--ground'),
      blobA: v('--blob-a'),
      blobB: v('--blob-b'),
      surface: v('--surface'),
      ink: cs.getPropertyValue('--ink').trim(),
      ink2: cs.getPropertyValue('--ink-2').trim(),
      inkWater: cs.getPropertyValue('--water').trim(),
      inkAmber: cs.getPropertyValue('--amber').trim(),
    };
  }
  function tones(tone) {
    const b = pal[tone] || pal.water,
      W = [1, 1, 1],
      K = [0, 0, 0];
    return pal.dark
      ? { tint: mix(b, K, 0.25), deep: mix(b, K, 0.62), hi: mix(b, W, 0.72), alpha: 0.82 }
      : { tint: mix(b, W, 0.55), deep: mix(b, W, 0.08), hi: W, alpha: 0.72 };
  }

  /* ---------- a vessel of water with a simulated surface ---------- */
  class Vessel {
    constructor(canvas, shape, withText) {
      this.c = canvas;
      this.shape = shape;
      this.ctx = canvas.getContext('webgpu');
      this.ctx.configure({ device: gpu.dev, format: gpu.fmt, alphaMode: 'premultiplied' });
      this.ubuf = gpu.dev.createBuffer({ size: 128, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      this.sbuf = gpu.dev.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      this.hv = gpu.dev.createBuffer({ size: SIM_N * 8, usage: GPUBufferUsage.STORAGE });
      this.simBind = gpu.dev.createBindGroup({
        layout: gpu.sim.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this.sbuf } },
          { binding: 1, resource: { buffer: this.hv } },
        ],
      });
      this.u = new Float32Array(32);
      this.su = new Float32Array(8);
      this.s = {
        level: 0,
        lv: 0,
        target: 0,
        mode: 'idle',
        tone: 'idle',
        frost: 0,
        frostT: 0,
        pend: 0,
        pendSince: 0,
        kick: 0,
        kickAt: -9,
        tint: null,
      };
      this.text = withText ? document.createElement('canvas') : null;
      this.textKey = '';
      this.dirty = true;
      this.ro = new ResizeObserver(() => this.resize());
      this.ro.observe(canvas);
      this.resize();
    }
    resize() {
      const dpr = Math.min(devicePixelRatio || 1, 3),
        w = Math.max(1, Math.round(this.c.clientWidth * dpr)),
        h = Math.max(1, Math.round(this.c.clientHeight * dpr));
      if (w === this.c.width && h === this.c.height && this.tex) return;
      this.c.width = w;
      this.c.height = h;
      if (this.text) {
        this.text.width = w;
        this.text.height = h;
      }
      this.tex?.destroy();
      this.tex = gpu.dev.createTexture({
        size: [this.text ? w : 1, this.text ? h : 1],
        format: 'rgba8unorm',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
      });
      this.bind = gpu.dev.createBindGroup({
        layout: gpu.vessel.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this.ubuf } },
          { binding: 1, resource: gpu.samp },
          { binding: 2, resource: this.tex.createView() },
          { binding: 3, resource: { buffer: this.hv } },
        ],
      });
      this.dirty = true;
      wake();
    }
    setText(o) {
      const key = JSON.stringify(o) + pal.dark;
      if (key !== this.textKey) {
        this.textKey = key;
        this.o = o;
        this.dirty = true;
        wake();
      }
    }
    paintText() {
      if (!this.text || !this.o) return;
      const g = this.text.getContext('2d'),
        W = this.text.width,
        o = this.o;
      const font = (wt, px) => `${wt} ${px}px ui-rounded, "SF Pro Rounded", -apple-system, system-ui, sans-serif`;
      g.clearRect(0, 0, W, W);
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillStyle = pal.ink2;
      g.font = font(700, Math.round(W * 0.046));
      try {
        g.letterSpacing = `${Math.round(W * 0.007)}px`;
      } catch {
        /* older canvas */
      }
      g.fillText(o.label, W / 2, W * 0.31);
      try {
        g.letterSpacing = '0px';
      } catch {
        /* older canvas */
      }
      g.fillStyle = o.tone === 'amber' ? pal.inkAmber : pal.ink;
      let px = Math.round(W * 0.25);
      g.font = font(700, px);
      while (g.measureText(o.big).width > W * 0.64 && px > 12) {
        px = Math.round(px * 0.9);
        g.font = font(700, px);
      }
      g.fillText(o.big, W / 2, W * 0.5);
      g.fillStyle = o.tone === 'water' ? pal.inkWater : pal.ink2;
      g.font = font(600, Math.round(W * 0.07));
      g.fillText(o.word, W / 2, W * 0.68);
      gpu.dev.queue.copyExternalImageToTexture({ source: this.text }, { texture: this.tex, premultipliedAlpha: true }, [
        W,
        this.text.height,
      ]);
    }
    set(v) {
      const s = this.s;
      if (v.mode !== s.mode) {
        if (v.mode === 'starting' || v.mode === 'stopping') s.pendSince = clock();
        if (v.mode === 'running' && s.mode === 'starting' && !RM.matches) {
          s.level = 0;
          s.lv = 0;
        } // confirmed: pour it in
        s.mode = v.mode;
      }
      s.target = v.level;
      s.tone = v.tone;
      s.frostT = v.frost ? 1 : 0;
      wake();
    }
    kick(amount) {
      if (RM.matches) return;
      this.s.kick += amount;
      this.s.kickAt = clock();
      wake();
    }
    get animating() {
      const s = this.s;
      return (
        !RM.matches &&
        (tilt.on ||
          ['running', 'starting', 'stopping'].includes(s.mode) ||
          Math.abs(s.target - s.level) > 0.002 ||
          Math.abs(s.lv) > 0.002 ||
          clock() - s.kickAt < 4 ||
          Math.abs(s.frostT - s.frost) > 0.01 ||
          s.pend > 0.01)
      );
    }
    draw(t, dt, enc) {
      if (!this.c.clientWidth) return;
      const s = this.s,
        reduce = RM.matches,
        waiting = s.mode === 'starting' || s.mode === 'stopping';
      if (reduce) {
        s.level = s.target;
        s.lv = 0;
        s.frost = s.frostT;
        s.pend = waiting ? 1 : 0;
      } else {
        s.lv += ((s.target - s.level) * 30 - s.lv * 8) * dt;
        s.level = Math.max(0, Math.min(1, s.level + s.lv * dt));
        s.frost += (s.frostT - s.frost) * (1 - Math.exp(-dt * 2));
        s.pend += ((waiting ? 1 : 0) - s.pend) * (1 - Math.exp(-dt * (waiting ? 1.2 : 5)));
      }
      const tn = tones(s.tone);
      if (!s.tint) s.tint = { ...tn };
      for (const k of ['tint', 'deep', 'hi']) s.tint[k] = mix(s.tint[k], tn[k], 1 - Math.exp(-dt * 4));
      s.tint.alpha = tn.alpha;
      if (this.dirty) {
        this.paintText();
        this.dirty = false;
      }
      const frozen = s.frost > 0.5;
      const aspect = this.c.width / this.c.height;
      // Simulation step: tilt, gentle stir while running, a tremble while waiting.
      const su = this.su;
      su.set([
        reduce ? 0 : tilt.slope * (this.shape ? aspect : 1),
        Math.min(dt, 1 / 60) / 8,
        2.4,
        frozen || reduce ? 0 : s.mode === 'running' ? 0.35 : 0,
        frozen || reduce ? 0 : waiting ? 1 : 0,
        t,
        s.kick,
        this.shape ? 1.6 : 0.5,
      ]);
      s.kick = 0;
      gpu.dev.queue.writeBuffer(this.sbuf, 0, su);
      const u = this.u,
        glass = this.shape === 0 ? pal.glass : [0, 0, 0, 0];
      u.set([
        this.c.width,
        this.c.height,
        frozen ? 0 : t,
        s.level,
        this.shape,
        pal.dark ? 1 : 0,
        s.pend,
        Math.min(30, clock() - s.pendSince),
        s.frost,
        this.text ? 1 : 0,
        s.tint.alpha,
        reduce ? 0 : Math.min(1, Math.max(0, s.lv) * 4),
        tilt.grav[0],
        tilt.grav[1],
        this.shape ? aspect : 0.88,
        0,
        ...s.tint.tint,
        1,
        ...s.tint.deep,
        1,
        glass[0],
        glass[1],
        glass[2],
        glass[3],
        ...s.tint.hi,
        1,
      ]);
      gpu.dev.queue.writeBuffer(this.ubuf, 0, u);
      const cp = enc.beginComputePass();
      cp.setPipeline(gpu.sim);
      cp.setBindGroup(0, this.simBind);
      cp.dispatchWorkgroups(1);
      cp.end();
      const pass = enc.beginRenderPass({
        colorAttachments: [
          {
            view: this.ctx.getCurrentTexture().createView(),
            loadOp: 'clear',
            storeOp: 'store',
            clearValue: [0, 0, 0, 0],
          },
        ],
      });
      pass.setPipeline(gpu.vessel);
      pass.setBindGroup(0, this.bind);
      pass.draw(3);
      pass.end();
    }
  }

  /* ---------- the surface behind everything ---------- */
  class Pond {
    constructor(canvas) {
      this.c = canvas;
      this.ctx = canvas.getContext('webgpu');
      this.ctx.configure({ device: gpu.dev, format: gpu.fmt, alphaMode: 'premultiplied' });
      this.buf = gpu.dev.createBuffer({ size: 544, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      this.bind = gpu.dev.createBindGroup({
        layout: gpu.pond.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: { buffer: this.buf } }],
      });
      this.u = new Float32Array(136);
      this.rain = 0;
      this.clean = false;
      this.scale = 1;
      this.resize();
    }
    resize() {
      this.c.style.height = `${innerHeight}px`;
      this.c.width = Math.round(innerWidth * this.scale);
      this.c.height = Math.round(innerHeight * this.scale);
      this.clean = false;
    }
    get active() {
      return this.rain > 0.01 || ripples.length > 0;
    }
    update(t, rainT) {
      this.rain += (rainT - this.rain) * 0.03;
      if (this.rain < 0.005 && rainT === 0) this.rain = 0;
      while (ripples.length && t - ripples[0].t0 > 5) ripples.shift();
      const u = this.u;
      u.fill(0);
      u.set([this.c.width, this.c.height, t, this.rain, this.scale, pal.dark ? 1 : 0, ripples.length, 0]);
      ripples.forEach((r, i) => {
        u.set([r.x, r.y, r.t0, r.str], 8 + i * 4);
        u.set([...r.rgb, 0], 72 + i * 4);
      });
      gpu.dev.queue.writeBuffer(this.buf, 0, u);
    }
    draw(enc) {
      const active = this.active;
      if (!active && this.clean) return;
      const pass = enc.beginRenderPass({
        colorAttachments: [
          {
            view: this.ctx.getCurrentTexture().createView(),
            loadOp: 'clear',
            storeOp: 'store',
            clearValue: [0, 0, 0, 0],
          },
        ],
      });
      if (active) {
        pass.setPipeline(gpu.pond);
        pass.setBindGroup(0, this.bind);
        pass.draw(3);
      }
      pass.end();
      this.clean = !active;
    }
  }

  /* ---------- liquid glass for the dock ---------- */
  class Glass {
    constructor(canvas) {
      this.c = canvas;
      this.ctx = canvas.getContext('webgpu');
      this.ctx.configure({ device: gpu.dev, format: gpu.fmt, alphaMode: 'premultiplied' });
      this.buf = gpu.dev.createBuffer({ size: 256, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      this.bind = gpu.dev.createBindGroup({
        layout: gpu.glass.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this.buf } },
          { binding: 1, resource: { buffer: pond.buf } },
        ],
      });
      this.u = new Float32Array(64);
      this.sel = null;
      this.sv = [0, 0];
      this.key = '';
      this.level = 0;
      this.resize();
    }
    resize() {
      this.scale = Math.min(devicePixelRatio || 1, 2);
      this.c.style.height = `${innerHeight}px`;
      this.c.width = Math.round(innerWidth * this.scale);
      this.c.height = Math.round(innerHeight * this.scale);
      this.key = '';
    }
    // Returns true while something in the glass is still moving.
    draw(t, dt, enc) {
      const dock = $('dock');
      if (dock.hidden) {
        if (this.key !== 'hidden') {
          this.clear(enc);
          this.key = 'hidden';
        }
        return false;
      }
      const rect = el => {
        const r = el.getBoundingClientRect();
        return [r.x, r.y, r.width, r.height];
      };
      const lenses = [],
        B = [];
      const tabs = $('tabs'),
        current = tabs.querySelector('[aria-current=page]'),
        run = $('run-dock');
      lenses.push(rect(tabs));
      B.push([rect(tabs)[3] / 2, 0, 0, 0]);
      let selIndex = -1,
        runIndex = -1,
        moving = false;
      if (current) {
        const target = rect(current);
        if (!this.sel || RM.matches) {
          this.sel = target.slice();
          this.sv = [0, 0];
        }
        // A springy lens slides to the selected tab.
        const ax = (target[0] - this.sel[0]) * 260 - this.sv[0] * 26,
          aw = (target[2] - this.sel[2]) * 260 - this.sv[1] * 26;
        this.sv[0] += ax * dt;
        this.sv[1] += aw * dt;
        this.sel[0] += this.sv[0] * dt;
        this.sel[2] += this.sv[1] * dt;
        this.sel[1] = target[1];
        this.sel[3] = target[3];
        moving = Math.abs(target[0] - this.sel[0]) > 0.3 || Math.abs(this.sv[0]) > 1;
        selIndex = lenses.length;
        lenses.push(this.sel.slice());
        B.push([this.sel[3] / 2, 1, 0, 0]);
      }
      const cap = state.capsule;
      if (!run.hidden && cap) {
        this.level += ((cap.level ?? 0) - this.level) * (RM.matches ? 1 : 1 - Math.exp(-dt * 3));
        runIndex = lenses.length;
        lenses.push(rect(run));
        B.push([
          rect(run)[3] / 2,
          2,
          this.level,
          { running: 1, unknown: 1, starting: 2, stopping: 2, stale: 3 }[cap.mode] ?? 0,
        ]);
      }
      const animated = !RM.matches && (pond.active || moving || (runIndex >= 0 && [1, 2].includes(B[runIndex][3])));
      const key = JSON.stringify([lenses.map(l => l.map(Math.round)), B, pal.dark]);
      if (!animated && key === this.key) return false;
      this.key = animated ? '' : key;
      const tone = cap?.mode === 'stale' ? pal.idle : pal.water;
      const glassTint = pal.dark
        ? [...mix(pal.surface, [0, 0, 0], 0.1), 0.52]
        : [...mix(pal.surface, pal.ground, 0.2), 0.5];
      const u = this.u;
      u.fill(0);
      u.set([
        innerWidth,
        innerHeight,
        RM.matches ? 0 : t,
        pal.dark ? 1 : 0,
        this.scale,
        lenses.length,
        selIndex,
        runIndex,
        ...pal.ground.slice(0, 3),
        1,
        ...pal.blobA.slice(0, 3),
        1,
        ...pal.blobB.slice(0, 3),
        1,
        ...glassTint,
        ...tone.slice(0, 3),
        pal.dark ? 0.55 : 0.4,
        ...(pal.dark ? mix(pal.water, [1, 1, 1], 0.7) : [1, 1, 1]),
        1,
      ]);
      lenses.forEach((l, i) => {
        u.set(l, 32 + i * 4);
        u.set(B[i], 48 + i * 4);
      });
      gpu.dev.queue.writeBuffer(this.buf, 0, u);
      const pass = enc.beginRenderPass({
        colorAttachments: [
          {
            view: this.ctx.getCurrentTexture().createView(),
            loadOp: 'clear',
            storeOp: 'store',
            clearValue: [0, 0, 0, 0],
          },
        ],
      });
      pass.setPipeline(gpu.glass);
      pass.setBindGroup(0, this.bind);
      pass.draw(3);
      pass.end();
      return animated;
    }
    clear(enc) {
      const pass = enc.beginRenderPass({
        colorAttachments: [
          {
            view: this.ctx.getCurrentTexture().createView(),
            loadOp: 'clear',
            storeOp: 'store',
            clearValue: [0, 0, 0, 0],
          },
        ],
      });
      pass.end();
    }
  }

  function fallback(error) {
    zoneSweep.settle();
    cancelAnimationFrame(frameId);
    frameId = 0;
    $('water-orb').classList.remove('gpu');
    $('tank-box').classList.remove('gpu');
    for (const id of ['vessel', 'tank', 'pond', 'glass']) $(id).hidden = true;
    document.documentElement.dataset.waterRenderer = 'css';
    ring?.ro.disconnect();
    tank?.ro.disconnect();
    const device = gpu?.dev;
    gpu = null;
    device?.destroy();
    if (error) console.warn('WebGPU water unavailable:', error.message || error);
  }

  function frame(ts) {
    frameId = 0;
    if (!gpu || document.hidden || !state.enabled) return;
    const dt = Math.min(0.05, (ts - last) / 1000 || 0.016);
    last = ts;
    const t = RM.matches ? 0 : clock() % 3600;
    let again = false;
    try {
      const enc = gpu.dev.createCommandEncoder();
      pond.update(t, RM.matches ? 0 : state.running ? 0.35 : 0);
      pond.draw(enc);
      again ||= pond.active && !RM.matches;
      const showRing = state.tab === 'walk' && !state.modal;
      if (showRing) {
        ring.draw(t, dt, enc);
        $('water-orb').classList.add('gpu');
        again ||= ring.animating;
      }
      if (state.sheet) {
        tank.draw(t, dt, enc);
        $('tank-box').classList.add('gpu');
        again ||= tank.animating;
      }
      again = glass.draw(t, dt, enc) || again;
      again = zoneSweep.draw(enc) || again;
      gpu.dev.queue.submit([enc.finish()]);
    } catch (error) {
      fallback(error);
      return;
    }
    if (again) frameId = requestAnimationFrame(frame);
  }
  function wake() {
    if (!frameId && gpu && !document.hidden && state.enabled) frameId = requestAnimationFrame(frame);
  }

  async function init() {
    try {
      if (!navigator.gpu) {
        fallback();
        return;
      }
      const adapter = await navigator.gpu.requestAdapter();
      if (!adapter) {
        fallback();
        return;
      }
      const dev = await adapter.requestDevice(),
        fmt = navigator.gpu.getPreferredCanvasFormat();
      dev.pushErrorScope('validation');
      const render = code => {
        const module = dev.createShaderModule({ code });
        return dev.createRenderPipelineAsync({
          layout: 'auto',
          vertex: { module, entryPoint: 'vs' },
          fragment: { module, entryPoint: 'fs', targets: [{ format: fmt }] },
          primitive: { topology: 'triangle-list' },
        });
      };
      const [vessel, pondPipe, glassPipe, sweepPipe, sim] = await Promise.all([
        render(VESSEL_WGSL),
        render(POND_WGSL),
        render(GLASS_WGSL),
        render(ZONE_SWEEP_WGSL),
        dev.createComputePipelineAsync({
          layout: 'auto',
          compute: { module: dev.createShaderModule({ code: SIM_WGSL }), entryPoint: 'main' },
        }),
      ]);
      gpu = {
        dev,
        fmt,
        vessel,
        pond: pondPipe,
        glass: glassPipe,
        zoneSweep: sweepPipe,
        sim,
        samp: dev.createSampler({ magFilter: 'linear', minFilter: 'linear' }),
      };
      const error = await dev.popErrorScope();
      if (error) throw error;
      dev.lost.then(info => {
        if (gpu?.dev === dev) fallback(info);
      });
      dev.addEventListener('uncapturederror', event => fallback(event.error));
      readPal();
      pond = new Pond($('pond'));
      glass = new Glass($('glass'));
      ring = new Vessel($('vessel'), 0, true);
      tank = new Vessel($('tank'), 1, false);
      document.documentElement.dataset.waterRenderer = 'webgpu';
      apply();
    } catch (error) {
      fallback(error);
    }
  }

  function apply() {
    if (!gpu) return;
    const v = state.vessel;
    if (v) {
      ring.set(v);
      ring.setText({
        label: v.label,
        big: v.big,
        word: v.word,
        tone: v.tone === 'amber' ? 'amber' : v.mode === 'running' || v.mode === 'starting' ? 'water' : 'ink',
      });
    }
    if (state.tankState) tank.set(state.tankState);
    glass.key = '';
    wake();
  }

  function ripple(x, y, str, tone) {
    if (!gpu || RM.matches || !state.enabled) return;
    ripples.push({ x, y, t0: clock() % 3600, str, rgb: (pal[tone] || pal.water).slice(0, 3) });
    while (ripples.length > 16) ripples.shift();
    wake();
  }
  function origin() {
    const el =
      state.tab === 'walk' && !state.modal ? $('water-orb') : !$('run-dock').hidden ? $('run-dock') : $('tabs');
    const r = el.getBoundingClientRect();
    return [r.x + r.width / 2, r.y + r.height / 2];
  }

  /* dragging across the vessel sloshes it */
  let dragX = null;
  $('water-orb').addEventListener('pointerdown', e => {
    dragX = e.clientX;
  });
  addEventListener(
    'pointermove',
    e => {
      if (dragX === null || !ring) return;
      ring.kick((dragX - e.clientX) * 0.02);
      dragX = e.clientX;
    },
    { passive: true },
  );
  for (const ev of ['pointerup', 'pointercancel'])
    addEventListener(ev, () => {
      dragX = null;
    });

  function onMotion(e) {
    const a = e.accelerationIncludingGravity;
    if (!a || a.x == null) return;
    // Portrait screen axes: x right, y up. Upright, y reads +g; tilting clockwise makes x negative.
    const mag = Math.hypot(a.x, a.y);
    const angle = mag > 3 ? Math.atan2(-a.x, a.y) : 0;
    tilt.target = Math.max(-0.8, Math.min(0.8, Math.tan(angle)));
    tilt.slope += (tilt.target - tilt.slope) * 0.2;
    tilt.grav = mag > 3 ? [a.x / mag, -a.y / mag] : [0, -1];
    wake();
  }
  const tiltApi = {
    get available() {
      return 'DeviceMotionEvent' in window && matchMedia('(pointer: coarse)').matches;
    },
    get on() {
      return tilt.on;
    },
    async set(enabled) {
      if (!enabled) {
        removeEventListener('devicemotion', onMotion);
        Object.assign(tilt, { on: false, slope: 0, target: 0, grav: [0, -1] });
        wake();
        return false;
      }
      if (tilt.on || !this.available) return tilt.on;
      try {
        // iOS Safari asks for motion permission; other browsers have no such method.
        const motion = /** @type {any} */ (DeviceMotionEvent);
        if (typeof motion.requestPermission === 'function' && (await motion.requestPermission()) !== 'granted')
          return false;
      } catch {
        return false;
      }
      addEventListener('devicemotion', onMotion);
      tilt.on = true;
      wake();
      return true;
    },
    async toggle() {
      return this.set(!tilt.on);
    },
  };

  DM.addEventListener('change', () => {
    readPal();
    if (ring) {
      ring.textKey = '';
      ring.dirty = true;
    }
    apply();
  });
  RM.addEventListener('change', () => {
    zoneSweep.settle();
    ripples.length = 0;
    apply();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      zoneSweep.settle();
      cancelAnimationFrame(frameId);
      frameId = 0;
    } else {
      last = performance.now();
      wake();
    }
  });
  addEventListener('resize', () => {
    pond?.resize();
    glass?.resize();
    wake();
  });
  addEventListener(
    'scroll',
    () => {
      if (glass) {
        glass.key = '';
        wake();
      }
    },
    { passive: true },
  );
  init();

  return {
    update(next) {
      state = next;
      if (!state.enabled || state.tab !== 'plan') zoneSweep.settle();
      apply();
    },
    zoneEnabled(row, paused) {
      zoneSweep.update(row, paused);
    },
    // Confirmed outcomes only: the app calls this when the controller has answered.
    event(kind) {
      const [x, y] = origin();
      if (kind === 'started') {
        ripple(x, y, 1.2, 'water');
        ring?.kick(0.8);
      } else if (kind === 'stopped') ripple(x, y, 0.45, 'idle');
      else if (kind === 'failed') ripple(x, y, 1, 'amber');
    },
    pour(delta) {
      tank?.kick(Math.max(-1.5, Math.min(1.5, delta * 0.12)));
    },
    tilt: tiltApi,
  };
}
