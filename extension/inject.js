// Runs in page MAIN world at document_start.
// Forces preserveDrawingBuffer=true on WebGL contexts so the overlay can
// read pixel data from the game canvas (required for automatic ball detection).
(function () {
  try {
    const orig = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type, attrs) {
      if (
        type === 'webgl' ||
        type === 'webgl2' ||
        type === 'experimental-webgl'
      ) {
        attrs = attrs || {};
        if (attrs.preserveDrawingBuffer !== true) {
          attrs.preserveDrawingBuffer = true;
        }
        attrs.willReadFrequently = true;
      }
      if (type === '2d') {
        attrs = attrs || {};
        attrs.willReadFrequently = true;
      }
      return orig.call(this, type, attrs);
    };
    window.__sinucadaAimPatched = true;
  } catch (e) {
    console.warn('[SinucadaAim] inject patch failed:', e);
  }
})();
