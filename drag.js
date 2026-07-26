(function() {
  let dragging = false;
  let startX, startY, startLeft, startTop, panel;

  window.addEventListener('mousemove', function(e) {
    if (!dragging || !panel) return;
    e.stopImmediatePropagation();
    e.preventDefault();
    const newLeft = Math.max(0, Math.min(window.innerWidth  - panel.offsetWidth,  startLeft + e.clientX - startX));
    const newTop  = Math.max(0, Math.min(window.innerHeight - panel.offsetHeight, startTop  + e.clientY - startY));
    panel.style.left = newLeft + 'px';
    panel.style.top  = newTop  + 'px';
  }, { capture: true, passive: false });

  window.addEventListener('mouseup', function() {
    dragging = false;
  }, { capture: true });

  window.addEventListener('mousedown', function(e) {
    // Only activate drag if clicking directly on header text/background — not buttons
    if (e.target.tagName === 'BUTTON' ||
        e.target.tagName === 'SELECT' ||
        e.target.tagName === 'INPUT'  ||
        e.target.id === 'gax-tier-badge' ||
        e.target.id === 'gax-title-logo') return;

    const header = document.getElementById('gax-header');
    if (!header || !header.contains(e.target)) return;

    e.preventDefault();
    // Don't stopImmediatePropagation on mousedown — only stop mousemove during drag
    panel     = document.getElementById('gax-panel');
    startX    = e.clientX;
    startY    = e.clientY;
    startLeft = panel.offsetLeft;
    startTop  = panel.offsetTop;
    panel.style.right  = 'auto';
    panel.style.bottom = 'auto';
    dragging  = true;
  }, { capture: true });

  console.log('[GAX] drag.js v5 ready');
})();

// Intercept guess submission to capture player guess coordinates
(function() {
  const origFetch = window.fetch;
  window.fetch = async function(...args) {
    const url = typeof args[0] === 'string' ? args[0] : (args[0]?.url || '');
    
    // Intercept guess submission
    if (url.includes('/api/v3/games/') && args[1]?.method === 'POST') {
      try {
        const body = JSON.parse(args[1].body || '{}');
        if (body.lat !== undefined && body.lng !== undefined) {
          window._gax_guess_lat = body.lat;
          window._gax_guess_lng = body.lng;
          console.log('[GAX] Guess intercepted:', body.lat, body.lng);
          // Dispatch to content script
          window.dispatchEvent(new CustomEvent('gax_guess', {
            detail: { lat: body.lat, lng: body.lng }
          }));
        }
      } catch(e) {}
    }
    return origFetch.apply(this, args);
  };
})();