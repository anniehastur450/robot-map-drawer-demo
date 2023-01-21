function centroid(points) {
  let [xs, ys] = [0, 0];
  for (const [x, y] of points) {
    xs += x;
    ys += y;
  }
  return [xs / points.length, ys / points.length];
}

function averageDistance(points) {
  const [xs, ys] = centroid(points);
  let d = 0;
  for (const [x, y] of points) {
    d += Math.hypot(x - xs, y - ys);
  }
  return d / points.length;
}

/* calculate cursor velocity in last [ms] ms */
function calculateVelocity(trails, ms) {
  // trails: [t, x, y]... (or [t, x, y, zoom]...)
  let dt = 0;
  let dv = []; // unknown length, depends on trails
  for (let i = trails.length - 2; i >= 0; i--) {
    const [t2, ...v2] = trails[i + 1];
    const [t, ...v] = trails[i];
    if (dt + (t2 - t) < ms) {
      dt += t2 - t;
      for (let j = 0; j < v.length; j++) {
        dv[j] = (dv[j] ?? 0) + v2[j] - v[j];
      }
    } else {
      const ddt = ms - dt;
      const s = ddt / (t2 - t);
      dt += ddt;
      for (let j = 0; j < v.length; j++) {
        dv[j] = (dv[j] ?? 0) + s * (v2[j] - v[j]);
      }
      break;
    }
  }
  // this is the minimum time frame could be (1 ms),
  // avoid the situation when dt = 0
  dt = Math.max(1, dt);
  return {
    dt,
    dv, // maybe [x, y, zoom]
    v: dv.map((x) => x / dt), // maybe [vx, vy, vzoom]
  };
}

class Panning {
  constructor(zoom, offset) {
    // zoom: 100, offset: [x, y]
    this.zoom = zoom;
    this.offset = offset.slice();
    this.pointers = new Map();
    this.trails = [];
  }
  calculateVelocity(ms) {
    return calculateVelocity(this.trails, ms);
  }
  // pointer start
  start(id, [rx, ry], t) {
    this.pointers.set(id, { rx, ry });
    this.trails.push([t, ...this.offset, this.zoom]);
  }
  // pointer move
  move(id, [rx, ry], t) {
    const pv = [...this.pointers.values()].map(({ rx, ry }) => [rx, ry]);
    const p = this.pointers.get(id);
    const [dx, dy] = [rx - p.rx, ry - p.ry];
    Object.assign(p, { rx, ry });
    const v = [...this.pointers.values()].map(({ rx, ry }) => [rx, ry]);
    const pd = averageDistance(pv);
    const d = averageDistance(v);
    let scale = d / pd;
    if (!isFinite(scale) || isNaN(scale)) {
      scale = 1;
    }
    this.offset[0] -= dx / this.pointers.size / (this.zoom / 100);
    this.offset[1] -= dy / this.pointers.size / (this.zoom / 100);
    this.setZoom(this.zoom * scale, centroid(v));
    this.trails.push([t, ...this.offset, this.zoom]);
  }
  // pointer end
  end(id) {
    this.pointers.delete(id);
  }
  setZoom(zoom, [rx, ry]) {
    const s = (1 / this.zoom - 1 / zoom) * 100;
    this.offset[0] += rx * s;
    this.offset[1] += ry * s;
    this.zoom = zoom;
  }
}

function startPanning(zoom, offset) {
  return new Panning(zoom, offset);
}

export { startPanning };
