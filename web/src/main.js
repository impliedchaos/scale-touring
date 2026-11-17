// Entry point. Default: the fly-by. ?garage: car viewer. ?audiotest: engine sound self-test.
const params = new URLSearchParams(location.search);
if (params.has('garage')) import('./garage.js');
else if (params.has('audiotest')) import('./audio/selftest.js');
else import('./course/flyby.js');
