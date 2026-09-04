self.addEventListener('install', function(e){ self.skipWaiting(); });
self.addEventListener('activate', function(e){ e.waitUntil(self.clients.claim()); });
self.addEventListener('push', function(e){
  var data={}; try{ data=e.data.json(); }catch(_){ try{ data={title:e.data.text()}; }catch(__){} }
  var title=data.title||'🟢 내 차례예요!';
  var opts={ body:data.body||'지금 빈칸을 채울 차례입니다.', icon:'icon-192.png', badge:'icon-192.png', tag:'myturn', renotify:true, vibrate:[200,90,200] };
  e.waitUntil(self.registration.showNotification(title,opts));
});
self.addEventListener('notificationclick', function(e){
  e.notification.close();
  e.waitUntil(self.clients.matchAll({type:'window',includeUncontrolled:true}).then(function(cl){
    for(var i=0;i<cl.length;i++){ if('focus' in cl[i]) return cl[i].focus(); }
    if(self.clients.openWindow) return self.clients.openWindow('./');
  }));
});
