// 5kable — panorama.js
// Runs inside panorama.html, which is loaded as an <iframe src="chrome-extension://...">
// embedded in the GeoGuessr page. Because this page's own origin is
// chrome-extension://<id>, its Content-Security-Policy comes from our
// manifest, not from GeoGuessr's page — so loading maps.googleapis.com
// here is never blocked, unlike injecting the script directly into the
// host page.

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
      panControl: true,
      zoomControl: true,
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
