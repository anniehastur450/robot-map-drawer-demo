import { h, attr, events } from './dom-helper.js';
import { mergeSolver, distantSolver } from './merge-solver.js';
import { startPanning } from './panning-helper.js';

const fallbackConfig = {
  mapImgUrl: null, //  required
  mapSize: null, // required, [w, h]
  bgColor: '#222',
  unit: 'm',
  // units: {
  //   km: [1000, 'm'],
  //   m: [100, 'cm'],
  //   cm: [10, 'mm'],
  // }, // TODO: support unit conversion
  scaleBarPx: 100, // scale bar size is arround this value
  zoomLevels: [
    1, 2, 5, 10, 15, /*
     */ 25, 33, 50, 67, 75, 80, 90, 100, 110, /*
     */ 125, 150, 175, 200, 250, 300, 400, 500, /*
     */ 750, 1000, 1500, 2000, 3000, 4000, 5000,
  ],
  /* inertia dragging related */
  brakingTimeMs: 750,
  /* merging related */
  mergingPx: 32,
  // markerSizePx: 16, // size for merge cover to cover // not used
  coverMethod: 'simple', // 'simple', 'smallest', 'mean' or 'median'
  /* hover popup related */
  hoverPopupDelayMs: 750,
  focusingZoom: 100, // zoom level of clicking a marker
};

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function invalidAction(x) {
  throw new Error(`invalid action: ${x}`);
}

function customEventHooks() {
  function rootHook() {
    const hooks = [];
    const fn = (...args) => hooks.forEach((x) => x(...args));
    return Object.assign(fn, { hooks });
  }
  return {
    registerHooks(listeners) {
      for (const [type, listener] of Object.entries(listeners)) {
        (this[type] ?? (this[type] = rootHook())).hooks.push(listener);
      }
    },
  };
}

// to fix: animation is aborted when drawer size change

class RobotMapDrawer {
  constructor(config) {
    this.config = { ...fallbackConfig, ...config };
    this.camera = {
      /* how the camera move? the camera first focus to the offset point of the map, then zoom */
      zoom: 100,
      offset: [0, 0], // [x, y] in meters
    };
    this.doms = {
      ui: [], // for distant indicator to not being covered by ui
    }; // (no root), camera, map, zoom, zoomInput, scaleBar, scaleText
    this.ratios = {}; // screenPxByMapUnit
    this.panning = null; // panning
    this.inertiaAnimations = null;
    this.viewAnimations = null;
    // event hooks: preZoom, prePanning, postPanning, preInertia, postInertia, postRender, prePanMove
    this.eventHooks = customEventHooks();
    /* 
      attached data, key: el, value: dom handle
      hoverable has the following value: { 
          hoverable, // true (= active && !hidden)
          type,   // which type it is
          active, // element in tracking (therefore, false if element is being
                  //   to removed and still in disappearing animation)
          hidden, // tracking, but not visible (therefore not hoverable)
          ...extra data
        }
     */
    this.attachedData = new WeakMap(); // this is for elementsFromPoint to look up only
  }
  createPanning() {
    return startPanning(this.camera.zoom, this.camera.offset);
  }
  projectClientPoints(s = 0) {
    // s = 0: no zoom, s = 1: get screen point on map
    const rect = this.doms.camera.getBoundingClientRect();
    const x0 = rect.left + rect.width / 2;
    const y0 = rect.top + rect.height / 2;
    const [ox, oy] = this.camera.offset;
    const r = this.ratios.screenPxByMapUnit * (this.camera.zoom / 100) ** s;
    const mapper = ({ clientX, clientY }) => {
      const [u, v] = [clientX - x0, clientY - y0];
      return [s * ox + u / r, s * oy + v / r];
    };
    return mapper;
  }
  panStart(...pointers) {
    if (!this.panning) {
      this.inertiaAnimations?.stop();
      this.eventHooks.prePanning?.(); // pre panning event hook
      this.panning = this.createPanning();
    }
    const mapper = this.projectClientPoints();
    const t = performance.now();
    for (const [id, e] of pointers) {
      this.panning.start(id, mapper(e), t);
    }
  }
  panMove(...pointers) {
    this.eventHooks.prePanMove?.();
    const mapper = this.projectClientPoints();
    const t = performance.now();
    for (const [id, e] of pointers) {
      this.panning.move(id, mapper(e), t);
    }
    // update camera
    let zoom = this.panning.zoom;
    zoom = zoom > 10 ? Math.round(zoom) : parseFloat(zoom.toPrecision(3)); // round it to look better
    this.camera.offset = this.panning.offset.slice();
    this.camera.zoom = zoom;
    this.requestUpdateCamera();
  }
  panEnd(...pointers) {
    for (const [id] of pointers) {
      this.panning.end(id);
    }
    if (this.panning.pointers.size > 0) {
      return;
    }
    // do inertia
    const t = performance.now();
    const inertia = this.panning.calculateVelocity(t, 50);
    // const inertia = this.panning.calculateVelocity(t, 100); // give more time for touch panning
    // console.log(veloc);
    this.panning = null;
    this.eventHooks.postPanning?.(); // post panning event hook
    this.startInertiaDragging(inertia);

    // const [vx, vy] = veloc.v;
    // this.startInertiaDragging(
    //   -vx * this.zoomedRatioScreenPx,
    //   -vy * this.zoomedRatioScreenPx
    // );
  }
  zoomFit() {
    // reset camera
    this.camera.offset = [0, 0];
    this.setZoom(100);
  }
  findZoomLevel(zoom) {
    const zooms = this.config.zoomLevels;
    const prev = zooms.findLast((x) => x < zoom) ?? zooms[0];
    const next = zooms.find((x) => x > zoom) ?? zooms[zooms.length - 1];
    return {
      prev,
      next,
    };
  }
  setZoom(zoom, at = null) {
    this.inertiaAnimations?.stop();
    this.eventHooks.preZoom?.(); // pre zoom event hook
    // clamp zoom
    const [min] = this.config.zoomLevels;
    const [max] = this.config.zoomLevels.slice(-1);
    zoom = clamp(zoom, min, max);
    // use panning to help zooming
    const panning = this.panning ?? this.createPanning();
    panning.trails = []; // clear panning trails if any
    panning.setZoom(zoom, at ?? [0, 0]);
    this.camera.offset = panning.offset.slice();
    this.camera.zoom = zoom;
    this.requestUpdateCamera();
    // let [dx, dy] = [0, 0];
    // if (cursor) {
    //   const curr = this.camera.zoom;
    //   const [cx, cy] = cursor;
    //   dx = (cx / this.zoomedRatioScreenPx) * (1 - curr / next);
    //   dy = (cy / this.zoomedRatioScreenPx) * (1 - curr / next);
    // }
    // this.camera.offset[0] += dx;
    // this.camera.offset[1] += dy;
    // this.camera.zoom = next;
    // this.updateCamera();
    // this.eventHooks.zoomchange?.();
  }
  zoomIn(at = null) {
    const { next } = this.findZoomLevel(this.camera.zoom);
    this.setZoom(next, at);
  }
  zoomOut(at = null) {
    const { prev } = this.findZoomLevel(this.camera.zoom);
    this.setZoom(prev, at);
  }
  get zoomedRatioScreenPx() {
    return (this.ratios.screenPxByMapUnit * this.camera.zoom) / 100;
  }
  registerEl(el) {
    // panning hook for disable transition
    const disable = () => {
      el.classList.add('panning');
    };
    const enable = () => {
      el.classList.remove('panning');
    };
    this.eventHooks.registerHooks({
      preZoom: enable,
      prePanMove: disable,
    });
    // update when drawer resize
    const [mapW, mapH] = this.config.mapSize;
    const resizeObserver = new ResizeObserver((entries) => {
      // getBoundingClientRect includes the border!! get it via el is slightly wrong!!
      // get it via camera instead!!
      const rect = this.doms.camera.getBoundingClientRect(); // clientWidth x clientHeight but with floating point
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
  requestUpdateCamera() {
    // clamp zoom
    const [min] = this.config.zoomLevels;
    const [max] = this.config.zoomLevels.slice(-1);
    this.camera.zoom = clamp(this.camera.zoom, min, max);
    const update = () => {
      this._update = null;
      const el = this.doms.map;
      const [mapW, mapH] = this.config.mapSize;
      const [x, y] = this.camera.offset;
      el.style.setProperty('--x', `${(-x / mapW) * this.camera.zoom}%`);
      el.style.setProperty('--y', `${(-y / mapH) * this.camera.zoom}%`);
      el.style.setProperty('--s', `${this.camera.zoom / 100}`);
      this.doms.zoom.textContent = `${this.camera.zoom}%`;
      this.updateScaleBar();
      this.eventHooks.postRender?.();
    };
    this._update = this._update ?? requestAnimationFrame(update);
  }
  /* other names: kinetic scrolling */
  startInertiaDragging(inertia) {
    this.inertiaAnimations?.stop();
    console.log(inertia);
    const brakingTime = this.config.brakingTimeMs; // ms
    const [vx, vy] = inertia.v;
    // // min threshold 0.02 px/ms = 20 px/s (no need, use minimum a)
    // if (Math.hypot(vx, vy) < 0.02) {
    //   [vx, vy] = [0, 0];
    // }
    const vz = inertia.zoomVelocity - 1;
    const s = [vx, vy, vz].map((x) => Math.sign(x));
    const v = [vx, vy, vz].map((x) => Math.abs(x));
    const a = v.map((x) => -x / brakingTime);
    // min deceleration, it produces more stable result for touch screen users
    const minDecel = 500e-6 / this.zoomedRatioScreenPx; // minimum deceleration 500 px/s^2
    const decel = Math.hypot(a[0], a[1]);
    if (0 < decel && decel < minDecel) {
      a[0] = (a[0] / decel) * minDecel;
      a[1] = (a[1] / decel) * minDecel;
    }
    const timeout = () => {
      const t2 = performance.now();
      const dt = t2 - t1;
      for (let i = 0; i < v.length; i++) {
        v[i] = Math.max(0, v[i] + a[i] * dt);
      }
      this.camera.offset[0] += v[0] * s[0] * dt;
      this.camera.offset[1] += v[1] * s[1] * dt;
      this.camera.zoom *= 1 + v[2] * s[2] * dt;
      this.requestUpdateCamera();
      if (v.some((x) => x > 0)) {
        t1 = t2;
        timer = requestAnimationFrame(timeout);
      } else {
        // finished
        this.inertiaAnimations?.stop();
      }
    };
    let t1 = performance.now();
    let timer = requestAnimationFrame(timeout);
    this.inertiaAnimations = {
      stop: () => {
        cancelAnimationFrame(timer);
        this.inertiaAnimations = null;
      },
    };
  }
  updateCamera() {
    if (!this.ratios.screenPxByMapUnit /* 0 is also invalid */) {
      return;
    }
    const el = this.doms.map;
    const [mapW, mapH] = this.config.mapSize;
    const [x, y] = this.camera.offset;
    el.getAnimations({ subtree: true }).forEach((x) => {
      if (x.transitionProperty === 'transform') {
        x.finish();
      }
    });
    el.style.setProperty('--x', `${(-x / mapW) * this.camera.zoom}%`);
    el.style.setProperty('--y', `${(-y / mapH) * this.camera.zoom}%`);
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
  // startInertiaDragging(velocityX, velocityY) {
  //   const request = (x) => requestAnimationFrame(x);
  //   const cancel = (x) => cancelAnimationFrame(x);
  //   this.viewAnimations?.stop();
  //   const brakingTime = this.config.brakingTimeMs; // ms
  //   let [sx, sy] = [Math.sign(velocityX), Math.sign(velocityY)];
  //   let [vx, vy] = [Math.abs(velocityX), Math.abs(velocityY)];
  //   let [ax, ay] = [-vx / brakingTime, -vy / brakingTime];
  //   const timeout = () => {
  //     const t2 = performance.now();
  //     const dt = t2 - t1;
  //     vx = Math.max(0, vx + ax * dt);
  //     vy = Math.max(0, vy + ay * dt);
  //     let [x, y] = this.camera.offset;
  //     x -= (vx * sx * dt) / this.zoomedRatioScreenPx;
  //     y -= (vy * sy * dt) / this.zoomedRatioScreenPx;
  //     this.camera.offset = [x, y];
  //     this.updateCamera();
  //     let v = Math.hypot(vx, vy);
  //     if (v > 0) {
  //       t1 = t2;
  //       timer = request(timeout);
  //     } else {
  //       // finished
  //       this.viewAnimations?.stop();
  //     }
  //   };
  //   let t1 = performance.now();
  //   let timer = request(timeout);
  //   this.viewAnimations = {
  //     stop: () => {
  //       cancel(timer);
  //       this.viewAnimations = null;
  //       this.eventHooks.panend?.();
  //     },
  //   };
  // }
  trySetZoom(zoomString) {
    let zoom = parseFloat(zoomString);
    if (!isNaN(zoom) && zoom) {
      this.setZoom(zoom);
    } else {
      this.setZoom(this.camera.zoom); // reset zoom text
    }
  }
  registerZoomInputEl(el) {
    this.doms.zoomInput = el;
    const observer = new MutationObserver(() => {
      if (el.disabled) {
        el.style.removeProperty('--input-w');
      } else {
        const rect = this.doms.zoom.getBoundingClientRect();
        el.style.setProperty('--input-w', `${rect.width}px`);
        el.value = this.doms.zoom.textContent;
        el.focus();
        el.select();
      }
    });
    observer.observe(el, {
      attributeFilter: ['disabled'],
    });
    el.disabled = true;
    events({
      blur: () => el.disabled || this.trySetZoom(el.value),
      keydown: (e) => {
        ({
          Enter: () => this.trySetZoom(el.value),
          Escape: () => this.setZoom(this.camera.zoom), // reset zoom text
        }[e.key]?.());
      },
      input: () => {
        this.doms.zoom.textContent = el.value;
        const rect = this.doms.zoom.getBoundingClientRect();
        el.style.setProperty('--input-w', `${rect.width}px`);
      },
    }).apply(el);
    this.eventHooks.registerHooks({
      preZoom: () => (el.disabled = true), // cancel editing
    });
  }
  attach(target) {
    h`
      <div class="group/drawer w-full h-full relative font-sans">

        <!-- zoom buttons -->
        <div class="absolute top-1 left-1 text-gray">
          <div class="flex shadow rounded overflow-hidden z-50 relative"
          ${attr((el) => this.doms.ui.push({ el, region: 0 }))} >
            <button title="zoom fit" class="btn w-6 h-6 bg-white hover:text-gray-500 flex justify-center items-center"
            ${events({ click: () => this.zoomFit() })} >
              <i class="fas fa-expand"></i>
            </button>
            <button title="edit zoom level" class="btn h-6 bg-white hover:text-gray-500 b-l b-l-solid b-l-gray-200 flex justify-center items-center px-1"
            ${attr((el) => (this.doms.zoom = el))}
            ${events({ click: () => (this.doms.zoomInput.disabled = false) })} >
              100%
            </button>
            <input value="100%" class="btn absolute right-0 w-[var(--input-w,0)] h-6 bg-white text-gray-500 text-center"
            ${attr((el) => this.registerZoomInputEl(el))} >
          </div>
          <div class="mt-1 w-fit shadow rounded overflow-hidden z-50 relative"
          ${attr((el) => this.doms.ui.push({ el, region: 0 }))} >
            <button title="zoom in" class="btn w-6 h-6 bg-white hover:text-gray-500 flex justify-center items-center"
            ${events({ click: () => this.zoomIn() })} >
              <i class="fas fa-plus"></i>
            </button>
            <button title="zoom out" class="btn b-t b-t-solid b-t-gray-200 box-content w-6 h-6 bg-white hover:text-gray-500 flex justify-center items-center"
            ${events({ click: () => this.zoomOut() })} >
              <i class="fas fa-minus"></i>
            </button>
          </div>
        </div>

        <!-- drag panel -->
        <div class="absolute w-full h-full z-40 select-none"
        ${events({
          /* refine panning logic, add touch support */
          // do not use preventDefault() to avoid selection, use select-none instead,
          // otherwise no mouse event when cursor outside iframe
          mousedown: (e) => {
            if (e.button !== 0) {
              return;
            }
            // this.eventHooks.prePan?.(); // pre pan event hook
            this.panStart(['mouse', e]);
            const mousemove = (e) => {
              this.panMove(['mouse', e]);
            };
            const mouseup = (e) => {
              this.panMove(['mouse', e]);
              this.panEnd(['mouse']);
              window.removeEventListener('mousemove', mousemove);
              window.removeEventListener('mouseup', mouseup);
            };
            window.addEventListener('mousemove', mousemove);
            window.addEventListener('mouseup', mouseup);
          },
          wheel: (e) => {
            e.preventDefault();
            const mapper = this.projectClientPoints();
            const cursor = mapper(e);
            if (e.deltaY < 0) {
              this.zoomIn(cursor);
            } else if (e.deltaY > 0) {
              this.zoomOut(cursor);
            }
          },
          mousemove: (e) => {
            // this.hoverPopup.registerGlobalMousemoveEvent(e); // TODO
          },
          mouseclick: (e) => {
            console.log('clicked drag');
          },
          // TODO study pointer events (?)
          /* touch events */
          // TODO add touch focus state, so when "blur" allow user to scroll the page over the drawer
          ...(() => {
            function getPointers(e) {
              return [...e.changedTouches].map((t) => [t.identifier, t]);
            }
            const touchstart = (e) => {
              e.preventDefault();
              this.panStart(...getPointers(e));
            };
            const touchmove = (e) => {
              e.preventDefault();
              this.panMove(...getPointers(e));
            };
            const touchend = (e, touchcancel) => {
              /*
                touchcancel touch position of event returned:
                  * 1. go back to its touch start position, which happens when user actions
                  *    that act like blurring the application, such as the notification drop-down
                  * 2. stay at last position, like when turn off screen
               */
              e.preventDefault();
              // actually user lifting up finger might affect the touch point position a lot
              // so just do not record it
              // if (!touchcancel) {
              //   touchmove(e);
              // }
              this.panEnd(...getPointers(e));
            };
            return {
              touchstart,
              touchmove,
              touchend,
              touchcancel: (e) => touchend(e, true),
            };
          })(),
        })} >
        </div>

        <!-- camera and view -->
        <div class="absolute w-full h-full bg-[var(--bg)] flex justify-center items-center overflow-hidden select-none"
        ${attr((el) => {
          this.doms.camera = el;
          el.style.setProperty('--bg', this.config.bgColor);
        })} >
          <div class="w-[var(--aspect-w)] h-[var(--aspect-h)] relative">
            <div class="absolute w-full h-full group-[:not(.panning)]/drawer:transition-transform translate-x-[var(--x)] translate-y-[var(--y)] scale-[var(--s)]"
            ${attr((el) => (this.doms.map = el))} >
              <img width="0" height="0" class="absolute w-full h-full"
              ${attr((el) => (el.src = this.config.mapImgUrl))} >

              <!-- marker layer -->
              ${this.markerList.getEl()}

            </div>
          </div>
        </div>

        <!-- distant indicator layer -->
        ${this.markerList.distants.getEl()}

        <!-- scale bar -->
        <div class="absolute bg-white/70 text-black/90 rounded px-1.5 bottom-2 right-2 z-50 pointer-events-none select-none"
        ${attr((el) => this.doms.ui.push({ el, region: 8 }))} >
          <div class="flex items-center">
            <div class="w-[var(--scale-bar)] transition-width h-2 mt-1 b-2 b-solid b-black/90 b-t-none"
            ${attr((el) => (this.doms.scaleBar = el))} ></div>
            <div class="ml-1"
            ${attr((el) => (this.doms.scaleText = el))} >1km</div>
          </div>
        </div>

        <!-- hover popup -->
        ${this.hoverPopup.getEl()}

      </div>
    `
      .also((el) => this.registerEl(el))
      .attach(target);
  }

  //////////////////////////////////////////////////////
  /* marker list and helper functions for marker list */
  //////////////////////////////////////////////////////

  markerList = new MarkerList(this);
  hoverPopup = new HoverPopup(this);

  getMapPanner() {
    return ProjectionMath.startPanning(this.camera.zoom, this.camera.offset);
  }
  getCameraProjection() {
    function rectOf(el, s) {
      const r = el.getBoundingClientRect();
      const [x, y, w, h] = [r.left * s, r.top * s, r.width, r.height];
      return;
    }
    function pointOf(r, s, t) {
      const [x, y, w, h] = r;
      return [x + w * s, y + h * t];
    }
    function s(f) {
      // return (...)/
    }
    const a = 0.5;
    /*
      example usage:
        getCameraProjection()
          .rect(this.doms.camera, 1)
          .point(0.5, 0.5)
          .rel(e.clientX, e.clientY)
          .


     */
    return {};
  }
}

//////////////////////// HOVER POPUP ////////////////////////

/* deduce position for hover popup */
function deduceAppropriatePosition(viewport, target, size) {
  const [x0, y0, w0, h0] = viewport;
  const [x1, y1, w1, h1] = target;
  const [w2, h2] = size;
  // some essential
  const [u0, v0] = [x0 + w0, y0 + h0];
  const [u1, v1] = [x1 + w1, y1 + h1];
  const resolve = (st, ed, it, w) => {
    it = Math.min(it, ed - w);
    it = Math.max(it, st);
    return it;
  };
  // try bottom
  if (h2 <= v0 - v1) {
    const y = v1;
    const x = resolve(x0, u0, x1, w2);
    return [x, y];
  }
  // try right
  if (w2 <= u0 - u1) {
    const x = u1;
    const y = resolve(y0, v0, y1, h2);
    return [x, y];
  }
  // try left
  if (w2 <= x1 - x0) {
    const x = x1 - w2;
    const y = resolve(y0, v0, y1, h2);
    return [x, y];
  }
  // try top
  if (h2 <= y1 - y0) {
    const y = y1 - h2;
    const x = resolve(x0, u0, x1, w2);
    return [x, y];
  }
  // nothing success, just use bottom
  const y = v1;
  const x = resolve(x0, u0, x1, w2);
  return [x, y];
}

/* additional hover regions */
function additionalHoverRegions(popup, target) {
  const [x0, y0, w0, h0] = popup;
  const [x1, y1, w1, h1] = target;
  // some essential
  const [u0, v0] = [x0 + w0, y0 + h0];
  const [u1, v1] = [x1 + w1, y1 + h1];
  /* cover half */
  // const x = clamp(x0, x1, (x1 + u1) / 2);
  // const u = clamp(u0, (x1 + u1) / 2, u1);
  // const y = clamp(y0, y1, (y1 + v1) / 2);
  // const v = clamp(v0, (y1 + v1) / 2, v1);
  /* cover full */
  const x = x1;
  const u = u1;
  const y = y1;
  const v = v1;
  const res = [[x, y, u - x, v - y]];
  const minmax = (a, b) => [Math.min(a, b), Math.max(a, b)];
  const [x4, x3] = minmax(x, x0);
  const [u3, u4] = minmax(u, u0);
  const [y4, y3] = minmax(y, y0);
  const [v3, v4] = minmax(v, v0);
  if (x3 < u3) {
    res.push([x3, y4, u3 - x3, v4 - y4]);
  }
  if (y3 < v3) {
    res.push([x4, y3, u4 - x4, v3 - y3]);
  }
  return res.length > 1 ? res : [];
}

function paddingRect([x, y, w, h], p) {
  return [x + p, y + p, w - 2 * p, h - 2 * p];
}

function boundingContains([x, y, w, h], [x2, y2]) {
  return x <= x2 && x2 <= x + w && y <= y2 && y2 <= y + h;
}

function intersectBounding(rect, rect2) {
  const [x0, y0, w0, h0] = rect;
  const [x1, y1, w1, h1] = rect2;
  // some essential
  const [u0, v0] = [x0 + w0, y0 + h0];
  const [u1, v1] = [x1 + w1, y1 + h1];
  const x = Math.max(x0, x1);
  const u = Math.min(u0, u1);
  const y = Math.max(y0, y1);
  const v = Math.min(v0, v1);
  return [x, y, u - x, v - y];
}

class HoverPopup {
  /*
    notes: some detail of google map hover logic:
      * info panel have a delay before show when cursor hover
      * then hovering others the delay is removed
      * unless panning or zooming, the delay will come back
   */
  constructor(drawer) {
    this.drawer = drawer;
    this.doms = {}; // root
    this.mousemove = null;
    this.states = {};
    this.contents = {};
    this.options = {
      viewportPaddingPx: 8, // default viewport padding 8px
      /* TODO FIX setting this value also lead offset to another direction */
      attachSpaceingPx: 0, // spacing between popup and hovering element
    };
  }
  getEl() {
    this._once = !this._once || invalidAction('already initialized');
    this.setupEventHooks();
    // mr-[-9999px] is to avoid text wrapping when container at right boundary
    // see https://stackoverflow.com/questions/24307922/why-does-an-absolute-position-element-wrap-based-on-its-parents-right-bound
    // fixed! left-0! top-0! is for avoiding this popup affecting body scrollbar
    return h`
      <div class="absolute mr-[-9999px] bg-white shadow rounded b b-solid b-gray-200 left-[var(--x)] top-[var(--y)] opacity-[var(--op)] transition-opacity max-w-[calc(100vw-var(--p2))] max-h-[calc(100vh-var(--p2))] overflow-auto z-50 pointer-events-none fixed! left-0! top-0!"></div>
    `.also((el) => {
      this.doms.root = el;
      el.style.setProperty('--op', `${0}`);
      el.style.setProperty('--p2', `${this.options.viewportPaddingPx * 2}px`);
    });
  }
  setupEventHooks() {
    this.drawer.eventHooks.registerHooks({
      panstart: () => {
        this.states.panning = true;
        this.states.delays = null; // reset hovering
        this.states.hovering?.cancel();
      },
      panend: () => {
        this.states.panning = false;
        this.testHover();
      },
      zoomchange: () => {
        this.states.delays = null; // reset hovering
        this.states.hovering?.cancel();
        this.testHover();
      },
      pandown: () => {
        // this is for the situation where mouse click is for stopping panning inertia
        // which will trigger panclick, but not mean to click the marker
        this.states.pandown = {
          cached: this.states.hovering,
        };
      },
      /* to have more accurate click and down must be the same element */
      panclick: () => {
        if (!this.states.hovering) {
          return;
        }
        if (this.states.hovering !== this.states.pandown?.cached) {
          return;
        }
        const data = this.states.hovering.data;
        if (data.type === 'cover') {
          this.coverClicked(data.cover);
        } else if (data.type === 'marker') {
          this.markerClicked(data.id);
        } else if (data.type === 'distant') {
          this.distantClicked(data.union.ids);
        }
      },
    });
  }
  markerClicked(id) {
    this.drawer.markerList.focusMarker(id);
  }
  coverClicked(cover) {
    this.drawer.markerList.focusCover(cover);
  }
  distantClicked(ids) {
    this.drawer.markerList.focusMarkers(ids);
  }
  getEssentialBoundings() {
    if (!this.states.hovering) {
      throw new Error('no hovering element');
    }
    const rect = this.drawer.doms.camera.getBoundingClientRect();
    const drawer = [rect.left, rect.top, rect.width, rect.height];
    const rect2 = this.states.hovering.el.getBoundingClientRect();
    const target = [rect2.left, rect2.top, rect2.width, rect2.height];
    const rect3 = this.doms.root.getBoundingClientRect();
    const popup = [rect3.left, rect3.top, rect3.width, rect3.height];
    return {
      drawer,
      target,
      popup,
    };
  }
  updatePosition() {
    if (!this.states.hovering) {
      throw new Error('no hovering element');
    }
    const { clientWidth: vw, clientHeight: vh } = document.documentElement;
    const p = this.options.viewportPaddingPx;
    const viewport = paddingRect([0, 0, vw, vh], p);
    let { drawer, target, popup } = this.getEssentialBoundings();
    target = intersectBounding(target, drawer);
    target = paddingRect(target, -this.options.attachSpaceingPx);
    const [, , ...size] = popup; // size = [w, h]
    const [x, y] = deduceAppropriatePosition(viewport, target, size);
    const root = this.doms.root;
    root.style.setProperty('--x', `${x - drawer[0]}px`);
    root.style.setProperty('--y', `${y - drawer[1]}px`);
  }
  getContentDom() {
    const root = this.doms.root;
    if (!this.states.hovering) {
      throw new Error('no hovering element');
    }
    const data = this.states.hovering.data;
    const entryDom = (id) => {
      const listView = this.drawer.markerList.listViews.default;
      const { name, x, y, color } = this.drawer.markerList.markerMap.get(id);
      const [x2, y2] = listView.toUserLocation([x, y]);
      const locText = listView.options.toCoordinateText(x2, y2);
      return h`
        <div class="px-2 group/entry flex flex-col">
          <button class="btn group flex justify-between items-baseline"
          ${events({
            click: () => this.markerClicked(id),
          })} >
            <div class="text-lg text-orange-600 group-hover:underline decoration-2"
            ${attr((el) => (el.textContent = `${name}`))} ></div>
            <div class="ml-5 text-xs text-black/50 group-hover:text-black/70"
            ${attr((el) => (el.textContent = locText))} ></div>
          </button>
          <div class="text-xs text-black/50 b-b b-b-solid b-b-gray-200 group-last/entry:b-b-0">
            <div ${attr((el) => (el.textContent = `id: ${id}`))} ></div>
          </div>
        </div>
      `;
    };
    const el = (() => {
      if (data.type === 'cover') {
        const { ids, circle } = data.cover;
        return h`
          <div class="py-1">
            <div class="px-2 text-sm text-black/50" ${attr((el) => {
              el.textContent = `${ids.length} marker${
                ids.length != 1 ? 's' : ''
              }`;
            })} ></div>
            ${ids.map(entryDom)}
          </div>
        `.el;
      } else if (data.type === 'marker') {
        return h`
          <div class="py-1">
            ${entryDom(data.id)}
          </div>
        `.el;
      } else if (data.type === 'distant') {
        // TODO: ability to hover multiple distant indicator and show union info of them
        const ids = data.union.ids;
        return h`
          <div class="py-1">
            <div class="px-2 text-sm text-black/50" ${attr((el) => {
              el.textContent = `${ids.length} marker${
                ids.length != 1 ? 's' : ''
              } out of view`;
            })} ></div>
            ${ids.map(entryDom)}
          </div>
        `.el;
      }
    })();
    const handle = {
      el,
      ...handleAttachor(root, el),
    };
    return handle;
  }
  setShow() {
    const root = this.doms.root;
    this.states.delays = Math.min(50, this.drawer.config.hoverPopupDelayMs); // 50 ms
    this.updatePosition();
    root.style.setProperty('--op', `${1}`);
    root.classList.remove('pointer-events-none');
    // only first popup (cuz uno css load) will make scroll bar, that is why using fixed! left-0! top-0!
    // remove only once is enough
    root.classList.remove('fixed!', 'left-0!', 'top-0!');
    this.states.showing = {
      cancel: () => {
        // TODO: properly remove element from page
        // Description: after disappearing, the element is still there
        // therefore, if window resized (and this list is long), that might causing scroll bar to appear
        root.style.setProperty('--op', `${0}`);
        root.classList.add('pointer-events-none');
        this.states.showing = null;
      },
    };
  }
  setHover(el) {
    const data = this.drawer.attachedData.get(el);
    data.setHovering?.(true);
    this.states.hovering = {
      el,
      data,
      timer: setTimeout(() => {
        this.setShow();
      }, this.states.delays ?? this.drawer.config.hoverPopupDelayMs),
      cancel: () => {
        data.setHovering?.(false);
        this.states.cursor?.setPointer(false);
        this.states.showing?.cancel();
        clearTimeout(this.states.hovering?.timer);
        this.states.hovering = null;
      },
    };
    this.contents.handle?.detach();
    this.contents.handle = this.getContentDom().attach();
    const root = this.doms.root;
    /* avoid blinking twice when switch to hover adjacent marker */
    root.getAnimations({ subtree: true }).forEach((x) => x.finish());
    this.updatePosition();
  }
  getPopupBoundings() {
    if (!this.states.showing) {
      return [];
    }
    let { drawer, target, popup } = this.getEssentialBoundings();
    /* because now addition cover full, lets clip target by drawer region */
    target = intersectBounding(target, drawer);
    const res = additionalHoverRegions(popup, target);
    return [popup, ...res];
  }
  __debug_visualizePopupBoundings() {
    if (!this.__debug) this.__debug = { doms: {} };
    this.__debug.doms.popupBoundings?.remove();
    h`
      <div>
        ${this.getPopupBoundings().map(([x, y, w, h0]) => {
          return h`
            <div class="fixed left-[var(--x)] top-[var(--y)] w-[var(--w)] h-[var(--h)] bg-black/20 pointer-events-none"
            ${attr((el) => {
              el.style.setProperty('--x', `${x}px`);
              el.style.setProperty('--y', `${y}px`);
              el.style.setProperty('--w', `${w}px`);
              el.style.setProperty('--h', `${h0}px`);
            })} ></div>
          `;
        })}
      </div>
    `
      .also((el) => (this.__debug.doms.popupBoundings = el))
      .attach(this.doms.root);
  }
  testHover(point = null) {
    if ((point ?? this.states.prevCursor) == null) {
      // TODO fix it (because touch has no hover)
      // console.warn('prev cursor is not set');
      return;
    }
    const [x, y] = point ?? this.states.prevCursor;
    if (this.states.panning) {
      this.states.hovering?.cancel();
      return false;
    }
    const hovers = [...document.elementsFromPoint(x, y)] //
      .filter((el) => this.drawer.attachedData.get(el)?.hoverable);
    this.states.cursor?.setPointer(hovers.length !== 0);
    // this.__debug_visualizePopupBoundings();
    for (const bounding of this.getPopupBoundings()) {
      if (boundingContains(bounding, [x, y])) {
        return true;
      }
    }
    if (hovers.length !== 0) {
      const [el] = hovers;
      if (this.states.hovering?.el !== el) {
        this.states.hovering?.cancel();
        this.setHover(el);
      }
      return true;
    } else {
      this.states.hovering?.cancel();
    }
    return false;
  }
  registerGlobalMousemoveEvent(e) {
    if (this.mousemove) {
      return;
    }
    const target = e.target;
    const handle = {
      pointer: false,
      setPointer(pointer) {
        if (pointer) {
          target.classList.add('!cursor-pointer');
        } else {
          target.classList.remove('!cursor-pointer');
        }
        handle.pointer = pointer;
      },
    };
    this.states.cursor = handle;
    const mousemove = (e) => {
      const [x, y] = [e.clientX, e.clientY];
      this.states.prevCursor = [x, y];
      if (this.testHover()) {
        return;
      }
      const rect = this.drawer.doms.camera.getBoundingClientRect();
      const bounding = [rect.left, rect.top, rect.width, rect.height];
      if (!boundingContains(bounding, [x, y])) {
        window.removeEventListener('mousemove', mousemove);
        this.mousemove = null;
        this.states.cursor = null;
      }
    };
    this.mousemove = mousemove;
    window.addEventListener('mousemove', mousemove);
  }
}

//////////////////////// DISTANT INDICATOR ////////////////////////

function handleAttachor(root, el, trackingActives, options) {
  const fallbackOptions = {
    opacityProperty: '--op',
    fade: false,
  };
  const { opacityProperty, fade } = { ...fallbackOptions, ...options };
  return {
    attach() {
      /* attach with fade in */
      if (fade) {
        el.style.setProperty(opacityProperty, `${0}`);
        // make sure transition is triggered
        // because transition is not triggered if element not in page
        const observer = new ResizeObserver((entries) => {
          el.style.setProperty(opacityProperty, `${1}`);
          observer.disconnect();
        });
        observer.observe(el);
      }
      root.appendChild(el);
      this.active = true;
      trackingActives?.set(el, this);
      return this;
    },
    detach() {
      /* detach with fade out */
      if (fade) {
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
        el.style.setProperty(opacityProperty, `${0}`);
        if (el.getAnimations().length === 0) {
          // no transition found
          // explain: this always occurred when zooming too fast,
          // where the cover added in previous zoom level and removed in next zoom level
          el.remove();
          clearTimeout(timer);
        }
      } else {
        el.remove();
      }
      this.active = false;
      trackingActives?.delete(el);
      return this;
    },
  };
}

function findUnchangedGroups(prev, curr, itemsFn) {
  // criteria: both prev and curr have to be list of disjoint sets (by item selector)
  // original algorithm runs in O(NM), this run in O(N+M)
  // where N and M are the total items in prev and in curr, respectively
  const normalize = (gps) => {
    const x = [...gps].map((gp) => ({ orig: gp, items: new Set(itemsFn(gp)) }));
    return new Set(x);
  };
  prev = normalize(prev);
  curr = normalize(curr);
  const currLookup = new Map();
  for (const c of curr) {
    for (const k of c.items) {
      currLookup.set(k, c);
    }
  }
  const unchanged = [];
  for (const p of prev) {
    const [k] = p.items; // first element
    if (currLookup.has(k)) {
      const c = currLookup.get(k);
      if (c.items.size !== p.items.size) {
        continue;
      }
      if (new Set([...c.items, ...p.items]).size === c.items.size) {
        unchanged.push([p, c]);
        prev.delete(p);
        curr.delete(c);
      }
    }
  }
  return {
    unchanged: unchanged.map(([p, c]) => [p.orig, c.orig]),
    detaching: [...prev].map((x) => x.orig),
    attaching: [...curr].map((x) => x.orig),
  };
}

function chevronRight() {
  // source: https://www.svgviewer.dev/s/16996/chevron-right
  // TODO better shadow effect
  // drop shadow filter: https://stackoverflow.com/questions/6088409/svg-drop-shadow-using-css3
  return h`
    <svg width="24px" height="24px" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="feather feather-chevron-right">
      <filter id="shadow" x="-50%" y="-50%" width="200%" height="200%">
        <feDropShadow dx="0" dy="0" stdDeviation="0.3" flood-color="#fff" flood-opacity="0.4" />
      </filter>
      <polyline points="9 18 15 12 9 6" filter="url(#shadow)"></polyline>
    </svg>
  `;
}

/* indicate distant markers */
class DistantIndicator {
  constructor(drawer) {
    this.drawer = drawer;
    this.doms = {}; // root
    this.tracking = {
      cached: {}, // regions, edges
      actives: new Map(),
    };
    this.options = {
      indicatorPadding: 0, // distance between indicator and drawer boundary
    };
  }
  getEl() {
    this._once = !this._once || invalidAction('already initialized');
    return h`
      <div class="absolute w-full h-full overflow-hidden"></div>
    `.also((el) => (this.doms.root = el));
  }
  solveDistant() {
    // indicator is for visible markers and cover
    // so marker included in cover will not be counted
    const centerPoint = (el) => {
      const r = el.getBoundingClientRect();
      const [x0, y0, w0, h0] = [r.left, r.top, r.width, r.height];
      return [x0 + w0 / 2, y0 + h0 / 2];
    };
    const data = [...this.drawer.markerList.tracking.actives.entries()]
      .map(([el, handle]) => {
        const [x, y] = centerPoint(el);
        return { handle, x, y };
      })
      .filter((x) => x.handle.hoverable); // because actives include hidden
    const points = data.map(({ x, y }) => [x, y]);
    const merging = this.drawer.config.mergingPx;
    const r = this.drawer.doms.camera.getBoundingClientRect();
    const p = this.options.indicatorPadding;
    const bounding = paddingRect([r.left, r.top, r.width, r.height], p);
    const solved = distantSolver(points, bounding, merging);
    return {
      regions: solved.regions.map((x) => x.map((i) => data[i])),
      edges: solved.edges.map(({ region, indexes, span }) => ({
        region,
        data: indexes.map((i) => data[i]),
        span,
      })),
    };
  }
  getIndicatorDom(region) {
    const root = this.doms.root;
    // outline outline-black outline-1 bg-black/20
    let colliBox; // collision box, used to detect ui collision
    let hoverBox; // hover box
    // clip-path reference: https://bennettfeely.com/clippy/
    // making corner hover like triangle is removed, you can add it:
    // style="clip-path: polygon(100% 100%, 0 0, 100% 0);"
    // and set class: translate-x-[-8px] scale-[1.5]
    const el = h`
      <div class="absolute w-[16px] h-[14px] -translate-1/2 left-[var(--x)] top-[var(--y)] rotate-[var(--r)] scale-[2] text-slate-700/80 flex justify-center items-center opacity-[var(--op,1)]">
        <div class="absolute -translate-x-1/2 w-full h-[2px]"
        ${attr((el) => (colliBox = el))} ></div>
        ${(region % 2 !== 0
          ? h`<div class="absolute -translate-x-1/2 w-1/2 h-full"></div>`
          : h`<div class="absolute translate-x-[-7px] w-[8px] h-[8px] scale-[1.25] rotate-45"></div>`
        ).also((el) => (hoverBox = el))}
        <div class="translate-x-[-4px] w-[24px] h-[24px]">
          ${chevronRight()}
        </div>
      </div>
    `.el;
    const rotate = [-3, -2, -1, 4, '', 0, 3, 2, 1][region];
    el.style.setProperty('--r', `${rotate * 45}deg`);
    // attached data: union { targetHandles, ids }, active (for hover popup)
    const handle = {
      type: 'distant',
      el,
      get hoverable() {
        return true; // TODO hover distant indicator
      },
      setHovering(hovering) {
        el.style.setProperty('--op', hovering ? '0.6' : '1');
      },
      update: (targetHandles, [rx, ry]) => {
        handle.union = {
          targetHandles,
          ids: targetHandles.flatMap((x) => {
            if (x.type === 'marker') {
              return x.id;
            } else if (x.type === 'cover') {
              return x.cover.ids;
            }
          }),
        };
        el.style.setProperty('--x', `${rx}px`);
        el.style.setProperty('--y', `${ry}px`);
        // detect intersection with drawer ui, if being covered, try to move to a better location
        const rectOf = (el) => {
          const rect = el.getBoundingClientRect();
          const { left: x, top: y, width: w, height: h } = rect;
          return { x, y, w, h, r: [x, y, w, h] };
        };
        const rectOfR = ([x, y, w, h]) => ({ x, y, w, h, r: [x, y, w, h] });
        const setH = ([x, y, w, h], h2, s) => [x, y + (h - h2) * s, w, h2];
        const setW = ([x, y, w, h], w2, s) => [x + (w - w2) * s, y, w2, h];
        if (!this._solutions) {
          // 0  1  2
          // 3  4  5
          // 6  7  8
          const so = [...Array(9)].map((x) => []);
          // extend: (r1, r0) => [x, y, w, h]
          // collide: (r2, r1, ex) => [x, y]   // ex means extra offset px
          const top = {
            extend: ({ r, y, h }, r0) => setH(r, y + h - r0.y, 1),
            collide: ({ x }, { y, h }, ex) => [x, y + h + ex], // y = v2
          };
          const left = {
            extend: ({ r, x, w }, r0) => setW(r, x + w - r0.x, 1),
            collide: ({ y }, { x, w }, ex) => [x + w + ex, y], // x = u2
          };
          const right = {
            extend: (r1, { x, w }) => setW(r1.r, x + w - r1.x, 0),
            collide: ({ y, w }, { x }, ex) => [x - w - ex, y], // x = x2 - w
          };
          const bottom = {
            extend: (r1, { y, h }) => setH(r1.r, y + h - r1.y, 0),
            collide: ({ x, h }, { y }, ex) => [x, y - h - ex], // y = y2 - h
          };
          [0, 1, 2].forEach((i) => so[i].push(top));
          [0, 3, 6].forEach((i) => so[i].push(left));
          [2, 5, 8].forEach((i) => so[i].push(right));
          [6, 7, 8].forEach((i) => so[i].push(bottom));
          this._solutions = so;
        }
        const r0 = rectOf(this.drawer.doms.camera);
        // fetch and extend all ui boundings
        const boundings = [];
        for (const { el, region } of this.drawer.doms.ui) {
          let r = rectOf(el);
          for (const { extend } of this._solutions[region]) {
            r = rectOfR(extend(r, r0));
          }
          boundings.push(r);
        }
        const collided = (r1, r2) => {
          const [x, y, w, h] = intersectBounding(r1.r, r2.r);
          return w > 0 && h > 0;
        };
        let testCollide = true;
        const maxTries = 10;
        let tries = 0;
        while (testCollide && ++tries < maxTries) {
          testCollide = false;
          for (const r1 of boundings) {
            const r2 = rectOf(colliBox);
            if (!collided(r1, r2)) {
              continue;
            }
            testCollide = true;
            const ex = 1; // extra offset px
            const positions = this._solutions[region].map((f) =>
              f.collide(r2, r1, ex)
            );
            const dis = ([x, y]) => Math.hypot(x - r2.x, y - r2.y);
            const min = positions.reduce((p, c) => (dis(p) < dis(c) ? p : c));
            const [dx, dy] = [min[0] - r2.x, min[1] - r2.y];
            rx += dx;
            ry += dy;
            el.style.setProperty('--x', `${rx}px`);
            el.style.setProperty('--y', `${ry}px`);
          }
        }
        if (tries >= maxTries) {
          console.warn(`tries >= maxTries: ${tries} >= ${maxTries}`);
        }
        return handle;
      },
      /* attach or detach (no fade in or fade out) */
      /* fading in or out does not feel right, so not used */
      ...handleAttachor(root, el, this.tracking.actives),
    };
    this.drawer.attachedData.set(hoverBox, handle);
    return handle;
  }
  updateIndicator() {
    const { regions, edges } = this.solveDistant();
    const cached = this.tracking.cached;
    // 0  1  2
    // 3  4  5
    // 6  7  8
    // update dom tree
    const r = this.drawer.doms.camera.getBoundingClientRect();
    const p = this.options.indicatorPadding;
    const [x0, y0, w0, h0] = paddingRect([0, 0, r.width, r.height], p);
    const [u0, v0] = [x0 + w0, y0 + h0];
    const corners = {
      0: [x0, y0],
      2: [u0, y0],
      6: [x0, v0],
      8: [u0, v0],
    };
    for (const i of [0, 2, 6, 8]) {
      const targetHandles = [...regions[i]].map((x) => x.handle);
      if (regions[i].length !== 0) {
        regions[i].handle = (
          cached.regions?.[i].handle ?? this.getIndicatorDom(i).attach()
        ).update(targetHandles, corners[i]);
      } else {
        cached.regions?.[i].handle?.detach();
      }
    }

    // edges
    const { unchanged, detaching, attaching } = findUnchangedGroups(
      cached.edges ?? [],
      edges,
      (ed) => ed.data.map((x) => x.handle.el)
    );
    const [ox, oy] = [r.left, r.top];
    const types = {
      1: (c) => [c - ox, y0],
      3: (c) => [x0, c - oy],
      5: (c) => [u0, c - oy],
      7: (c) => [c - ox, v0],
    };
    const update = (handle, ed) => {
      const [c, r] = ed.span;
      const targetHandles = [...ed.data].map((x) => x.handle);
      return handle.update(targetHandles, types[ed.region](c));
    };
    for (const [p, c] of unchanged) {
      c.handle = update(p.handle, c);
    }
    for (const p of detaching) {
      p.handle.detach();
    }
    for (const c of attaching) {
      c.handle = update(this.getIndicatorDom(c.region), c).attach();
    }

    cached.regions = regions;
    cached.edges = edges;

    // check do update next frame if there is transition
    if (this.drawer.doms.camera.getAnimations({ subtree: true }).length > 0) {
      const update = () => {
        this._update = null;
        this.updateIndicator();
      };
      this._update = this._update ?? requestAnimationFrame(update);
    }
  }
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
  '+y': 'bottom', // top or bottom. for math axis, it is top, for computer screen axis, it is bottom
  toCoordinateText: /* used by hover popup */ (x, y) => {
    return `(${x}, ${y})`;
  },
  /* first user list view is used for default list view, which is used for hover popup */
  isUser: true,
};

class MarkerList {
  constructor(drawer) {
    this.drawer = drawer;
    this.doms = {}; // (no root), markers, covers
    this.tracking = {
      markerHandle: new Map(), // key: id, value: marker dom handle
      cached: {}, // remains, covers
      actives: new Map(), // key el, value: marker or cover dom handle, for hover popup
    };
    this.nextId = 0; // auto id if id is not given
    this.markerMap = new Map(); // id => { id, name, x, y, color }
    this.listViews = {
      default: new MarkerListView(this, { isUser: false }), // default list view for hover popup
    };
    this.distants = new DistantIndicator(drawer);
  }
  getListView(options) {
    const listView = new MarkerListView(this, options);
    if (!this.listViews.default.options.isUser) {
      this.listViews.default = listView;
    }
    return listView;
  }
  focusMarker(id) {
    //TODO refactor, use camera projection
    // focus to this marker
    const { x, y } = this.markerMap.get(id);
    this.drawer.camera.offset = [x, y];
    this.drawer.setZoom(this.drawer.config.focusingZoom);
  }
  focusCover(cover) {
    // TODO refactor, use camera projection
    // set camera to contain all markers
    const [x, y, r] = cover.circle;
    const rect = this.drawer.doms.camera.getBoundingClientRect();
    const [W, H] = [rect.width, rect.height];
    const zoomX = W / (r * 2 * this.drawer.ratios.screenPxByMapUnit);
    const zoomY = H / (r * 2 * this.drawer.ratios.screenPxByMapUnit);
    this.drawer.camera.offset = [x, y];
    this.drawer.setZoom(Math.round(Math.min(zoomX, zoomY) * 100));
  }
  focusMarkers(ids) {
    if (ids.length === 0) {
      return;
    }
    // TODO refactor, use camera projection
    // set camera to contain all markers
    const markers = ids.map((x) => this.markerMap.get(x));
    const xs = markers.map(({ x }) => x);
    const ys = markers.map(({ y }) => y);
    const [x0, x1] = [Math.min(...xs), Math.max(...xs)];
    const [y0, y1] = [Math.min(...ys), Math.max(...ys)];
    const x = (x0 + x1) / 2;
    const y = (y0 + y1) / 2;
    const rect = this.drawer.doms.camera.getBoundingClientRect();
    const [W, H] = [rect.width, rect.height];
    const zoomX = W / ((x1 - x0) * this.drawer.ratios.screenPxByMapUnit);
    const zoomY = H / ((y1 - y0) * this.drawer.ratios.screenPxByMapUnit);
    let zoom = Math.round(Math.min(zoomX, zoomY) * 100) / 2;
    if (!isFinite(zoom)) {
      zoom = this.drawer.config.focusingZoom;
    }
    this.drawer.camera.offset = [x, y];
    this.drawer.setZoom(zoom);
  }
  getEl() {
    this._once = !this._once || invalidAction('already initialized');
    return h`
      <div class="absolute w-full h-full">
        <div class="absolute w-full h-full"
        ${attr((el) => (this.doms.markers = el))} ></div>
        <div class="absolute w-full h-full"
        ${attr((el) => (this.doms.covers = el))} ></div>
      </div>
    `;
  }
  solveMerging() {
    const zoomed = this.drawer.zoomedRatioScreenPx;
    const markers = [...this.markerMap.values()];
    const points = markers.map(({ x, y }) => [x, y]);
    const merging = this.drawer.config.mergingPx / zoomed;
    const solved = mergeSolver(points, merging, {
      // TODO: these options need more experiments for better look and feel
      minimumCoverDiameter: merging * 2,
      // coverExtraRadius: this.drawer.config.markerSizePx / zoomed,
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
  getMarkerDom() {
    const root = this.doms.markers;
    const el = h`
      <div class="absolute -translate-1/2 scale-[calc(1/var(--s))] left-[var(--x)] top-[var(--y)] transition-transform,opacity opacity-[var(--op)] bg-amber/50"></div>
    `.el;
    // attached data: id, hidden, active (for hover popup)
    const handle = {
      type: 'marker',
      el,
      get hoverable() {
        return this.active && !this.hidden;
      },
      update: (marker, opacity) => {
        const [mapW, mapH] = this.drawer.config.mapSize;
        const { name, x, y, color } = marker; // TODO color
        el.textContent = `${name}`;
        // why use % instead of px? answer: avoid transition animation when changing aspect
        el.style.setProperty('--x', `${(x / mapW) * 100 + 50}%`);
        el.style.setProperty('--y', `${(y / mapH) * 100 + 50}%`);
        el.style.setProperty('--op', `${opacity}`);
        handle.id = marker.id;
        handle.hidden = opacity == 0;
        return handle;
      },
      ...handleAttachor(root, el, this.tracking.actives),
    };
    this.drawer.attachedData.set(el, handle);
    return handle;
  }
  getCoverDom() {
    const root = this.doms.covers;
    const el = h`
      <div class="absolute -translate-1/2 w-[32px] h-[32px] scale-[var(--cs)] left-[var(--x)] top-[var(--y)] transition-transform,opacity opacity-[var(--op)] rounded-full bg-blue/50 flex justify-center items-center text-slate-700" ></div>
    `.el;
    // attached data: cover, active (for hover popup)
    const handle = {
      type: 'cover',
      el,
      get hoverable() {
        return this.active;
      },
      update: (cover) => {
        const [mapW, mapH] = this.drawer.config.mapSize;
        const [x, y, r] = cover.circle;
        el.textContent = `${cover.ids.length}`;
        const baseD = 32; // 32px, same to the h above
        const cs = (r * 2 * this.drawer.ratios.screenPxByMapUnit) / baseD;
        el.style.setProperty('--cs', `${cs}`);
        el.style.setProperty('--x', `${(x / mapW) * 100 + 50}%`);
        el.style.setProperty('--y', `${(y / mapH) * 100 + 50}%`);
        handle.cover = cover;
        return handle;
      },
      /* attach or detach with fade in or fade out */
      ...handleAttachor(root, el, this.tracking.actives, { fade: true }),
    };
    this.drawer.attachedData.set(el, handle);
    return handle;
  }
  updateMarkerDomTree() {
    const curr = new Set(this.markerMap.keys());
    for (const id of [...this.tracking.markerHandle.keys()]) {
      if (curr.has(id)) {
        curr.delete(id); // exist in both prev and curr
      } else {
        // removed from curr
        this.tracking.markerHandle.get(id).detach();
        this.tracking.markerHandle.delete(id);
      }
    }
    for (const id of curr) {
      // newly added to curr
      const handle = this.getMarkerDom().attach();
      this.tracking.markerHandle.set(id, handle);
    }
  }
  updateMarkerCamera() {
    this.updateMarkerDomTree();
    const { remains, covers } = this.solveMerging();
    const cached = this.tracking.cached;

    // update all markers
    const set = new Set(remains);
    for (const [id, handle] of this.tracking.markerHandle) {
      const opacity = set.has(id) ? 1 : 0;
      handle.update(this.markerMap.get(id), opacity);
    }

    // update all covers
    const { unchanged, detaching, attaching } = findUnchangedGroups(
      cached.covers ?? [],
      covers,
      (c) => c.ids
    );
    for (const [p, c] of unchanged) {
      c.handle = p.handle.update(c);
    }
    for (const p of detaching) {
      p.handle.detach();
    }
    for (const c of attaching) {
      c.handle = this.getCoverDom().update(c).attach();
    }
    cached.remains = remains; // only for distant to use
    cached.covers = covers;

    // update distant indicator
    this.distants.updateIndicator();
  }
  addMarker(id, marker) {
    if (id == null) {
      id = this.nextId;
      this.nextId++;
    }
    this.markerMap.set(id, { ...marker, id });
    // call update once (for multiple synchronous calls)
    const update = () => {
      this._update = null;
      this.updateMarkerCamera(); // should be enough, no need to update whole drawer
    };
    this._update = this._update ?? setTimeout(update);
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
      const [mapW, mapH] = this.mainList.drawer.config?.mapSize ?? [0, 0]; // ?? for internal list view
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
  /* set default for hover popup to use this list view */
  setDefault() {
    this.mainList.listViews.default = this;
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

// water level 1396, reviewing code...
// water level 2: 1672, reviewing touch impl code....

export { RobotMapDrawer };
