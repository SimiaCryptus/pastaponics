// Plate footprint and frame geometry (problem.md §6.5). Shared by the post‑processor (bridge
// placement), the validator (bridge clearance) and the mesher so all three agree on where the
// frame is. Z‑up, mm.

import { clamp } from './geom.js';

export const POST_INSET = 0.5;   // frame parts sit this far inside the plate edge

export function frameMode(spec) {
  return spec.frame === true ? 'posts' : spec.frame || 'none';
}

/** Plate footprint = routing grid (or a synthetic grid) grown by `plate.margin`, snapped to whole cells. */
export function plateLayout(spec, grid) {
  const { x: dx, y: dy } = spec.cartridge.dims;
  const maxD = Math.max(1, ...spec.channels.map((c) => c.diameter));
  const p = grid ? grid.pitch : maxD + spec.clearanceMin;
  const nx = grid ? grid.dims[0] : Math.ceil(dx / p), ny = grid ? grid.dims[1] : Math.ceil(dy / p);
  const o = grid ? grid.origin : [-(nx * p) / 2, -(ny * p) / 2, 0];
  const mc = Math.ceil(spec.plate.margin / p);
  const i0 = -mc, i1 = nx - 1 + mc, j0 = -mc, j1 = ny - 1 + mc;
  return {
    p, o, nx, ny, mc, i0, i1, j0, j1,
    gridExtent: { x0: o[0], x1: o[0] + nx * p, y0: o[1], y1: o[1] + ny * p },
    extent: { x0: o[0] + i0 * p, x1: o[0] + (i1 + 1) * p, y0: o[1] + j0 * p, y1: o[1] + (j1 + 1) * p },
  };
}

/**
 * Frame parts for the current mode. Every post carries the inward faces a bridge strut may land
 * on ({ axis, dir, face }: the face is the plane x[axis] = face, `dir` points from the tubes
 * towards the frame). Rails are structural only.
 *   posts – four corner posts (side `s`)
 *   rim   – posts + a top rim of thickness `s` (spans the whole side – FDM needs supports)
 *   fence – posts + a t×t picket at every grid column/row along all four sides + a `t` top rim.
 *           Pickets are what tubes get bridged to, and they keep every rim span ≤ one pitch.
 * `span` is the longest unsupported horizontal frame member (for the printability warning).
 */
export function frameLayout(spec, pl) {
  const mode = frameMode(spec);
  if (mode === 'none') return null;
  const { p, o, nx, ny, extent: { x0, x1, y0, y1 } } = pl;
  const s = clamp(spec.plate.margin - 1, 3, 8), t = Math.min(s, 3), inset = POST_INSET, dz = spec.cartridge.dims.z;
  const xa = x0 + inset, xb = x1 - inset, ya = y0 + inset, yb = y1 - inset;   // frame envelope
  const post = (min, max, faces) => ({ min, max, faces });
  const posts = [
    post([xa, ya, 0], [xa + s, ya + s, dz], [{ axis: 0, dir: -1, face: xa + s }, { axis: 1, dir: -1, face: ya + s }]),
    post([xb - s, ya, 0], [xb, ya + s, dz], [{ axis: 0, dir: 1, face: xb - s }, { axis: 1, dir: -1, face: ya + s }]),
    post([xb - s, yb - s, 0], [xb, yb, dz], [{ axis: 0, dir: 1, face: xb - s }, { axis: 1, dir: 1, face: yb - s }]),
    post([xa, yb - s, 0], [xa + s, yb, dz], [{ axis: 0, dir: -1, face: xa + s }, { axis: 1, dir: 1, face: yb - s }]),
  ];
  const rails = [];
  let span = 0;
  const rim = (w) => {                       // top rim of thickness/height w between the corner posts
    rails.push(
      { min: [xa + s, ya, dz - w], max: [xb - s, ya + w, dz] },
      { min: [xa + s, yb - w, dz - w], max: [xb - s, yb, dz] },
      { min: [xa, ya + s, dz - w], max: [xa + w, yb - s, dz] },
      { min: [xb - w, ya + s, dz - w], max: [xb, yb - s, dz] },
    );
  };
  if (mode === 'rim') { rim(s); span = Math.max(xb - xa, yb - ya) - 2 * s; }
  if (mode === 'fence') {
    for (let i = 0; i < nx; i++) {
      const cx = o[0] + (i + 0.5) * p;
      if (cx - t / 2 < xa + s || cx + t / 2 > xb - s) continue;
      posts.push(post([cx - t / 2, ya, 0], [cx + t / 2, ya + t, dz], [{ axis: 1, dir: -1, face: ya + t }]));
      posts.push(post([cx - t / 2, yb - t, 0], [cx + t / 2, yb, dz], [{ axis: 1, dir: 1, face: yb - t }]));
    }
    for (let j = 0; j < ny; j++) {
      const cy = o[1] + (j + 0.5) * p;
      if (cy - t / 2 < ya + s || cy + t / 2 > yb - s) continue;
      posts.push(post([xa, cy - t / 2, 0], [xa + t, cy + t / 2, dz], [{ axis: 0, dir: -1, face: xa + t }]));
      posts.push(post([xb - t, cy - t / 2, 0], [xb, cy + t / 2, dz], [{ axis: 0, dir: 1, face: xb - t }]));
    }
    rim(t); span = p;
  }
  return { mode, s, t, posts, rails, span };
}