// 5kable — panorama.js
// Runs inside panorama.html, which is embedded as an
// <iframe src="https://5kable.net/panorama.html?..."> in the GeoGuessr
// page. This is hosted on our own domain rather than packaged into the
// extension because Manifest V3 extension pages (chrome-extension://...)
// enforce a fixed script-src 'self' CSP that can't be relaxed, so they can
// never load Google's remote maps.googleapis.com script. A normal
// externally-hosted page isn't bound by that restriction.

const params = new URLSearchParams(window.location.search);
const panoId = params.get('pano_id');
const apiKey = params.get('key');

function showError() {
  document.getElementById('pano').style.display = 'none';
  document.getElementById('pano-error').style.display = 'block';
}

window._gaxInitPanorama = function () {
  if (!panoId || !window.google || !window.google.maps) {
    showError();
    return;
  }
  try {
    new google.maps.StreetViewPanorama(document.getElementById('pano'), {
      pano: panoId,
      clickToGo: false,
      linksControl: false,
      panControl: false,
      zoomControl: false,
      addressControl: false,
      fullscreenControl: true,
      motionTracking: false,
      motionTrackingControl: false
    });
  } catch (e) {
    console.log('5kable panorama.js: failed to init StreetViewPanorama', e.message);
    showError();
  }
};

if (!panoId || !apiKey) {
  showError();
} else {
  const script = document.createElement('script');
  script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(apiKey)}&callback=_gaxInitPanorama`;
  script.async = true;
  script.onerror = showError;
  document.head.appendChild(script);
}
