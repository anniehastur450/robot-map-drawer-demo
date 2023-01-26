// dom by string generator
function h(strings, ...values) {
  function isattr(x) {
    return !!x[Symbol.for('isattr')];
  }
  function ishtml(x) {
    return !!x[Symbol.for('ishtml')];
  }

  const replacements = [];
  let html = strings[0];
  values.forEach((v, i) => {
    if (isattr(v)) {
      const attr = `data-h-replacement-${i}`;
      replacements.push((div) => {
        const [e] = div.querySelectorAll(`[${attr}]`);
        e.removeAttribute(attr);
        v.apply(e);
      });
      html += ` ${attr} `;
    } else if (ishtml(v) || (Array.isArray(v) && v.every(ishtml))) {
      const className = `__h_replacement_${i}`;
      if (!Array.isArray(v)) v = [v];
      replacements.push((div) => {
        const [e] = div.getElementsByClassName(className);
        e.replaceWith(...v.map((x) => x.el));
      });
      html += `<template class="${className}"></template>`;
    } else {
      html += v;
    }
    html += strings[i + 1];
  });
  const div = document.createElement('div');
  div.innerHTML = html;
  replacements.forEach((fn) => fn(div));

  const handle = {
    // this should be kotlin also, not let =.=
    also: (fn) => {
      fn(handle.el);
      return handle;
    },
    attach: (target) => {
      target.appendChild(handle.el);
    },
    el: div.firstElementChild ?? div.firstChild,
    [Symbol.for('ishtml')]: true,
  };

  return handle;
}

function attr(apply) {
  return {
    apply,
    [Symbol.for('isattr')]: true,
  };
}

function events(listeners) {
  return attr((el) => {
    for (const [type, listener] of Object.entries(listeners)) {
      el.addEventListener(type, listener);
    }
  });
}

export { h, attr, events };
