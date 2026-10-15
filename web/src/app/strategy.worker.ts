/// <reference lib="webworker" />
// Strategy search (Monte Carlo pit windows) runs here, off the UI thread.
// STUB, implemented in PLAN.md M7.

addEventListener('message', ({ data }) => {
  postMessage({ type: 'not_implemented', request: data });
});
