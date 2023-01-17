# Robot Map Drawer

[Edit on StackBlitz ⚡️](https://stackblitz.com/edit/js-puzas7)

A JavaScript library for drawing maps of robots.

## Getting Started

### Installation

This library is not yet packed into a npm package. To install the library, please copy the code yourself.

- `RobotMapDrawer.js`
- `dom-helper.js`

Following libraries might be requied:

- UnoCSS
- Font Awesome v5.14

For above libraries please refer to `index.html` and copy the code from the `<head>` yourself.

### Usage

Copy the following two files:

- `RobotMapDrawer.js`
- `dom-helper.js`

The main file of this library is `RobotMapDrawer.js`, which contains the `RobotMapDrawer` class. To use the library, import the class and create a new instance:

```javascript
import { RobotMapDrawer } from 'robot-map-drawer';

const robotMapDrawer = new RobotMapDrawer();
```

## Features

### Map Control

- ✔️ Intertia drag-to-pan (also called: kinetic scrolling)
- ✔️ zooming
- ✔️ scale bar
- **TODO** responsive (buttons bigger in smaller screens)
- touch support
  - **TODO** mobile Android - **TODO test**
  - ❓ iOS Safari - **not tested**

### Marker Features

- markers merge into a circle when close
- indicator for markers out of view
- circle merging animation
