import { h, attr, events } from './dom-helper.js';
import { mergeSolver, distantSolver } from './merge-solver.js';

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
  /* hover popup related */
  hoverPopupDelayMs: 750,
  focusingZoom: 100, // zoom level of clicking a marker
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

function invalidAction(x) {
  throw new Error(`invalid action: ${x}`);
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

function createHooks() {
  return {
    addHooks(listeners) {
      for (const [type, listener] of Object.entries(listeners)) {
        if (!this[type]) {
          const fn = (...args) => {
            this[type].hooks.forEach((x) => x(...args));
          };
          fn.hooks = [];
          this[type] = fn;
        }
        this[type].hooks.push(listener);
      }
    },
  };
}

// to fix: animation is aborted when drawer size change

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
    this.eventHooks = createHooks(); // for hover popup to use only
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
    this.eventHooks.zoomchange?.();
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
      } else {
        // finished
        this.viewAnimations?.stop();
      }
    };
    let t1 = performance.now();
    let timer = request(timeout);
    this.viewAnimations = {
      stop: () => {
        cancel(timer);
        this.viewAnimations = null;
        this.eventHooks.panend?.();
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
            this.eventHooks.pandown?.();
            this.viewAnimations?.stop();
            // do not use preventDefault() to avoid selection, use select-none instead,
            // otherwise no mouse event when cursor outside iframe
            let [prevX, prevY] = [e.clientX, e.clientY];
            const trails = [[prevX, prevY, performance.now()]];
            let dragging = false; // only for hooks to use
            const moveThreshold = 2; // minimum distance before movement is considered dragging
            const mousemove = (e) => {
              const [x, y] = [e.clientX, e.clientY];
              if (!dragging) {
                if (Math.hypot(x - prevX, y - prevY) < moveThreshold) {
                  return;
                }
                dragging = true;
                e.target.classList.add('cursor-move');
                this.eventHooks.panstart?.();
              }
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
              if (dragging && velocity > 0) {
                this.startInertiaDragging(velocityX, velocityY);
              } else if (dragging) {
                this.eventHooks.panend?.();
              } else {
                this.eventHooks.panclick?.();
              }
              e.target.classList.remove('cursor-move');
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
            this.hoverPopup.registerGlobalMousemoveEvent(e);
          },
        })} >
        </div>

        <!-- camera and view -->
        <div class="absolute w-full h-full bg-[var(--bg)] flex justify-center items-center overflow-hidden select-none"
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

        <!-- distant indicator layer -->
        ${this.markerList.distants.getEl()}

        <!-- scale bar -->
        <div class="absolute bg-white/50 text-black/90 px-1.5 bottom-2 right-2 z-50 pointer-events-none select-none">
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

  getCamera() {}
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
  const x = clamp(x0, x1, (x1 + u1) / 2);
  const u = clamp(u0, (x1 + u1) / 2, u1);
  const y = clamp(y0, y1, (y1 + v1) / 2);
  const v = clamp(v0, (y1 + v1) / 2, v1);
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
    this.doms = {};
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
    if (this.doms.el) {
      throw new Error('assert false');
    }
    this.setupEventHooks();
    // mr-[-9999px] is to avoid text wrapping when container at right boundary
    // see https://stackoverflow.com/questions/24307922/why-does-an-absolute-position-element-wrap-based-on-its-parents-right-bound
    // fixed! left-0! top-0! is for avoiding this popup affecting body scrollbar
    return h`
      <div class="absolute mr-[-9999px] bg-white shadow rounded b b-solid b-gray-200 left-[var(--x)] top-[var(--y)] opacity-[var(--op)] transition-opacity max-w-[calc(100vw-var(--p2))] max-h-[calc(100vh-var(--p2))] overflow-auto z-50 pointer-events-none fixed! left-0! top-0!"></div>
    `.also((el) => {
      el.style.setProperty('--op', `${0}`);
      el.style.setProperty('--p2', `${this.options.viewportPaddingPx * 2}px`);
      this.doms.el = el;
    });
  }
  setupEventHooks() {
    this.drawer.eventHooks.addHooks({
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
        const data = this.drawer.attachedData.get(this.states.hovering.el);
        if (data.type === 'cover') {
          this.coverClicked(data.cover);
        } else if (data.type === 'marker') {
          this.markerClicked(data.id);
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
  getEssentialBoundings() {
    if (!this.states.hovering) {
      throw new Error('no hovering element');
    }
    const rect = this.drawer.doms.el.getBoundingClientRect();
    const drawer = [rect.left, rect.top, rect.width, rect.height];
    const rect2 = this.states.hovering.el.getBoundingClientRect();
    const target = [rect2.left, rect2.top, rect2.width, rect2.height];
    const rect3 = this.doms.el.getBoundingClientRect();
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
    const root = this.doms.el;
    root.style.setProperty('--x', `${x - drawer[0]}px`);
    root.style.setProperty('--y', `${y - drawer[1]}px`);
  }
  getContentDom(root) {
    if (!this.states.hovering) {
      throw new Error('no hovering element');
    }
    const data = this.drawer.attachedData.get(this.states.hovering.el);
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
      }
    })();
    const handle = {
      el,
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
  setShow() {
    const root = this.doms.el;
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
    this.states.hovering = {
      el,
      timer: setTimeout(() => {
        this.setShow();
      }, this.states.delays ?? this.drawer.config.hoverPopupDelayMs),
      cancel: () => {
        this.states.cursor?.setPointer(false);
        this.states.showing?.cancel();
        clearTimeout(this.states.hovering?.timer);
        this.states.hovering = null;
      },
    };
    this.contents.handle?.detach();
    this.contents.handle = this.getContentDom(this.doms.el).attach();
    const root = this.doms.el;
    /* avoid blinking twice when swithc to hover adjacent marker */
    root.getAnimations({ subtree: true }).forEach((x) => x.finish());
    this.updatePosition();
  }
  getPopupBoundings() {
    if (!this.states.showing) {
      return [];
    }
    let { target, popup } = this.getEssentialBoundings();
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
      .attach(this.doms.el);
  }
  testHover(point = null) {
    if ((point ?? this.states.prevCursor) == null) {
      console.warn('prev cursor is not set');
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
      const rect = this.drawer.doms.el.getBoundingClientRect();
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

function chevronRight() {
  // hero icons, chevron-right
  // https://heroicons.com/
  return h`
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" class="w-5 h-5">
      <path fill-rule="evenodd" d="M7.21 14.77a.75.75 0 01.02-1.06L11.168 10 7.23 6.29a.75.75 0 111.04-1.08l4.5 4.25a.75.75 0 010 1.08l-4.5 4.25a.75.75 0 01-1.06-.02z" clip-rule="evenodd" />
    </svg>
  `;
}

/* indicate distant markers */
class DistantIndicator {
  constructor(drawer) {
    this.drawer = drawer;
    this.doms = {};
    this.cached = {};
    this.options = {
      indicatorPadding: 0, // distance between indicator and drawer boundary
    };
  }
  getEl() {
    return h`
      <div class="absolute w-full h-full overflow-hidden"></div>
    `.also((el) => (this.doms.el = el));
  }
  getIndicatorDom(region, x, y) {
    const rotate = [-3, -2, -1, 4, '', 0, 3, 2, 1][region];
    // b-black b-1 b-solid bg-black/20
    const el = h`
      <div class="absolute left-[var(--x)] top-[var(--y)] rotate-[var(--r)] -translate-1/2 scale-[2.5] text-slate-700/70 w-5 h-5 "
      ${attr((el) => {
        el.style.setProperty('--x', `${x}px`);
        el.style.setProperty('--y', `${y}px`);
        el.style.setProperty('--r', `${rotate * 45}deg`);
      })} >
        <div class="-translate-x-1 w-5 h-5">
          ${chevronRight()}
        </div>
      </div>
    `.el;

    return el;
  }
  solveDistant() {
    // indicator is for visible markers and cover
    // so marker included in cover will not be counted
    const zoomed = this.drawer.zoomedRatioScreenPx;
    const data = [
      ...this.drawer.markerList.tracking.cached.remains.map((id) => {
        const { x, y } = this.drawer.markerList.markerMap.get(id);
        return { type: 'marker', id, x, y };
      }),
      ...this.drawer.markerList.tracking.cached.covers.map((cover) => {
        const [x, y, r] = cover.circle;
        return { type: 'cover', cover, x, y };
      }),
    ];
    const points = data.map(({ x, y }) => [x, y]);
    const merging = this.drawer.config.mergingPx / zoomed;
    const bounding = (() => {
      const [x0, y0, w0, h0] = this.getIndicatorBounding();
      const [ox, oy] = this.drawer.camera.offset;
      const vw = w0 / zoomed;
      const vh = h0 / zoomed;
      const [x, y] = [-ox - vw / 2, -oy - vh / 2];
      return [x, y, vw, vh];
    })();
    const solved = distantSolver(points, bounding, merging);
    const mapper = ({ indexes, span }) => ({
      data: indexes.map((i) => data[i]),
      span,
    });
    return {
      regions: solved.regions.map((x) => x.map((i) => data[i])),
      top: /*    */ solved.top.map(mapper),
      right: /*  */ solved.right.map(mapper),
      bottom: /* */ solved.bottom.map(mapper),
      left: /*   */ solved.left.map(mapper),
    };
  }
  getIndicatorBounding() {
    const r = this.drawer.doms.el.getBoundingClientRect();
    const p = this.options.indicatorPadding;
    const [x0, y0, w0, h0] = paddingRect([0, 0, r.width, r.height], p);
    return [x0, y0, w0, h0];
  }
  updateIndicator() {
    const solved = this.solveDistant();
    // quick impl, TODO transition and reusing dom
    // 0  1  2
    // 3  4  5
    // 6  7  8
    const [x0, y0, w0, h0] = this.getIndicatorBounding();
    const [u0, v0] = [x0 + w0, y0 + h0];
    const corners = {
      0: [x0, y0],
      2: [u0, y0],
      6: [x0, v0],
      8: [u0, v0],
    };
    const childs = [];
    for (const region of [0, 2, 6, 8]) {
      if (solved.regions[region].length !== 0) {
        childs.push(this.getIndicatorDom(region, ...corners[region]));
      }
    }
    const zoomed = this.drawer.zoomedRatioScreenPx;
    const [ox, oy] = this.drawer.camera.offset;
    const rect = this.drawer.doms.el.getBoundingClientRect();
    const cx = rect.width / 2 + ox * zoomed;
    const cy = rect.height / 2 + oy * zoomed;
    // top
    for (const d of solved.top) {
      const [c, r] = d.span;
      const dx = cx + c * zoomed;
      childs.push(this.getIndicatorDom(1, dx, y0));
    }
    // left
    for (const d of solved.left) {
      const [c, r] = d.span;
      const dy = cy + c * zoomed;
      childs.push(this.getIndicatorDom(3, x0, dy));
    }
    // right
    for (const d of solved.right) {
      const [c, r] = d.span;
      const dy = cy + c * zoomed;
      childs.push(this.getIndicatorDom(5, u0, dy));
    }
    // bottom
    for (const d of solved.bottom) {
      const [c, r] = d.span;
      const dx = cx + c * zoomed;
      childs.push(this.getIndicatorDom(7, dx, v0));
    }

    const root = this.doms.el;
    root.innerHTML = '';
    root.append(...childs);
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
      actives: new Map(), // key el, value: marker or cover dom handle
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
    //TODO refactor
    // focus to this marker
    const { x, y } = this.markerMap.get(id);
    this.drawer.camera.offset = [-x, -y];
    this.drawer.setZoom(this.drawer.config.focusingZoom);
  }
  focusCover(cover) {
    // TODO refactor
    // set camera to contain all markers
    const [x, y, r] = cover.circle;
    const rect = this.drawer.doms.el.getBoundingClientRect();
    const [W, H] = [rect.width, rect.height];
    const zoomX = W / (r * 2 * this.drawer.ratios.screenPxByMapUnit);
    const zoomY = H / (r * 2 * this.drawer.ratios.screenPxByMapUnit);
    this.drawer.camera.offset = [-x, -y];
    this.drawer.setZoom(Math.round(Math.min(zoomX, zoomY) * 100));
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
      attach: () => {
        root.appendChild(el);
        handle.active = true;
        this.tracking.actives.set(el, handle);
        return handle;
      },
      detach: () => {
        el.remove();
        handle.active = false;
        this.tracking.actives.delete(el);
        return handle;
      },
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
      /* attach with fade in */
      attach: () => {
        el.style.setProperty('--op', `${0}`);
        root.appendChild(el);
        // make sure transition is triggered
        // because transition is not triggered if element not in page
        const observer = new ResizeObserver((entries) => {
          el.style.setProperty('--op', `${1}`);
          observer.disconnect();
        });
        observer.observe(el);
        handle.active = true;
        this.tracking.actives.set(el, handle);
        return handle;
      },
      /* detach with fade out */
      detach: () => {
        el.style.setProperty('--op', `${0}`);
        // TODO use getAnimations to check if there is transition
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
        handle.active = false;
        this.tracking.actives.delete(el);
        return handle;
      },
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
  findUnchangedCovers(prevCovers, covers) {
    // unchange if both ids is equals ignore order
    const unchanged = [];
    const detaching = new Set(prevCovers); // prevCovers can be null
    const attaching = new Set(covers);
    for (const p of [...detaching]) {
      for (const c of attaching) {
        if (p.ids.length !== c.ids.length) {
          continue;
        }
        if (new Set([...p.ids, ...c.ids]).size === p.ids.length) {
          unchanged.push([p, c]);
          detaching.delete(p);
          attaching.delete(c);
          break;
        }
      }
    }
    return { unchanged, detaching, attaching };
  }
  updateMarkerCamera() {
    this.updateMarkerDomTree();
    const solved = this.solveMerging();

    // update all markers
    const remains = new Set(solved.remains);
    for (const [id, handle] of this.tracking.markerHandle) {
      const opacity = remains.has(id) ? 1 : 0;
      handle.update(this.markerMap.get(id), opacity);
    }

    // update all covers
    const { unchanged, detaching, attaching } = this.findUnchangedCovers(
      this.tracking.cached.covers,
      solved.covers
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
    this.tracking.cached.remains = solved.remains; // only for distant to use
    this.tracking.cached.covers = solved.covers;

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

export { RobotMapDrawer };
