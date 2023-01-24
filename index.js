// Import stylesheets
import './style.css';
import { RobotMapDrawer } from './lib/RobotMapDrawer.js';
import { h, attr, events } from './lib/dom-helper.js';

// 2000 x 901
const mapImgUrl =
  'https://doomwiki.org/w/images/8/8d/Wolfenstein_3D_1st_Encounter_MAP01_map.png';
const mapSize = [80, 36]; // w x h, in meters

const drawer = new RobotMapDrawer({
  mapImgUrl,
  mapSize,
  focusingZoom: 300,
});

drawer.attach(document.getElementById('main-drawer'));

const markers = drawer.markerList.getListView({
  origin: 'center',
  '+x': 'right',
  '+y': 'top', // use math axis: postive y is up and positive x is right
});

const robots = [
  ['🤖 1', /*       */ -25.6, 15, '#D0C7D9'],
  ['🤖 2', /*       */ -23.6, 15, '#D0C7D9'],
  ['🤖 3', /*       */ -23.6, 13, '#D0C7D9'],
  ['🤖 4', /*       */ -25.6, 13, '#D0C7D9'],
  ['🤖 A', /*      */ -24.9, -13, '#D0C7D9'],
  ['🤖 B', /*      */ -25.7, -15, '#D0C7D9'],
  ['🤖 C', /*    */ -23.5, -14.7, '#D0C7D9'],
  ['🐱 1', /*      */ 6.18, 0.21, '#F29829'],
  ['🐱 2', /*      */ 3.74, 0.04, '#F29829'],
  ['🐱 3', /*     */ 2.46, -2.26, '#F29829'],
  ['🐱 4', /*      */ 0.47, 0.08, '#F29829'],
  ['🐱 5', /*      */ 2.15, 2.55, '#F29829'],
  ['🐕 1', /*        */ 15, 15.7, '#F2CEA2'],
  ['🐕 2', /*       */ 15.4, -16, '#F2CEA2'],
];

for (const [name, x, y, color] of robots) {
  markers.add(null, { name, x, y, color }); // null means id is auto generated
}

// debug content
h`
  <div class="font-inter">
    <div class="flex">
      <label>
        <div class="text-xs text-gray-500 mb-1">
          Select a map
        </div>
        <select class="btn b b-solid b-gray-300 bg-white rounded-md px-4 py-2 text-sm text-gray-700 font-medium shadow-sm hover:bg-gray-50">
          <option class="text-base">Map 1: basic usage</option>
          <option class="text-base">haha2</option>
        </select>
      </label>
      <div class="ml-4 text-gray-900">
        <div class="text-xs text-gray-500 mb-1">
          Map description
        </div>
        <h3 class="m-0">Map 1: basic usage</h3>
        <p class="my-2 text-sm">
          A showcase of basic function, pan, zoom, map markers, marker clusters, off-screen marker indicators, and hover popup.
        </p>
      </div>
    </div>
    <div></div>
    123
  </div>
`.attach(document.getElementById('debug-content'));

// Write Javascript code!
const appDiv = document.getElementById('app');
appDiv.innerHTML = `<h1>JS Starter</h1>`;
