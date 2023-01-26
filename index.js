// Import stylesheets
import './style.css';
import { RobotMapDrawer } from './lib/RobotMapDrawer.js';
import { h, attr, events } from './lib/dom-helper.js';
import { definedMaps } from './maps.js';

function loadMap(mapData) {
  const main = document.getElementById('main-drawer');
  main.innerHTML = '';
  const drawer = new RobotMapDrawer(mapData.getMapConfig());
  drawer.attach(main);
  const view = drawer.getUserView(mapData.userViewOptions);
  const robots = mapData.markers;
  for (const [name, x, y, color] of robots) {
    view.addMarker(null, { name, x, y, color }); // null means id is auto generated
  }
}

let titleEl;
let descEl;
function select(i) {
  const title = `Map ${i + 1}: ${definedMaps[i].title}`;
  titleEl.textContent = title;
  descEl.textContent = definedMaps[i].description;
  loadMap(definedMaps[i]);
}

// debug content
h`
  <div class="font-inter b-2 b-solid b-amber-200 rounded -mx-2 my-2 px-2 py-2 bg-amber-100">
    <div class="flex flex-wrap items-start gap-x-4 gap-y-2">
      <label class="grow-1 w-44">
        <div class="text-xs text-gray-500 mb-1">
          Select a map
        </div>
        <select class="btn b b-solid b-gray-300 bg-white rounded-md px-4 py-2 text-sm text-gray-700 font-medium shadow-sm hover:bg-gray-50 w-full pr-6! text-ellipsis"
        ${events({ change: (e) => select(e.target.selectedIndex) })} >
          ${definedMaps.map((data, i) => {
            const title = `Map ${i + 1}: ${definedMaps[i].title}`;
            return h`<option>${title}</option>`;
          })}
        </select>
      </label>
      <div class="text-gray-900 w-56 grow-9999 shrink-0">
        <div class="text-xs text-gray-500 mb-1">
          Map description
        </div>
        <h3 class="m-0" ${attr((el) => (titleEl = el))} ></h3>
        <p class="my-2 text-sm" ${attr((el) => (descEl = el))} ></p>
      </div>
    </div>
    <div>
    
    </div>
  </div>
`.attach(document.getElementById('debug-content'));

// init
select(0); // load Map 1

// Write Javascript code!
const appDiv = document.getElementById('app');
appDiv.innerHTML = `<h1>JS Starter</h1>`;
