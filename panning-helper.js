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
  for (let i = trails.length - 2; dt < ms && i >= 0; i--) {
    const [t2, ...v2] = trails[i + 1];
    const [t, ...v] = trails[i];
    const ddt = Math.min(t2 - t, ms - dt);
    const s = ddt > 0 ? ddt / (t2 - t) : 1; // avoid 0/0
    dt += ddt;
    for (let j = 0; j < v.length; j++) {
      dv[j] = (dv[j] ?? 0) + s * (v2[j] - v[j]);
    }
  }
  // this is the minimum time that could be (1 ms),
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
    this.pinchOrigin = null; // saved for calculate velocity to use, this is screen sign
  }
  recordTrails(t) {
    this.trails.push([t, ...this.offset, this.zoom]);
  }
  calculateVelocity(ms, parse = true) {
    const { dt, dv } = calculateVelocity(this.trails, ms);
    const c = [...this.offset, this.zoom];
    const p = dv.map((v, i) => c[i] - v);
    const [x0, y0, z0, x1, y1, z1] = [p, c]
      .flatMap(([x, y, z]) => [x * z, y * z, z])
      .map((x) => x / 100);
    const unparsed = { dt, data: [x0, y0, z0, x1, y1, z1] };
    return parse ? this.parseInertia(unparsed) : parse;
  }
  parseInertia(unparsed) {
    const { dt } = unparsed;
    const [x0, y0, z0, x1, y1, z1] = unparsed.data;
    // dt returned by calculateVelocity is always >= 1
    const b = (t) => (z1 / z0) ** (t / dt);
    const b_prime = (t) => Math.log(b(1)) * b(t); // b'(t)
    // s(t) = s_0 + (s_1 - s_0) / (z_1 / z_0 - 1) * (b ^ t - 1)
    const ds = Math.hypot(x1 - x0, y1 - y0);
    const vec = ds > 0 ? [(x1 - x0) / ds, (y1 - y0) / ds] : [0, 0];
    const s = (t) => {
      const mag = ds * (z0 === z1 ? t / dt : (b(t) - 1) / (z1 / z0 - 1));
      return [x0 + mag * vec[0], y0 + mag * vec[1]];
    };
    // v(t) = s'(t) = (s_1 - s_0) / (z_1 / z_0 - 1) * ln(b) * b ^ t
    const v = (t) => {
      const mag = ds * (z0 === z1 ? 1 / dt : b_prime(t) / (z1 / z0 - 1));
      return [mag * vec[0], mag * vec[1]];
    };
    const z = (t) => z0 * b(t);
    // zoom origin equals to s(-inf) for zoom in, or s(inf) for zoom out
    let zoomOrigin = null;
    if (z0 !== z1) {
      const [sx, sy] = s(Infinity * Math.sign(z0 - z1)); // this is map sign
      zoomOrigin = [-sx, -sy]; // match sign to pinch origin
    }
    return {
      dt,
      vec,
      b: b(1),
      zoomOrigin, // currently unused
      z: (t) => z(t + dt),
      v: (t) => v(t + dt),
      s: (t) => s(t + dt),
      data: [x0, y0, z0, x1, y1, z1],
      removeZoom: (pinchOrigin = this.pinchOrigin) => {
        // removing zoom need to take account of pinch origin and zoom origin to offset the correct velocity.
        // you can see reproduce this issue (when without speed correction) by zooming very large,
        // and zoom a little bit so that it below the zoom threshold, you can see it is unexpected panning
        const [px, py] = pinchOrigin;
        // const [zx, zy] = zoomOrigin;
        const p1 = [x1 + px, y1 + py];
        const p = Math.hypot(p1[0], p1[1]);
        const pvec = p > 0 ? [p1[0] / p, p1[1] / p] : [0, 0];
        // pinch speed
        const mag = ((1 - z0 / z1) * p) / dt;
        let [vx, vy] = v(dt);
        // speed correction of pinch
        vx -= mag * pvec[0];
        vy -= mag * pvec[1];
        {
          // overwrite variables
          const z0 = z1;
          const [x0, y0] = [x1 - vx * dt, y1 - vy * dt];
          return this.parseInertia({ dt, data: [x0, y0, z0, x1, y1, z1] });
        }
      },
    };
  }
  centroid() {
    const v = [...this.pointers.values()].map(({ rx, ry }) => [rx, ry]);
    return centroid(v);
  }
  averageDistance() {
    const v = [...this.pointers.values()].map(({ rx, ry }) => [rx, ry]);
    return averageDistance(v);
  }
  // pointer start
  start(id, [rx, ry], t) {
    if (this.pointers.has(id)) {
      console.warn(`err: start: ${id} still in list`);
    }
    this.pointers.set(id, { rx, ry });
    this.recordTrails(t);
  }
  // pointer move
  move(id, [rx, ry], t) {
    if (!this.pointers.has(id)) {
      console.warn(`err: move: ${id} not in list`);
    }
    const pd = this.averageDistance();
    const p = this.pointers.get(id);
    const [dx, dy] = [rx - p.rx, ry - p.ry];
    Object.assign(p, { rx, ry });
    this.offset[0] -= dx / this.pointers.size / (this.zoom / 100);
    this.offset[1] -= dy / this.pointers.size / (this.zoom / 100);
    if (this.pointers.size > 1) {
      // calc zoom
      const d = this.averageDistance();
      const c = this.centroid();
      const scale = pd > 0 ? d / pd : 1;
      this.setZoom(this.zoom * scale, c);
    }
    this.recordTrails(t);
  }
  // pointer end
  end(id, t) {
    if (!this.pointers.has(id)) {
      console.warn(`err: end: ${id} not in list`);
    }
    this.pointers.delete(id);
    this.recordTrails(t);
  }
  setZoom(zoom, [rx, ry]) {
    const s = (1 / this.zoom - 1 / zoom) * 100;
    this.offset[0] += rx * s;
    this.offset[1] += ry * s;
    this.pinchOrigin = [rx, ry];
    this.zoom = zoom;
  }
}

function startPanning(zoom, offset) {
  return new Panning(zoom, offset);
}

export { startPanning };
