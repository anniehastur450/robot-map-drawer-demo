import { h, attr, events } from './dom-helper.js';
import { mergeSolver } from './merge-solver.js';

const fallbackConfig = {
  mapImgUrl: null, //  required
  mapSize: null, // required, [w, h]
  bgColor: '#222',
  // resize: false,
  unit: 'm',
  // units: {
  //   km: [1000, 'm'],
  //   m: [100, 'cm'],
  //   cm: [10, 'mm'],
  // }, // TODO: support unit conversion
  scaleBarPx: 100, // scale bar size is arround this value
  zooms: [
    5, 10, 15, /*
     */ 25, 33, 50, 67, 75, 80, 90, 100, 110, /*
     */ 125, 150, 175, 200, 250, 300, 400, 500, /*
     */ 750, 1000, 1500, 2000,
  ],
  /* inertia dragging related */

  /* merging related */
  mergingPx: 32,
  markerSizePx: 16, // size for merge cover to cover
  coverMethod: 'simple', // 'simple', 'smallest', 'mean' or 'median'
};

/* calculate cursor velocity in last [ms] ms */
function calculateVelocity(trails, ms) {
  // trails: [x, y, t]...
  let dt = 0;
  let [dx, dy] = [0, 0];
  for (let i = trails.length - 2; i >= 0; i--) {
    const [x2, y2, t2] = trails[i + 1];
    const [x, y, t] = trails[i];
    if (dt + (t2 - t) < ms) {
      dt += t2 - t;
      dx += x2 - x;
      dy += y2 - y;
    } else {
      const ddt = ms - dt;
      dt += ddt;
      dx += (ddt / (t2 - t)) * (x2 - x);
      dy += (ddt / (t2 - t)) * (y2 - y);
      break;
    }
  }
  // this is a upper cap for speed (min dt 1 ms),
  // and also avoid the situation when dt = 0
  dt = Math.max(1, dt);
  return {
    dt,
    dx,
    dy,
    velocity: Math.hypot(dx, dy) / dt,
    velocityX: dx / dt,
    velocityY: dy / dt,
  };
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

// TODO use it
// function comparePrevious(previous, next) {
//   const changes = {};
//   for (const [k, v] of Object.entries(next)) {
//     changes[k] = this.previous[k] !== v;
//   }
//   changes.any = (...keys) => {
//     if (keys.length === 0) keys = next.keys();
//     return keys.some((k) => changes[k]);
//   };
//   return {
//     changes,
//     updatePrevious: () => {
//       for (const [k, v] of Object.entries(next)) {
//         this.previous[k] = v;
//       }
//     },
//   };
// }

class RobotMapDrawer {
  constructor(config) {
    this.config = { ...fallbackConfig, ...config };
    this.camera = {
      zoom: 100,
      offset: [0, 0], // [x, y] in meters
    };
    this.doms = {};
    this.ratios = {};
    this.viewAnimations = null;
  }
  zoomFit() {
    this.viewAnimations?.stop();
    // reset camera
    this.camera.offset = [0, 0];
    this.setZoom(100);
  }
  findZoomLevel(zoom) {
    const zooms = this.config.zooms;
    const prev = zooms.findLast((x) => x < zoom) ?? zooms[0];
    const next = zooms.find((x) => x > zoom) ?? zooms[zooms.length - 1];
    return {
      prev,
      next,
    };
  }
  setZoom(next, cursor) {
    if (!this.doms.zoomInput.disabled) {
      // cancel editing
      this.doms.zoomInput.disabled = true;
    }
    let [dx, dy] = [0, 0];
    if (cursor) {
      const curr = this.camera.zoom;
      const [cx, cy] = cursor;
      dx = -(cx / this.zoomedRatioScreenPx) * (1 - curr / next);
      dy = -(cy / this.zoomedRatioScreenPx) * (1 - curr / next);
    }
    this.camera.offset[0] += dx;
    this.camera.offset[1] += dy;
    this.camera.zoom = next;
    this.updateCamera();
  }
  zoomIn(cursor = null) {
    const { next } = this.findZoomLevel(this.camera.zoom);
    this.setZoom(next, cursor);
  }
  zoomOut(cursor = null) {
    const { prev } = this.findZoomLevel(this.camera.zoom);
    this.setZoom(prev, cursor);
  }
  get zoomedRatioScreenPx() {
    return (this.ratios.screenPxByMapUnit * this.camera.zoom) / 100;
  }
  registerEl(el) {
    this.doms.el = el;
    const [mapW, mapH] = this.config.mapSize;
    const resizeObserver = new ResizeObserver((entries) => {
      const rect = el.getBoundingClientRect(); // clientWidth x clientHeight but with floating point
      const [w, h] = [rect.width, rect.height];
      const aspectW = Math.min(w, (h / mapH) * mapW);
      const aspectH = (aspectW / mapW) * mapH;
      el.style.setProperty('--ref-w', `${w}px`);
      el.style.setProperty('--ref-h', `${h}px`);
      el.style.setProperty('--aspect-w', `${aspectW}px`);
      el.style.setProperty('--aspect-h', `${aspectH}px`);
      this.ratios.screenPxByMapUnit = aspectW / mapW;
      this.updateCamera();
    });
    resizeObserver.observe(el);
  }
  updateCamera() {
    if (!this.ratios.screenPxByMapUnit /* 0 is also invalid */) {
      return;
    }
    const el = this.doms.camera;
    const [mapW, mapH] = this.config.mapSize;
    const [x, y] = this.camera.offset;
    el.getAnimations({ subtree: true }).forEach((x) => {
      if (x.transitionProperty === 'transform') {
        x.finish();
      }
    });
    el.style.setProperty('--x', `${(x / mapW) * this.camera.zoom}%`);
    el.style.setProperty('--y', `${(y / mapH) * this.camera.zoom}%`);
    el.style.setProperty('--s', `${this.camera.zoom / 100}`);
    this.doms.zoom.textContent = `${this.camera.zoom}%`;
    this.updateScaleBar();
    this.markerList.updateMarkerCamera();
  }
  updateScaleBar() {
    const { scaleBar, scaleText } = this.doms;
    let st = this.config.scaleBarPx / this.zoomedRatioScreenPx;
    // round to 0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000
    // TODO: support unit conversion
    const list = [
      0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, /*
       */ 100, 200, 500, 1000, 2000, 5000,
    ];
    let closest = list.reduce(function (prev, curr) {
      return Math.abs(curr - st) < Math.abs(prev - st) ? curr : prev;
    });
    scaleBar.style.setProperty(
      '--scale-bar',
      `${closest * this.zoomedRatioScreenPx}px`
    );
    scaleText.textContent = `${closest} ${this.config.unit}`;
  }
  /* other names: kinetic scrolling */
  startInertiaDragging(velocityX, velocityY) {
    const request = (x) => requestAnimationFrame(x);
    const cancel = (x) => cancelAnimationFrame(x);
    this.viewAnimations?.stop();
    const brakingTime = 750; // ms
    let [sx, sy] = [Math.sign(velocityX), Math.sign(velocityY)];
    let [vx, vy] = [Math.abs(velocityX), Math.abs(velocityY)];
    let [ax, ay] = [-vx / brakingTime, -vy / brakingTime];
    const timeout = () => {
      const t2 = performance.now();
      const dt = t2 - t1;
      vx = Math.max(0, vx + ax * dt);
      vy = Math.max(0, vy + ay * dt);
      let [x, y] = this.camera.offset;
      x += (vx * sx * dt) / this.zoomedRatioScreenPx;
      y += (vy * sy * dt) / this.zoomedRatioScreenPx;
      this.camera.offset = [x, y];
      this.updateCamera();
      let v = Math.hypot(vx, vy);
      if (v > 0) {
        t1 = t2;
        timer = request(timeout);
      }
    };
    let t1 = performance.now();
    let timer = request(timeout);
    this.viewAnimations = {
      stop: () => {
        cancel(timer);
        this.viewAnimations = null;
      },
    };
  }
  trySetZoom(zoomString) {
    let zoom = parseFloat(zoomString);
    if (!isNaN(zoom) && zoom) {
      const zooms = this.config.zooms;
      const min = zooms[0];
      const max = zooms[zooms.length - 1];
      zoom = clamp(zoom, min, max);
      this.setZoom(zoom);
    } else {
      this.setZoom(this.camera.zoom); // reset zoom text
    }
  }
  attach(target) {
    h`
      <div class="w-full h-full b b-solid b-gray-200 relative font-sans">

        <!-- zoom buttons -->
        <div class="absolute top-1 left-1 text-gray">
          <div class="flex shadow rounded overflow-hidden z-50 relative">
            <button title="zoom fit" class="btn w-6 h-6 bg-white hover:text-gray-500 flex justify-center items-center"
            ${events({ click: () => this.zoomFit() })} >
              <i class="fas fa-expand"></i>
            </button>
            <button title="edit zoom level" class="btn h-6 bg-white hover:text-gray-500 b-l b-l-solid b-l-gray-200 flex justify-center items-center px-1"
            ${attr((el) => (this.doms.zoom = el))}
            ${events({
              click: () => {
                this.doms.zoomInput.disabled = false;
              },
            })} >
              100%
            </button>
            <input value="100%" class="w-[var(--zoom-w)] btn h-6 bg-white text-gray-500 absolute right-0 text-center"
            ${attr((el) => {
              this.doms.zoomInput = el;
              const observer = new MutationObserver(() => {
                if (el.disabled) {
                  el.classList.add('invisible');
                  el.style.setProperty('--zoom-w', '0');
                } else {
                  const rect = this.doms.zoom.getBoundingClientRect();
                  el.classList.remove('invisible');
                  el.style.setProperty('--zoom-w', `${rect.width}px`);
                  el.value = this.doms.zoom.textContent;
                  el.focus();
                  el.select();
                }
              });
              observer.observe(el, {
                attributeFilter: ['disabled'],
              });
              el.disabled = true;
            })}
            ${events({
              blur: () => {
                if (!this.doms.zoomInput.disabled) {
                  this.trySetZoom(this.doms.zoomInput.value);
                }
              },
              keydown: (e) => {
                if (e.key === 'Enter') {
                  this.trySetZoom(this.doms.zoomInput.value);
                }
                if (e.key === 'Escape') {
                  this.setZoom(this.camera.zoom); // reset zoom text
                }
              },
              input: () => {
                const el = this.doms.zoom;
                const zoomInput = this.doms.zoomInput;
                el.textContent = zoomInput.value;
                const rect = el.getBoundingClientRect();
                zoomInput.style.setProperty('--zoom-w', `${rect.width}px`);
              },
            })} >
          </div>
          <div class="mt-1 w-fit shadow rounded overflow-hidden z-50 relative">
            <button title="zoom in" class="btn w-6 h-6 bg-white hover:text-gray-500 flex justify-center items-center"
            ${events({ click: () => this.zoomIn() })} >
              <i class="fas fa-plus"></i>
            </button>
            <button title="zoom out" class="btn b-t b-t-solid b-t-gray-200 w-6 h-6 bg-white hover:text-gray-500 flex justify-center items-center"
            ${events({ click: () => this.zoomOut() })} >
              <i class="fas fa-minus"></i>
            </button>
          </div>
        </div>

        <!-- drag panel -->
        <div class="absolute w-full h-full z-40 select-none"
        ${events({
          mousedown: (e) => {
            this.viewAnimations?.stop();
            // do not use preventDefault() to avoid selection, use select-none instead,
            // otherwise no mouse event when cursor outside iframe
            let [prevX, prevY] = [e.clientX, e.clientY];
            const trails = [[prevX, prevY, performance.now()]];
            e.target.style.cursor = 'move';
            const mousemove = (e) => {
              const [x, y] = [e.clientX, e.clientY];
              this.camera.offset[0] += (x - prevX) / this.zoomedRatioScreenPx;
              this.camera.offset[1] += (y - prevY) / this.zoomedRatioScreenPx;
              this.updateCamera();
              [prevX, prevY] = [x, y];
              trails.push([prevX, prevY, performance.now()]);
            };
            const mouseup = (e) => {
              trails.push([e.clientX, e.clientY, performance.now()]);
              const { velocity, velocityX, velocityY } =
                /* */ calculateVelocity(trails, 50);
              if (velocity > 0) {
                this.startInertiaDragging(velocityX, velocityY);
              }
              e.target.style.cursor = '';
              window.removeEventListener('mousemove', mousemove);
              window.removeEventListener('mouseup', mouseup);
            };
            window.addEventListener('mousemove', mousemove);
            window.addEventListener('mouseup', mouseup);
          },
          wheel: (e) => {
            this.viewAnimations?.stop();
            e.preventDefault();
            const rect = e.target.getBoundingClientRect();
            const [x, y] = [e.clientX - rect.left, e.clientY - rect.top];
            const cx = x - rect.width / 2;
            const cy = y - rect.height / 2;
            if (e.deltaY < 0) {
              this.zoomIn([cx, cy]);
            } else if (e.deltaY > 0) {
              this.zoomOut([cx, cy]);
            }
          },
          mousemove: (e) => {
            // TODO: use this
            const rect = e.target.getBoundingClientRect();
            const [x, y] = [e.clientX - rect.left, e.clientY - rect.top];
            const cx = x - rect.width / 2;
            const cy = y - rect.height / 2;
            let [mapX, mapY] = this.camera.offset;
            [mapX, mapY] = [-mapX, -mapY];
            mapX += cx / this.zoomedRatioScreenPx;
            mapY += cy / this.zoomedRatioScreenPx;
            // console.log(mapX, mapY);
          },
        })} >
        </div>

        <!-- camera and view -->
        <div class="absolute w-full h-full bg-[var(--bg)] flex justify-center items-center overflow-hidden"
        ${attr((el) => el.style.setProperty('--bg', this.config.bgColor))} >
          <div class="w-[var(--aspect-w)] h-[var(--aspect-h)] relative">
            <div class="absolute w-full h-full transition-transform translate-x-[var(--x)] translate-y-[var(--y)] scale-[var(--s)]"
            ${attr((el) => (this.doms.camera = el))} >
              <img width="0" height="0" class="absolute w-full h-full"
              ${attr((el) => (el.src = this.config.mapImgUrl))} >

              <!-- marker layer -->
              ${this.markerList.getEl()}

            </div>
          </div>
        </div>

        <!-- scale bar -->
        <div class="absolute bg-white/50 px-1 bottom-2 right-2 z-50 pointer-events-none">
          <div class="flex items-center">
            <div class="w-[var(--scale-bar)] transition-width h-2 mt-1 b-2 b-solid b-black b-t-none"
            ${attr((el) => (this.doms.scaleBar = el))} ></div>
            <div class="ml-1"
            ${attr((el) => (this.doms.scaleText = el))} >1km</div>
          </div>
        </div>

      </div>
    `
      .let((el) => this.registerEl(el))
      .attach(target);
  }

  //////////////////////////////////////////////////////
  /* marker list and helper functions for marker list */
  //////////////////////////////////////////////////////

  markerList = new MarkerList(this);
}

//////////////////////// MARKER LIST ////////////////////////

const fallbackListViewOptions = {
  /*
    origin:
      * top-left
      * top
      * top-right
      * left
      * center
      * right
      * bottom-left
      * bottom
      * bottom-right
   */
  origin: 'center',
  '+x': 'right', // left or right
  '+y': 'top', // top or bottom. for math axis, it is top, for computer screen axis, it is bottom
};

// TODO use it
// class Emitter {
//   // https://stackoverflow.com/questions/22186467/how-to-use-javascript-eventtarget
//   constructor() {
//     var delegate = document.createDocumentFragment();
//     ['addEventListener', 'dispatchEvent', 'removeEventListener'].forEach(
//       (f) => (this[f] = (...xs) => delegate[f](...xs))
//     );
//   }
// }

class MarkerList {
  constructor(drawer) {
    this.drawer = drawer;
    this.pending = null;
    this.doms = {};
    this.nextId = 0;
    this.markers = new Map();
    this.cached = {
      markerExtra: new Map(),
    };
  }
  getListView(options) {
    return new MarkerListView(this, options);
  }
  getEl() {
    if (this.doms.el) {
      throw new Error('assert false');
    }
    return h`
      <div class="absolute w-full h-full">
        <div class="absolute w-full h-full"
        ${attr((el) => (this.doms.markers = el))} ></div>
        <div class="absolute w-full h-full"
        ${attr((el) => (this.doms.covers = el))} ></div>
      </div>
    `.let((el) => (this.doms.el = el));
  }
  solveMerging() {
    const zoomed = this.drawer.zoomedRatioScreenPx;
    const markers = [...this.markers.values()];
    const points = markers.map(({ x, y }) => [x, y]);
    const merging = this.drawer.config.mergingPx / zoomed;
    const solved = mergeSolver(points, merging, {
      minimumCoverDiameter: merging,
      coverExtraRadius: this.drawer.config.markerSizePx / zoomed,
      coverMethod: this.drawer.config.coverMethod,
    });
    return {
      remains: solved.remains.map((i) => markers[i].id),
      covers: solved.covers.map(({ indexes, circle }) => ({
        ids: indexes.map((i) => markers[i].id),
        circle,
      })),
    };
  }
  previousMarkerDifferences() {
    const prev = new Set(this.cached.markerDoms.keys());
    const curr = new Set(this.markers.keys());
    const removed = new Set(); // in prev, not in curr
    for (const id of prev) {
      if (curr.has(id)) {
        curr.delete(id);
      } else {
        removed.add(id);
      }
    }
    return {
      added: curr, // remaining of (curr - prev)
      removed,
    };
  }
  getMarkerDom(root) {
    const el = h`
      <div class="absolute -translate-1/2 scale-[calc(1/var(--s))] left-[var(--x)] top-[var(--y)] transition-transform,opacity,top,left opacity-[var(--op)] bg-amber/50"></div>
    `.el;
    const handle = {
      el,
      update: (marker, opacity) => {
        const [mapW, mapH] = this.drawer.config.mapSize;
        const { name, x, y, color } = marker; // TODO color
        el.textContent = name;
        // why use % instead of px? answer: avoid transition animation when changing aspect
        el.style.setProperty('--x', `${(x / mapW) * 100 + 50}%`);
        el.style.setProperty('--y', `${(y / mapH) * 100 + 50}%`);
        el.style.setProperty('--op', `${opacity}`);
        return handle;
      },
      attach: () => {
        root.appendChild(el);
        return handle;
      },
      detach: () => {
        el.remove();
        return handle;
      },
    };
    return handle;
  }
  getCoverDom(root2) {
    const el = h`
      <div class="absolute -translate-1/2 w-[32px] h-[32px] scale-[var(--cs)] left-[var(--x)] top-[var(--y)] transition-transform,opacity opacity-[var(--op)] rounded-full bg-blue/50 flex justify-center items-center text-slate-700" ></div>
    `.el;
    const handle = {
      el,
      update: (cover) => {
        const [mapW, mapH] = this.drawer.config.mapSize;
        const [x, y, r] = cover.circle;
        el.textContent = `${cover.ids.length}`;
        const baseD = 32; // 32px, same to the h above
        const cs = (r * 2 * this.drawer.ratios.screenPxByMapUnit) / baseD;
        el.style.setProperty('--cs', `${cs}`);
        el.style.setProperty('--x', `${(x / mapW) * 100 + 50}%`);
        el.style.setProperty('--y', `${(y / mapH) * 100 + 50}%`);
        return handle;
      },
      /* attach with fade in */
      attach: () => {
        el.style.setProperty('--op', `${0}`);
        root2.appendChild(el);
        // make sure transition is triggered
        const observer = new ResizeObserver((entries) => {
          el.style.setProperty('--op', `${1}`);
          observer.disconnect();
        });
        observer.observe(el);
        return handle;
      },
      /* detach with fade out */
      detach: () => {
        el.style.setProperty('--op', `${0}`);
        const timer = setTimeout(() => {
          // fallback remove action
          console.warn('transitionend is not triggered');
          el.remove();
        }, 5000);
        el.addEventListener('transitionend', (e) => {
          if (e.propertyName === 'opacity') {
            el.remove();
            clearTimeout(timer);
          }
        });
        return handle;
      },
    };
    return handle;
  }
  updateMarkerDomTree() {
    const curr = new Set(this.markers.keys());
    for (const id of [...this.cached.markerExtra.keys()]) {
      if (curr.has(id)) {
        curr.delete(id); // exist in both prev and curr
      } else {
        // removed from curr
        this.cached.markerExtra.get(id).detach();
        this.cached.markerExtra.delete(id);
      }
    }
    for (const id of curr) {
      // newly added to curr
      const handle = this.getMarkerDom(this.doms.markers).attach();
      this.cached.markerExtra.set(id, handle);
    }
  }
  findUnchangedCovers(prevCovers, covers) {
    // unchange if both ids is equals ignore order
    const res = [];
    covers = new Set(covers);
    for (const p of prevCovers ?? []) {
      for (const c of covers) {
        const equals =
          p.ids.length === c.ids.length &&
          new Set([...p.ids, ...c.ids]).size === p.ids.length;
        if (equals) {
          res.push([p, c]);
          covers.delete(c);
          break;
        }
      }
    }
    return res;
  }
  updateMarkerCamera() {
    this.updateMarkerDomTree();
    const solved = this.solveMerging();

    // update all markers
    const remains = new Set(solved.remains);
    for (const [id, handle] of this.cached.markerExtra) {
      const opacity = remains.has(id) ? 1 : 0;
      handle.update(this.markers.get(id), opacity);
    }

    // update all covers
    const unchanged = this.findUnchangedCovers(
      this.cached.prevCovers,
      solved.covers
    );
    const detaching = new Set(this.cached.prevCovers);
    const attaching = new Set(solved.covers);
    for (const [p, c] of unchanged) {
      c.handle = p.handle.update(c);
      detaching.delete(p);
      attaching.delete(c);
    }
    for (const p of detaching) {
      p.handle.detach();
    }
    for (const c of attaching) {
      c.handle = this.getCoverDom(this.doms.covers).update(c).attach();
    }
    this.cached.prevCovers = solved.covers;
  }
  setPendingUpdate() {
    // call updateCamera once for multiple addMarker in sync calls
    if (this.pending == null) {
      this.pending = setTimeout(() => {
        this.pending = null;
        this.drawer.updateCamera();
      });
    }
  }
  addMarker(id, marker) {
    if (id == null) {
      id = this.nextId;
      this.nextId++;
    }
    this.markers.set(id, { ...marker, id });
    this.setPendingUpdate();
  }
}

function invalidArgument(x) {
  throw new Error(`invalid argument: ${x}`);
}

function parseOrigin(mapW, mapH, origin) {
  const [x0, x1, x2] = [-mapW / 2, 0, mapW / 2];
  const [y0, y1, y2] = [-mapH / 2, 0, mapH / 2];
  return (
    {
      ['top-left']: /*        */ [x0, y0],
      ['top']: /*             */ [x1, y0],
      ['top-right']: /*       */ [x2, y0],
      ['left']: /*            */ [x0, y1],
      ['center']: /*          */ [x1, y1],
      ['right']: /*           */ [x2, y1],
      ['bottom-left']: /*     */ [x0, y2],
      ['bottom']: /*          */ [x1, y2],
      ['bottom-right']: /*    */ [x2, y2],
    }[origin] ?? invalidArgument(origin)
  );
}

class MarkerListView {
  constructor(mainList, options) {
    this.mainList = mainList;
    this.options = { ...fallbackListViewOptions, ...options };
    if (typeof this.options.origin === 'string') {
      const [mapW, mapH] = this.mainList.drawer.config.mapSize;
      this.options.origin = parseOrigin(mapW, mapH, this.options.origin);
    }
    this.X =
      {
        left: -1,
        right: 1,
      }[this.options['+x']] ?? invalidArgument(this.options['+x']);
    this.Y =
      {
        top: -1,
        bottom: 1,
      }[this.options['+y']] ?? invalidArgument(this.options['+x']);
  }
  toUserLocation(internalLocation) {
    // A = loc, C = map center, O = user origin (in internal axis)
    // want: OA (user), known: CA (internal), CO (origin)
    // OA = OC + CA = -(CO) + CA
    // to convert to user loc, just times '+x' and '+y'
    const [CA_x, CA_y] = internalLocation;
    const [CO_x, CO_y] = this.options.origin;
    let [OA_x, OA_y] = [CA_x - CO_x, CA_y - CO_y];
    OA_x *= this.X;
    OA_y *= this.Y;
    return [OA_x, OA_y];
  }
  toInternalLocation(userLocation) {
    // OA = CA - CO, CA = OA + CO
    let [OA_x, OA_y] = userLocation;
    OA_x *= this.X;
    OA_y *= this.Y;
    const [CO_x, CO_y] = this.options.origin;
    const [CA_x, CA_y] = [OA_x + CO_x, OA_y + CO_y];
    return [CA_x, CA_y];
  }
  add(id, { name, x, y, color }) {
    const [x2, y2] = this.toInternalLocation([x, y]);
    this.mainList.addMarker(id, {
      name,
      x: x2,
      y: y2,
      color,
    });
  }
}

export { RobotMapDrawer };
