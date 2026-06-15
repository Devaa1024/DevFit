/* DevFit auto-updater — runs on every page, no UI dependencies */
(function(){
  if(!('serviceWorker' in navigator)) return;

  var refreshing = false;

  // Register BEFORE load so controllerchange is never missed
  navigator.serviceWorker.addEventListener('controllerchange', function(){
    if(refreshing) return;
    refreshing = true;
    window.location.reload();
  });

  function init(){
    navigator.serviceWorker.register('/sw.js').then(function(reg){
      // Check immediately on every page open
      reg.update();

      // Re-check every time user brings app to foreground
      document.addEventListener('visibilitychange', function(){
        if(!document.hidden) reg.update();
      });

      // When new SW is found: force-skip-waiting so it activates immediately
      reg.addEventListener('updatefound', function(){
        var sw = reg.installing;
        if(!sw) return;
        sw.addEventListener('statechange', function(){
          if(sw.state === 'installed'){
            sw.postMessage({type: 'SKIP_WAITING'});
          }
        });
      });
    }).catch(function(){});
  }

  if(document.readyState === 'loading'){
    window.addEventListener('load', init);
  } else {
    init();
  }
})();
