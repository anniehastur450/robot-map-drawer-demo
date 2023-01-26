const definedMaps = [
  {
    title: 'basic usage',
    description:
      'A showcase of basic function, pan, zoom, map markers, marker clusters, off-screen marker indicators, and hover popup.',
    getMapConfig: () => {
      // 2000 x 901
      const mapImgUrl =
        'https://doomwiki.org/w/images/8/8d/Wolfenstein_3D_1st_Encounter_MAP01_map.png';
      const mapSize = [80, 36]; // w x h, in meters
      return {
        mapImgUrl,
        mapSize,
        focusingZoom: 300,
      };
    },
    markers: [
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
    ],
    userViewOptions: {
      origin: 'center',
      '+x': 'right',
      '+y': 'top', // use math axis: postive y is up and positive x is right
    },
  },
];

export { definedMaps };
