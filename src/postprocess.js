// Stage 2½ (problem.md §4.8 step 3 + §6.5): cells → world centrelines, organic jitter, manifold
// port stubs through the plate, Chaikin smoothing, then frame‑bridge placement.

import { chaikin, add, sub, norm, dist, polylineLength } from './geom.js';
import { cellsToWorld } from './generators/common.js';
import { sectionProfiles } from './section.js';
import { plateLayout, frameLayout } from './layout.js';

/**
 * Produces ch.path (final centreline), ch.ports and ch.length.
 *
 * Only the in‑cartridge part of the path is smoothed: the port stubs (z ∈ [zPort, 0]) stay
 * exactly vertical so they line up with the holes in the manifold plate.
 */
export function postprocess(routing, spec, rng) {
  const zPort = -(spec.plate.thickness + spec.plate.barb);
  const maxD = Math.max(...spec.channels.map((c) => c.diameter));
  const slack = Math.max(0, spec.grid.pitch - maxD - spec.clearanceMin);
  const amp = spec.organic * (0.45 * slack + 0.2 * spec.clearanceMin); // validator reports any loss

  for (const ch of routing.channels) {
    const pts = ch.cells
      ? cellsToWorld(ch.cells, routing.grid)
      : (ch.centreline || []).map((p) => p.slice());
    if (pts.length < 2) {
      ch.path = [];
      ch.ports = null;
      ch.length = 0;
      continue;
    }
    if (amp > 0) {
      const a = amp / Math.sqrt(3);
      for (let i = 1; i + 1 < pts.length; i++) {
        // never move the port cells
        pts[i] = add(pts[i], [a * (2 * rng() - 1), a * (2 * rng() - 1), a * (2 * rng() - 1)]);
      }
    }
    const f = pts[0],
      l = pts[pts.length - 1];
    const inner = [[f[0], f[1], 0], ...pts];
    if (!ch.deadEnd) inner.push([l[0], l[1], 0]);
    const smooth = chaikin(inner, spec.smoothing); // endpoints are fixed by Chaikin
    const path = [[f[0], f[1], zPort], ...smooth];
    if (!ch.deadEnd) path.push([l[0], l[1], zPort]);
    ch.path = path;
    ch.length = polylineLength(path);
    ch.ports = { inlet: [f[0], f[1]], outlet: ch.deadEnd ? null : [l[0], l[1]] };
  }
  return routing;
}

/**
 * Frame bridges (problem.md §6.5 – "thin bridges at a few points, the only allowed contact").
 * For every tube point that lies in the outermost ring of grid cells and is level with a frame
 * post face, a bw×bw strut is laid horizontally from inside the tube wall to 0.3 mm inside the
 * post. Struts are only placed where the tube runs roughly parallel to the post face (so the
 * strut cannot run down the lumen), are kept ≥ bridgeSpacing/2 apart per channel, and cannot
 * cross another channel by construction: the space between an edge cell and the frame is the
 * tube's own cell plus the empty margin ring. The validator still checks them against every
 * other tube. Produces routing.bridges = [{ ch, axis, a, b, w }] (a = tube end, b = frame end).
 */
export function placeBridges(routing, spec) {
  routing.bridges = [];
  const pl = plateLayout(spec, routing.grid);
  const layout = frameLayout(spec, pl);
  const targets = [];
  for (const post of layout ? layout.posts : []) {
    for (const f of post.faces) {
      const other = 1 - f.axis;
      targets.push({
        ...f,
        other,
        lo: post.min[other],
        hi: post.max[other],
        zlo: post.min[2],
        zhi: post.max[2],
      });
    }
  }
  const p = pl.p,
    g = pl.gridExtent;
  const bw = Math.max(1.6, 2 * spec.printer.minWall); // strut side (mm)
  const minSep = 0.5 * Math.max(5, spec.bridgeSpacing || 20);
  const gridEdge = (axis, dir) => (axis === 0 ? (dir < 0 ? g.x0 : g.x1) : dir < 0 ? g.y0 : g.y1);

  for (const ch of routing.channels) {
    ch.bridges = 0;
    if (!targets.length || !ch.path || ch.path.length < 3) continue;
    const c = ch.spec,
      P = ch.path;
    const prof = sectionProfiles(c.section, c.diameter / 2, c.wall, 24);
    const embed = Math.max(0.3, prof.rMin - 0.5 * c.wall); // strut starts inside the wall
    const cands = [];
    for (let i = 1; i + 1 < P.length; i++) {
      const q = P[i];
      if (q[2] < c.diameter) continue; // leave the port stubs alone
      const T = norm(sub(P[i + 1], P[i - 1]));
      for (const tg of targets) {
        if (Math.abs(T[tg.axis]) > 0.5) continue; // strut would run down the lumen
        if (q[2] - bw / 2 < tg.zlo || q[2] + bw / 2 > tg.zhi) continue;
        if (q[tg.other] - bw / 2 < tg.lo || q[tg.other] + bw / 2 > tg.hi) continue; // would miss the post
        if (tg.dir * (gridEdge(tg.axis, tg.dir) - q[tg.axis]) - prof.rMin > p) continue; // not an edge tube
        const gap = tg.dir * (tg.face - q[tg.axis]) - prof.rMin; // tube surface → post face
        if (gap < 0.5) continue;
        const off = Math.abs(q[tg.other] - (tg.lo + tg.hi) / 2);
        cands.push({ q, tg, score: gap + 2 * off });
      }
    }
    cands.sort((u, v) => u.score - v.score);
    const placed = [];
    for (const { q, tg } of cands) {
      if (placed.some((r) => dist(r, q) < minSep)) continue;
      placed.push(q);
      const a = q.slice(),
        b = q.slice();
      a[tg.axis] += tg.dir * embed;
      b[tg.axis] = tg.face + tg.dir * 0.3; // 0.3 mm into the post
      routing.bridges.push({ ch: ch.id, axis: tg.axis, a, b, w: bw });
    }
    ch.bridges = placed.length;
    if (!ch.bridges && layout.mode === 'fence')
      ch.notes.push(
        'no frame bridge (never level with a fence picket within one pitch of the edge)'
      );
  }
  return routing;
}
