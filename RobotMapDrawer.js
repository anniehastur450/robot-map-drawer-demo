import { h, attr, events } from './dom-helper.js';

const fallbackConfig = {
  mapImgUrl: null, //  required
  mapSize: null, // required, [w, h]
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
      el.style.setProperty('--w', `${w}px`);
      el.style.setProperty('--h', `${h}px`);
      el.style.setProperty('--aspect-w', `${aspectW}px`);
      el.style.setProperty('--aspect-h', `${aspectH}px`);
      this.ratios.screenPxByMapUnit = aspectW / mapW;
      this.updateCamera();
    });
    resizeObserver.observe(el);
  }
  registerCameraEl(el) {
    h`<img width="0" height="0" class="w-full h-full">`
      .let((el) => (el.src = this.config.mapImgUrl))
      .attach(el);
    this.doms.camera = el;
    // updateCamera should be run after screenPxByMapUnit initialized
  }
  updateCamera() {
    const el = this.doms.camera;
    const [mapW, mapH] = this.config.mapSize;
    const [x, y] = this.camera.offset;
    el.getAnimations().forEach((x) => x.finish());
    el.style.setProperty('--x', `${(x / mapW) * this.camera.zoom}%`);
    el.style.setProperty('--y', `${(y / mapH) * this.camera.zoom}%`);
    el.style.setProperty('--s', `${this.camera.zoom}%`);
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
  startInertiaDragging(velocityX, velocityY) {
    const request = (x) => requestAnimationFrame(x);
    const cancel = (x) => cancelAnimationFrame(x);
    this.viewAnimations?.stop();
    // other names: kinetic scrolling
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
      <div class="w-full h-full shadow-lg shadow-inset b b-solid b-gray-200 relative font-sans">

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
            <input class="w-[var(--zoom-w)] btn h-6 bg-white text-gray-500 absolute right-0 text-center" value="100%"
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
        <div class="absolute w-full h-full bg-[#222] flex justify-center items-center overflow-hidden">
          <div class="w-[var(--aspect-w)] h-[var(--aspect-h)]">
            <div class="w-full h-full transition-transform origin-center translate-x-[var(--x)] translate-y-[var(--y)] scale-[var(--s)]"
            ${attr((el) => this.registerCameraEl(el))} ></div>
          </div>
        </div>

        <!-- marker layer -->
        ${this.markerList.getEl()}

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
  markerList = new MarkerList(this);
}

//////////////////////// MARKER LIST ////////////////////////

const fallbackMarkerListOptions = {
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
    this.markers = [];
  }
  getListView(options) {
    return new MarkerListView(this, options);
  }
  getEl() {
    return h`
      <div class="absolute w-full h-full flex justify-center items-center overflow-hidden">
        <div class="w-[var(--aspect-w)] h-[var(--aspect-h)] relative"
        ${attr((el) => (this.doms.container = el))} ></div>
      </div>
    `.let((el) => (this.doms.el = el));
  }
  updateMarkerCamera() {
    const root = this.doms.container;
    const rect = root.getBoundingClientRect();
    if (root.children.length != this.markers.length) {
      for (const ch of root.children) {
        root.removeChild(ch);
      }
      for (const marker of this.markers) {
        h`
          <div class="absolute z-40 -translate-1/2 left-[var(--x)] top-[var(--y)] transition-all cursor-pointer pointer-events-none bg-amber/50"></div>
        `
          .let((el) => (marker.el = el))
          .attach(root);
      }
    }
    const [ox, oy] = this.drawer.camera.offset;
    const zoomed = this.drawer.zoomedRatioScreenPx;
    for (const marker of this.markers) {
      const { id, x, y, el } = marker;
      el.textContent = id;
      const sx = rect.width / 2 + (x + ox) * zoomed;
      const sy = rect.height / 2 + (y + oy) * zoomed;
      el.getAnimations().forEach((x) => x.finish());
      // why use % instead of px? answer: avoid transition animation when changing aspect
      el.style.setProperty('--x', `${(sx / rect.width) * 100}%`);
      el.style.setProperty('--y', `${(sy / rect.height) * 100}%`);
    }
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
  addMarker(marker) {
    this.markers.push(marker);
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
    this.options = { ...fallbackMarkerListOptions, ...options };
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
    // A = loc, C = center, O = origin (in internal axis)
    // want: OA, known: CA, CO
    // OA = OC + CA = -(CO) + CA
    // to convert to user loc, just times '+x' and '+y'
    const [caX, caY] = internalLocation;
    const [coX, coY] = this.options.origin;
    let [oaX, oaY] = [caX - coX, caY - coY];
    oaX *= this.X;
    oaY *= this.Y;
    return [oaX, oaY];
  }
  toInternalLocation(userLocation) {
    // OA = CA - CO, CA = OA + CO
    let [oaX, oaY] = userLocation;
    oaX *= this.X;
    oaY *= this.Y;
    const [coX, coY] = this.options.origin;
    const [caX, caY] = [oaX + coX, oaY + coY];
    return [caX, caY];
  }
  add(id, { x, y, color }) {
    const [x2, y2] = this.toInternalLocation([x, y]);
    this.mainList.addMarker({
      id,
      x: x2,
      y: y2,
      color,
    });
  }
}

export { RobotMapDrawer };
