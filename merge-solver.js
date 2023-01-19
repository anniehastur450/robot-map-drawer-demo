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
  coverExtraRadius: 0, // equivalent to covering circles rather than points
  mergeOverlaps: true,
  coverMethod: 'simple',
};

function invalidArgument(x) {
  throw new Error(`invalid argument: ${x}`);
}

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
    r += options.coverExtraRadius;
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
  const sorted = scalars.keys().sort((ia, ib) => scalars[ia] - scalars[ib]);
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
    distant.updateSpan();
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
  const solve = (indexes, scalarGetter) => {
    const scalars = indexes.map((i) => scalarGetter(i));
    const res = mergeSolver1D(scalars, mergingDistance);
    for (const distant of res) {
      // re-map indexes
      distant.indexes = distant.indexes.map((i) => indexes[i]);
    }
    return res;
  };
  const top /*    */ = solve(regions[1], (i) => points[i][0]); // xs
  const bottom /* */ = solve(regions[7], (i) => points[i][0]); // xs
  const left /*   */ = solve(regions[3], (i) => points[i][1]); // ys
  const right /*  */ = solve(regions[5], (i) => points[i][1]); // ys

  return {
    regions,
    top,
    right,
    bottom,
    left,
  };
}

export { mergeSolver };
