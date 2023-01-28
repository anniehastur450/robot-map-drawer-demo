// merge solver

const coverMethods = {
  simple: 'simpleUpdateCircle',
  /* smallest: 'wetzlsUpdateCircle', */
  mean: 'meanUpdateCircle',
  median: 'medianUpdateCircle',
};

let wetzls;
(async () => {
  try {
    // optional ./wetzls.js
    // d3 article: https://observablehq.com/@d3/d3-packenclose
    // npm package: https://github.com/rowanwins/smallest-enclosing-circle
    wetzls = (await import('./wetzls.js')).default;
    coverMethods['smallest'] = 'wetzlsUpdateCircle';
  } catch (e) {}
})();

/* generator of combinations of n choose 2 */
function* entryPairs(array) {
  for (let i = 0; i < array.length; i++) {
    for (let j = i + 1; j < array.length; j++) {
      yield [i, j, array[i], array[j]];
    }
  }
}

function median(numbers) {
  const sorted = [...numbers].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[middle - 1] + sorted[middle]) / 2;
  }
  return sorted[middle];
}

class Cover {
  constructor(...indexes) {
    this.indexes = indexes;
    this.circle = null; // [x, y, r]
  }
  wetzlsUpdateCircle(points) {
    // use Welzl's algorithm
    const mapped = this.indexes.map((i) => {
      const [x, y] = points[i];
      return { x, y };
    });
    const { x, y, r } = wetzls(mapped);
    this.circle = [x, y, r];
  }
  simpleCircle(x, y, points) {
    const rs = this.indexes.map((i) => {
      const [x2, y2] = points[i];
      return Math.hypot(x2 - x, y2 - y);
    });
    return [x, y, Math.max(...rs)];
  }
  simpleUpdateCircle(points) {
    const xs = this.indexes.map((i) => points[i][0]);
    const ys = this.indexes.map((i) => points[i][1]);
    const [x0, x1] = [Math.min(...xs), Math.max(...xs)];
    const [y0, y1] = [Math.min(...ys), Math.max(...ys)];
    const x = (x0 + x1) / 2;
    const y = (y0 + y1) / 2;
    // this is not the smallest circle, but good enough
    // for improve, see smallest circle problem and Welzl's algorithm
    this.circle = this.simpleCircle(x, y, points);
  }
  meanUpdateCircle(points) {
    const xs = this.indexes.map((i) => points[i][0]);
    const ys = this.indexes.map((i) => points[i][1]);
    const sx = xs.reduce((p, v) => p + v);
    const sy = ys.reduce((p, v) => p + v);
    const x = sx / xs.length;
    const y = sy / ys.length;
    this.circle = this.simpleCircle(x, y, points);
  }
  medianUpdateCircle(points) {
    const xs = this.indexes.map((i) => points[i][0]);
    const ys = this.indexes.map((i) => points[i][1]);
    const x = median(xs);
    const y = median(ys);
    this.circle = this.simpleCircle(x, y, points);
  }
}

const fallbackExtraOptions = {
  breakDownThreshold: Infinity,
  minimumCoverDiameter: 0,
  // coverExtraRadius: 0, // equivalent to covering circles rather than points // take my words back, no, not equivalent
  mergeOverlaps: true,
  coverMethod: 'simple',
};

function invalidArgument(x) {
  throw new Error(`invalid argument: ${x}`);
}

function getRange(arr, mapper) {
  let u0 = mapper(arr[0]);
  let u1 = u0;
  for (let i = 1; i < arr.length; i++) {
    const u = mapper(arr[i]);
    if (u < u0) u0 = u;
    if (u > u1) u1 = u;
  }
  return [u0, u1];
}

function split(arr, mapper, val) {
  const a = [];
  const b = [];
  for (const ele of arr) {
    const c = mapper(ele) < val ? a : b;
    c.push(ele);
  }
  return [a, b];
}

function fastMergeSolver(points, mergingDistance) {
  // divide and conquer
  // case 0 no pt
  // case 1 pt = 1
  // case 2 pt >= 2, bounding diag < merging
  // case 3 other
  const REDUCED_CONSTANT = sqrt(2 / Math.PI);
  const minimumCoverDiameter = 2 * mergingDistance;
  function d0(indexes) {
    if (indexes.length === 0) {
      return null; // case 0
    } else if (indexes.length === 1) {
      return case1(indexes[0]); // case 1
    }
    // calc bounding
    const [x0, x1] = getRange(indexes, (i) => points[i][0]);
    const [y0, y1] = getRange(indexes, (i) => points[i][1]);
    if (Math.hypot(x1 - x0, y1 - y0) < mergingDistance) {
      return case2(indexes, x0, y0, x1, y1); // case 2
    }
    if (y1 - y0 < x1 - x0) {
      return d1(indexes, (x0 + x1) / 2, 0);
    } else {
      return d1(indexes, (y0 + y1) / 2, 1);
    }
  }
  function d1(indexes, mid, t) {
    const [left, right] = split(indexes, (i) => points[i][t], mid);
    const r0 = d0(left);
    const r1 = d0(right);
    // merge r0 and r1
    return case3(r0, r1, mid, t);
  }
  // cases
  function case1(i) {
    return { points: [i], covers: [] };
  }
  function case2(indexes, x0, y0, x1, y1) {
    const x = (x0 + x1) / 2;
    const y = (y0 + y1) / 2;
    const a = Math.hypot(x1 - x0, y1 - y0) / 2;
    const r = Math.max(minimumCoverDiameter, a * REDUCED_CONSTANT);
    const c = { indexes, bounding: [x0, y0, x1, y1], circle: [x, y, r] };
    return { points: [], covers: [c] };
  }
  function case3(r0, r1, mid, t) {
    // const c0 = r0.covers.filter((c) => c.circle[t] + c.circle[2] >= mid);
    // const c1 = r1.covers.filter((c) => c.circle[t] - c.circle[2] <= mid);

    // not optimized, TODO optimize
    return merged([...r0.points, ...r1.points], [...r0.covers, ...r1.covers]);
  }
  function merged(points, covers) {
    points = new Set(points);
    covers = new Set(covers);
    // scan overlap covers
    const scanned = new Set();
    for (const c0 of covers) {
      if (scanned.has(c0)) continue;
      for (const c1 of covers) {
        if (c0 === c1 || scanned.has(c1)) continue;
        const [x0, y0, r0] = c0.circle;
        const [x1, y1, r1] = c1.circle;
        if (Math.hypot(x1 - x0, y1 - y0) < r0 + r1) {
          covers.add(mergeCover(c0, c1));
          covers.delete(c0);
          covers.delete(c1);
          break;
        }
      }
      scanned.add(c0);
    }
    // scan coverable points
    for (const c of covers) {
      for (const p of points) {
        const [x0, y0, r0] = c.circle;
        const [x1, y1] = points[p];
        if (Math.hypot(x1 - x0, y1 - y0) <= r0) {
          c.indexes.push(p);
          points.delete(p);
        }
      }
    }
    return { points: [...points], covers: [...covers] };
  }
  function mergeCover(c1, c2) {
    const bounding = mergeBounding(c1.bounding, c2.bounding);
    const [x0, y0, x1, y1] = bounding;
    const x = (x0 + x1) / 2;
    const y = (y0 + y1) / 2;
    const a = Math.hypot(x1 - x0, y1 - y0) / 2;
    const r = Math.max(minimumCoverDiameter, a * REDUCED_CONSTANT);
    const indexes = [...c1.indexes, ...c2.indexes];
    return { indexes, bounding, circle: [x, y, r] };
  }
  function mergeBounding(b1, b2) {
    return ['min', 'min', 'max', 'max'].map((k, i) => Math[k](b1[i], b2[i]));
  }
  // main
  if (points.length === 0) {
    return { remains: [], covers: [] };
  }
  const r = d0([...points.keys()]);
  return { remains: r.points, covers: r.covers };
}

// function fastMergeSolver(points, mergingDistance) {
//   // divide and conquer
//   // case 0 no pt
//   // case 1 pt = 1
//   // case 2 pt >= 2, bounding diag < merging
//   const P = points;
//   function case1(i) {
//     return {
//       count: 1,
//       indexes: [i],
//       bounding: [points[i][0], points[i][1], points[i][0], points[i][1]],
//     };
//   }
//   const R = /* rotates */ [
//     [1, 0, 0, 1],
//     [0, -1, 1, 0],
//     [-1, 0, 0, -1],
//     [0, 1, -1, 0],
//   ];
//   const px = (i, r) => points[i][0] * R[r][0] + points[i][1] * R[r][1];
//   const py = (i, r) => points[i][0] * R[r][2] + points[i][1] * R[r][3];
//   function d0(indexes, r) {
//     if (indexes.length === 0) {
//       return null;
//     }
//     // calc bounding
//     const [x0, x1] = getRange(indexes, (i) => px(i, r));
//     const [y0, y1] = getRange(indexes, (i) => py(i, r));
//     if (y1 - y0 < x1 - x0) {
//     }
//   }
//   function d1() {}
//   class PointSet {}
//   const r = d0([...points.keys()], 0);
// }

// [x, y]..., merging px -> circles [x, y, r]...
function mergeSolver(points, mergingDistance, extraOptions) {
  // first, create a list of [pt1, pt2] that they should merge
  // second, create a circle for each [pt1, pt2]
  // final, merge overlapping circles into a bigger circle
  // after final, check if exceed maximum, break them down if necessary
  const options = { ...fallbackExtraOptions, ...extraOptions };
  const updateCircleMethod =
    coverMethods[options.coverMethod] ?? invalidArgument(options.coverMethod);

  const pairs = [];
  for (const [i, j, [x1, y1], [x2, y2]] of entryPairs(points)) {
    if (Math.hypot(x2 - x1, y2 - y1) < mergingDistance) {
      pairs.push([i, j]);
    }
  }

  // chain points in list
  const chained = {};
  for (const [i, j] of pairs) {
    if (!chained[i]) {
      chained[i] = new Cover(i);
    }
    if (!chained[j]) {
      chained[i].indexes.push(j);
      chained[j] = chained[i];
    } else if (chained[j] !== chained[i]) {
      for (const x of chained[j].indexes) {
        chained[i].indexes.push(x);
        chained[x] = chained[i];
      }
    }
  }

  const updateCircle = (c) => {
    c[updateCircleMethod](points);
    let [x, y, r] = c.circle;
    r = Math.max(r, options.minimumCoverDiameter / 2);
    c.circle = [x, y, r];
  };

  // TODO need re-check if any newly points can be added into circles

  const covers = [...new Set(Object.values(chained))];
  covers.forEach((c) => updateCircle(c));
  if (options.mergeOverlaps) {
    let dirty = true;
    while (dirty) {
      dirty = false;
      for (const [i, j, c1, c2] of entryPairs(covers)) {
        const [x1, y1, r1] = c1.circle;
        const [x2, y2, r2] = c2.circle;
        if (Math.hypot(x2 - x1, y2 - y1) < r1 + r2) {
          c1.indexes.push(...c2.indexes);
          updateCircle(c1);
          covers.splice(j, 1);
          dirty = true;
          break;
        }
      }
    }
  }

  // TODO breakDownThreshold
  // for (const c of covers) {
  //   const [x, y, r] = c.circle;
  //   if (r > maximumCoverDiameter) {
  //     console.warn('TODO: implement break down');
  //   }
  // }

  const remains = new Set(points.keys());
  for (const c of covers) {
    c.indexes.forEach((i) => remains.delete(i));
  }

  return {
    remains: [...remains],
    covers,
  };
}

class Cover1D {
  constructor(...indexes) {
    this.indexes = indexes;
    this.span = null; // [center, radius]
  }
  updateSpan(scalars) {
    const s = this.indexes.map((i) => scalars[i]);
    const [s0, s1] = [Math.min(...s), Math.max(...s)];
    const [c, r] = [(s0 + s1) / 2, (s1 - s0) / 2];
    this.span = [c, r];
  }
}

function mergeSolver1D(scalars, mergingDistance) {
  const sorted = [...scalars.keys()] //
    .sort((ia, ib) => scalars[ia] - scalars[ib]);
  const groups = [];
  let tmp = [];
  for (let i = 0; i < sorted.length; i++) {
    tmp.push(sorted[i]);
    const stay =
      i + 1 < sorted.length &&
      scalars[sorted[i + 1]] - scalars[sorted[i]] < mergingDistance;
    if (!stay) {
      groups.push(tmp);
      tmp = [];
    }
  }
  // break down
  const covers = [];
  for (const group of groups) {
    const s = group.map((i) => scalars[i]);
    const [s0, s1] = [s[0], s[s.length - 1]];
    const d = s1 - s0;
    const count = Math.max(1, Math.floor(d / mergingDistance));
    let i = 0;
    for (let c = 1; c < count; c++) {
      const s2 = (d / count) * c;
      for (let j = i; j < s.length; j++) {
        if (s[j] < s2) {
          // same cover
          continue;
        }
        // exceeded
        covers.push(group.slice(i, j));
        i = j;
        break;
      }
    }
    covers.push(group.slice(i));
  }
  const res = covers.map((x) => {
    const distant = new Cover1D(...x);
    distant.updateSpan(scalars);
    return distant;
  });
  return res;
}

function distantSolver(points, bounding, mergingDistance) {
  const [x0, y0, w0, h0] = bounding;
  const [u0, v0] = [x0 + w0, y0 + h0];
  const section = (val, st, ed) => {
    return val < st ? 0 : val <= ed ? 1 : 2;
  };
  const regions = [...Array(9)].map((x) => []);
  for (const [index, [x, y]] of points.entries()) {
    const i = section(x, x0, u0);
    const j = section(y, y0, v0);
    regions[3 * j + i].push(index);
  }
  // 0  1  2
  // 3  4  5
  // 6  7  8
  const solve = (region, scalarGetter) => {
    const indexes = regions[region];
    const scalars = indexes.map((i) => scalarGetter(i));
    const res = mergeSolver1D(scalars, mergingDistance);
    for (const distant of res) {
      // re-map indexes
      distant.indexes = distant.indexes.map((i) => indexes[i]);
      distant.region = region;
    }
    return res;
  };
  const top /*    */ = solve(1, (i) => points[i][0]); // xs
  const left /*   */ = solve(3, (i) => points[i][1]); // ys
  const right /*  */ = solve(5, (i) => points[i][1]); // ys
  const bottom /* */ = solve(7, (i) => points[i][0]); // xs

  return {
    regions,
    edges: [top, left, right, bottom].flat(),
    top,
    left,
    right,
    bottom,
  };
}

export { mergeSolver, distantSolver };
