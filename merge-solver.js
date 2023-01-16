import wetzls from './wetzls.js';

// merge solver

function* entryPairs(array) {
  for (let i = 0; i < array.length; i++) {
    for (let j = i + 1; j < array.length; j++) {
      yield [i, j, array[i], array[j]];
    }
  }
}

class Cover {
  constructor(...indexes) {
    this.indexes = indexes;
    this.circle = null;
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
  simpleUpdateCircle(points) {
    const xs = this.indexes.map((i) => points[i][0]);
    const ys = this.indexes.map((i) => points[i][1]);
    const [x0, x1] = [Math.min(...xs), Math.max(...xs)];
    const [y0, y1] = [Math.min(...ys), Math.max(...ys)];
    const x = (x0 + x1) / 2;
    const y = (y0 + y1) / 2;
    const rs = this.indexes.map((i) => {
      const [x2, y2] = points[i];
      return Math.hypot(x2 - x, y2 - y);
    });
    // this is not the smallest circle, but good enough
    // for improve, see smallest circle problem and Welzl's algorithm
    this.circle = [x, y, Math.max(...rs)];
  }
}

// [x, y]..., merging px -> circles [x, y, r]...
function mergeSolver(
  points,
  mergingDistance,
  maximumCoverDiameter = Infinity,
  coverAlgorithm = 'simple'
) {
  // first, create a list of [pt1, pt2] that they should merge
  // second, create a circle for each [pt1, pt2]
  // final, merge overlapping circles into a bigger circle
  // after final, check if exceed maximum, break them down if necessary
  if (maximumCoverDiameter < mergingDistance) {
    console.warn(
      `maximumCoverDiameter < mergingDistance: ${maximumCoverDiameter} < ${mergingDistance}`
    );
    maximumCoverDiameter = mergingDistance;
  }

  const updateCircleMethod = {
    simple: 'simpleUpdateCircle',
    wetzls: 'wetzlsUpdateCircle',
  }[coverAlgorithm];

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

  const covers = [...new Set(Object.values(chained))];
  covers.forEach((c) => c[updateCircleMethod](points));
  let dirty = true;
  while (dirty) {
    dirty = false;
    for (const [i, j, c1, c2] of entryPairs(covers)) {
      const [x1, y1, r1] = c1.circle;
      const [x2, y2, r2] = c2.circle;
      if (Math.hypot(x2 - x1, y2 - y1) < r1 + r2) {
        c1.indexes.push(...c2.indexes);
        c1[updateCircleMethod](points);
        covers.splice(j, 1);
        dirty = true;
        break;
      }
    }
  }

  for (const c of covers) {
    const [x, y, r] = c.circle;
    if (r > maximumCoverDiameter) {
      console.warn('TODO: implement break down');
    }
  }

  const remains = new Set(points.keys());
  for (const c of covers) {
    c.indexes.forEach((i) => remains.delete(i));
  }

  return {
    remains: [...remains],
    covers,
  };
}

export { mergeSolver };
