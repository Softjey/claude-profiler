// Stands in for `react-devtools-core` in the standalone build. Ink imports it
// only to connect React DevTools when DEV=true, and the package is an optional
// peer that is never installed; the bundle still has to resolve the import.
export default {
  initialize() {},
  connectToDevTools() {},
};
