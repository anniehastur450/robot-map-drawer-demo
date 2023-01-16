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
  updateCircle(points) {
    let xs = this.indexes.map((i) => points[i][0]);
    let ys = this.indexes.map((i) => points[i][1]);
    let [x0, x1] = [Math.min(...xs), Math.max(...xs)];
    let [y0, y1] = [Math.min(...ys), Math.max(...ys)];
    const x = (x0 + x1) / 2;
    const y = (y0 + y1) / 2;
    let rs = this.indexes.map((i) => {
      const [x2, y2] = points[i];
      return Math.hypot(x2 - x, y2 - y);
    });
    // this is not the smallest circle, but good enough
    // for improve, see smallest circle problem and Welzl's algorithm
    this.circle = [x, y, Math.max(...rs)];
  }
}

// [x, y]..., merging px -> circles [x, y, r]...
function mergeSolver2D(points, mergingDistance, allowedDiameterLimit) {
  // first, create a list of [pt1, pt2] that they should merge
  // second, create a circle for each [pt1, pt2]
  // final, merge overlapping circles into a bigger circle
  // after final, check if exceed allowed, break them down if necessary
  const pairs = [];
  for (const [i, j, [x1, y1], [x2, y2]] of entryPairs(points)) {
    if (Math.hypot(x2 - x1, y2 - y1) < mergingDistance) {
      pairs.push([i, j]);
    }
  }

  // chain points in list
  const chained = {};
  for (const [i, j] of pairs) {
    // if (!chained[i]) {
    //   chained[i] = new Cover(i);
    // }
    // if (chained[j]) {
    //   if (chained[j] === chained[i]) continue;
    //   for (const x of chained[j].indexes) {
    //     chained[i];
    //   }
    // } else {
    //   chained[i].indexes.push(j);
    //   chained[j] = chained[i];
    // }
  }

  const covers = [...new Set(chained.values())];
  covers.forEach((c) => c.updateCircle(points));
  let dirty = true;
  while (dirty) {
    dirty = false;
    for (const [i, j, c1, c2] of entryPairs(covers)) {
      const [x1, y1, r1] = c1.circle;
      const [x2, y2, r2] = c2.circle;
      if (Math.hypot(x2 - x1, y2 - y1) < r1 + r2) {
        c1.indexes.push(...c2.indexes);
        c1.updateCircle(points);
        covers.splice(j, 1);
        dirty = true;
        break;
      }
    }
  }
}
