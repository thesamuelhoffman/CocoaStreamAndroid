/* Load before modules: syntax failures must never leave an empty screen. */
(function () {
  if (navigator.userAgent.indexOf('CocoaStreamTV/') >= 0) document.body.classList.add('tv');
  var ready = false;
  var timer;
  var retry = document.getElementById('startup-retry');
  if (retry) retry.onclick = function () { window.location.reload(); };
  function fail(message) {
    if (ready) return;
    clearTimeout(timer);
    var status = document.getElementById('startup-status');
    if (status) status.textContent = message;
    if (retry) retry.hidden = false;
  }
  window.__cocoaReady = function () { ready = true; clearTimeout(timer); };
  window.addEventListener('error', function (event) {
    fail('CocoaStream could not start: ' + (event.message || 'an interface file did not load.'));
  });
  window.addEventListener('unhandledrejection', function (event) {
    fail('CocoaStream could not start: ' + (event.reason && event.reason.message || 'the app bridge did not respond.'));
  });
  timer = setTimeout(function () {
    fail('Startup is taking longer than expected. Try again, or send a screenshot of this screen.');
  }, 8000);
})();
