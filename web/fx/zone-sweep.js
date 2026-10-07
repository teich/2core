// Shares the water renderer's device, palette, command encoder, and frame loop.
export const ZONE_SWEEP_WGSL = /* wgsl */ `
struct U { size: vec2f, progress: f32, pad: f32, surface: vec4f, };
@group(0) @binding(0) var<uniform> u: U;
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  var q = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(q[i], 0.0, 1.0);
}
@fragment fn fs(@builtin(position) p: vec4f) -> @location(0) vec4f {
  let diagonal = (p.x + p.y * 0.85) / (u.size.x + u.size.y * 0.85);
  let t = u.progress * u.progress * (3.0 - 2.0 * u.progress);
  let front = mix(-0.12, 1.12, t);
  let distance = diagonal - front;
  let dim = 1.0 - smoothstep(-0.075, 0.075, distance);
  let rim = exp(-pow(distance / 0.025, 2.0)) * sin(u.progress * 3.14159265);
  let alpha = dim * 0.28 + rim * 0.065;
  let color = mix(u.surface.rgb, vec3f(0.38, 0.73, 0.68), rim * 0.22);
  return vec4f(color * alpha, alpha);
}`;

export function createZoneSweep({ getGPU, getSurface, canAnimate, wake }) {
  const known = new WeakMap(),
    active = new Map();
  function finish(row, effect) {
    effect.ctx.unconfigure();
    effect.buffer.destroy();
    effect.canvas.remove();
    row.classList.remove('zone-sweeping', 'zone-sweep-pending');
    row.style.removeProperty('--zone-dim');
    active.delete(row);
  }
  function settle() {
    for (const [row, effect] of active) finish(row, effect);
  }
  return {
    settle,
    update(row, paused) {
      const previous = known.get(row);
      known.set(row, paused);
      row.classList.toggle('paused', paused);
      if (previous === undefined || previous === paused) return;
      const gpu = getGPU();
      if (!gpu || !canAnimate() || !row.getClientRects().length) return;
      let effect = active.get(row);
      if (!effect) {
        const canvas = document.createElement('canvas');
        canvas.className = 'zone-sweep';
        canvas.setAttribute('aria-hidden', 'true');
        const ctx = canvas.getContext('webgpu');
        if (!ctx) return;
        ctx.configure({ device: gpu.dev, format: gpu.fmt, alphaMode: 'premultiplied' });
        const buffer = gpu.dev.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
        const bind = gpu.dev.createBindGroup({
          layout: gpu.zoneSweep.getBindGroupLayout(0),
          entries: [{ binding: 0, resource: { buffer } }],
        });
        effect = {
          canvas,
          ctx,
          buffer,
          bind,
          progress: Number(previous),
          last: performance.now(),
          u: new Float32Array(8),
        };
        row.append(canvas);
        active.set(row, effect);
      }
      effect.target = Number(paused);
      // Keep the old resting dim until the shared frame paints the first sweep.
      row.style.setProperty('--zone-dim', String(effect.progress * 0.28));
      row.classList.add('zone-sweep-pending');
      wake();
    },
    draw(enc) {
      const gpu = getGPU();
      if (!gpu || !canAnimate()) {
        settle();
        return false;
      }
      const now = performance.now();
      for (const [row, effect] of active) {
        if (!row.isConnected || !row.getClientRects().length) {
          finish(row, effect);
          continue;
        }
        const dt = Math.min(64, Math.max(0, now - effect.last));
        effect.last = now;
        effect.progress = effect.target
          ? Math.min(1, effect.progress + dt / 850)
          : Math.max(0, effect.progress - dt / 850);
        if (effect.progress === effect.target) {
          finish(row, effect);
          continue;
        }
        const scale = Math.min(devicePixelRatio || 1, 2);
        const width = Math.max(1, Math.round(row.clientWidth * scale)),
          height = Math.max(1, Math.round(row.clientHeight * scale));
        if (effect.canvas.width !== width || effect.canvas.height !== height) {
          effect.canvas.width = width;
          effect.canvas.height = height;
        }
        effect.u.set([width, height, effect.progress, 0, ...getSurface()]);
        gpu.dev.queue.writeBuffer(effect.buffer, 0, effect.u);
        const pass = enc.beginRenderPass({
          colorAttachments: [
            {
              view: effect.ctx.getCurrentTexture().createView(),
              loadOp: 'clear',
              storeOp: 'store',
              clearValue: [0, 0, 0, 0],
            },
          ],
        });
        pass.setPipeline(gpu.zoneSweep);
        pass.setBindGroup(0, effect.bind);
        pass.draw(3);
        pass.end();
        row.classList.add('zone-sweeping');
        row.classList.remove('zone-sweep-pending');
        row.style.removeProperty('--zone-dim');
      }
      return active.size > 0;
    },
  };
}
