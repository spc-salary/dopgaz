  // ==========================================
  // المتغيرات العامة
  // ==========================================
  var SESSION_KEY  = 'gas_session_token'; // sessionStorage — ينتهي عند إغلاق المتصفح
  var REMEMBER_KEY = 'gas_remember_me';   // localStorage  — يبقى 30 يوماً (تذكرني)
  var REMEMBER_DAYS = 30;                 // مدة صلاحية "تذكرني" بالأيام
  var USER_KEY     = 'gas_user_data';
  var currentUser       = null;
  var sessionToken      = null;
  var canManageWorkersUi     = false; // تحكم واجهة فقط — القيد الحقيقي من الخادم
  var canViewWorkerReportsUi = false; // تحكم واجهة فقط — القيد الحقيقي من الخادم
  var currentDayEntries = [];
  var pendingUserId     = null; // يُحفظ لاستخدامه في إنشاء كلمة المرور
  var supDashboardData  = null; // بيانات لوحة تحكم المشرف

  // ==========================================
  // نظام العمل بدون اتصال (Offline Mode)
  // ==========================================
  // ملاحظة أمنية: كل إدخال محفوظ محلياً يُربط بـ ownerUserId (الرقم الذاتي
  // لصاحبه وقت الحفظ). عند المزامنة لا نُزامن سوى إدخالات المستخدم المسجّل
  // دخوله حالياً — هذا يمنع نهائياً تسرّب بيانات مستخدم إلى حساب آخر في حال
  // استخدام أكثر من مستخدم لنفس الجهاز/المتصفح.
  var OFFLINE_DB_NAME    = 'GasOfflineWorkDB';
  var OFFLINE_STORE_NAME = 'pendingEntries';
  var offlineDbPromise   = null;   // Promise<IDBDatabase> أو null عند عدم توفر IndexedDB
  var offlineFallbackKey = 'gas_offline_queue_fallback'; // احتياطي عبر localStorage
  var connectionState    = 'online'; // online | offline | syncing | synced
  var syncInFlight        = false;
  var syncRetryTimer      = null;

  // ==========================================
  // تهيئة التطبيق عند التحميل
  // ==========================================
  // ------------------------------------------
  // طبقة التخزين المحلي — IndexedDB مع احتياطي localStorage
  // ------------------------------------------
  function openOfflineDb_() {
    if (offlineDbPromise) return offlineDbPromise;
    if (!('indexedDB' in window)) { offlineDbPromise = Promise.resolve(null); return offlineDbPromise; }
    offlineDbPromise = new Promise(function (resolve) {
      try {
        var req = indexedDB.open(OFFLINE_DB_NAME, 1);
        req.onupgradeneeded = function (e) {
          var db = e.target.result;
          if (!db.objectStoreNames.contains(OFFLINE_STORE_NAME)) {
            db.createObjectStore(OFFLINE_STORE_NAME, { keyPath: 'clientId' });
          }
        };
        req.onsuccess = function (e) { resolve(e.target.result); };
        req.onerror   = function () { resolve(null); }; // فشل IndexedDB → نستخدم localStorage احتياطياً
      } catch (e) { resolve(null); }
    });
    return offlineDbPromise;
  }

  function offlineFallbackRead_() {
    try { return JSON.parse(localStorage.getItem(offlineFallbackKey) || '[]'); }
    catch (e) { return []; }
  }
  function offlineFallbackWrite_(list) {
    try { localStorage.setItem(offlineFallbackKey, JSON.stringify(list)); } catch (e) {}
  }

  function offlinePut_(record) {
    return openOfflineDb_().then(function (db) {
      if (!db) {
        var list = offlineFallbackRead_();
        var idx = list.findIndex(function (r) { return r.clientId === record.clientId; });
        if (idx >= 0) list[idx] = record; else list.push(record);
        offlineFallbackWrite_(list);
        return true;
      }
      return new Promise(function (resolve) {
        var tx = db.transaction(OFFLINE_STORE_NAME, 'readwrite');
        tx.objectStore(OFFLINE_STORE_NAME).put(record);
        tx.oncomplete = function () { resolve(true); };
        tx.onerror    = function () { resolve(false); };
      });
    });
  }

  function offlineDelete_(clientId) {
    return openOfflineDb_().then(function (db) {
      if (!db) {
        var list = offlineFallbackRead_().filter(function (r) { return r.clientId !== clientId; });
        offlineFallbackWrite_(list);
        return true;
      }
      return new Promise(function (resolve) {
        var tx = db.transaction(OFFLINE_STORE_NAME, 'readwrite');
        tx.objectStore(OFFLINE_STORE_NAME).delete(clientId);
        tx.oncomplete = function () { resolve(true); };
        tx.onerror    = function () { resolve(false); };
      });
    });
  }

  function offlineGetAll_() {
    return openOfflineDb_().then(function (db) {
      if (!db) return offlineFallbackRead_();
      return new Promise(function (resolve) {
        var tx     = db.transaction(OFFLINE_STORE_NAME, 'readonly');
        var req    = tx.objectStore(OFFLINE_STORE_NAME).getAll();
        req.onsuccess = function () { resolve(req.result || []); };
        req.onerror   = function () { resolve([]); };
      });
    });
  }

  function generateClientId_() {
    return 'off_' + Date.now() + '_' + Math.random().toString(36).slice(2, 10);
  }

  // ------------------------------------------
  // مؤشر حالة الاتصال + شريط التنبيه
  // ------------------------------------------
  function updateConnectionUI(state) {
    connectionState = state;
    var dot    = document.getElementById('connDot');
    var tip    = document.getElementById('connDotTip');
    var banner = document.getElementById('offlineBanner');
    if (!dot) return;

    dot.classList.remove('conn-online', 'conn-offline', 'conn-syncing', 'conn-synced');
    if (state === 'offline') {
      dot.classList.add('conn-offline');
      dot.title = 'لا يوجد اتصال، سيتم حفظ البيانات مؤقتاً حتى عودة الاتصال';
      if (tip) tip.textContent = dot.title;
      if (banner) banner.style.display = 'flex';
    } else if (state === 'syncing') {
      dot.classList.add('conn-syncing');
      dot.title = 'جاري مزامنة البيانات المحفوظة محلياً...';
      if (tip) tip.textContent = dot.title;
      if (banner) banner.style.display = 'none';
    } else if (state === 'synced') {
      dot.classList.add('conn-synced');
      dot.title = 'تمت مزامنة جميع البيانات بنجاح';
      if (tip) tip.textContent = dot.title;
      if (banner) banner.style.display = 'none';
    } else {
      dot.classList.add('conn-online');
      dot.title = 'متصل بالإنترنت';
      if (tip) tip.textContent = dot.title;
      if (banner) banner.style.display = 'none';
    }
  }

  /* عرض رسالة توضيحية عن حالة الاتصال عند الضغط على النقطة — مفيد خصوصاً
     على الشاشات اللمسية التي لا يعمل عليها تلميح "hover". لا تغيّر أي شيء
     في منطق اكتشاف الاتصال، فقط تعرض الحالة الحالية المحفوظة أصلاً. */
  function showConnectionStatusMessage() {
    var dot = document.getElementById('connDot');
    var msg = (dot && dot.title) || 'متصل بالإنترنت';
    var type = connectionState === 'offline' ? 'warning' : (connectionState === 'syncing' ? 'info' : 'success');
    showToast(msg, type);
  }

  // ------------------------------------------
  // إدارة قائمة الانتظار (Offline Queue)
  // ------------------------------------------
  function queueOfflineEntry(workDone, shift) {
    if (!currentUser) return;
    var record = {
      clientId:    generateClientId_(),
      ownerUserId: currentUser.userId, // ← يمنع مزامنة إدخال مستخدم لحساب مستخدم آخر على نفس الجهاز
      workDone:    workDone,
      shift:       shift,
      createdAt:   Date.now(),
      status:      'pending', // pending | syncing | failed
      message:     ''
    };
    offlinePut_(record).then(function () {
      renderOfflineQueue();
      showToast('لا يوجد اتصال بالإنترنت — تم حفظ العمل مؤقتاً وسيتم إرساله تلقائياً عند عودة الاتصال', 'warning');
    });
  }

  function renderOfflineQueue() {
    offlineGetAll_().then(function (records) {
      var mine = (records || []).filter(function (r) { return currentUser && r.ownerUserId === currentUser.userId; })
        .sort(function (a, b) { return a.createdAt - b.createdAt; });

      var wrap = document.getElementById('offlineQueue');
      var list = document.getElementById('offlineQueueList');
      if (!wrap || !list) return;

      if (mine.length === 0) { wrap.style.display = 'none'; list.innerHTML = ''; return; }
      wrap.style.display = 'block';

      var statusMap = {
        pending: { cls: 'st-pending', icon: 'schedule',      label: 'بانتظار المزامنة' },
        syncing: { cls: 'st-syncing', icon: 'sync',           label: 'جاري الإرسال'     },
        failed:  { cls: 'st-failed',  icon: 'error_outline',  label: 'فشل الإرسال'      }
      };

      list.innerHTML = mine.map(function (r) {
        var s = statusMap[r.status] || statusMap.pending;
        var retryBtn = r.status === 'failed'
          ? '<button class="queue-retry-btn" title="إعادة المحاولة" onclick="retryOfflineEntry(\'' + r.clientId + '\')"><span class="material-icons">refresh</span></button>'
          : '';
        return '<div class="queue-item">'
          + '<div class="queue-item-text">' + escHtml(r.workDone) + '</div>'
          + '<div class="queue-item-meta">'
          +   '<span class="queue-status ' + s.cls + '"><span class="material-icons">' + s.icon + '</span>' + s.label + '</span>'
          +   retryBtn
          + '</div>'
          + '</div>';
      }).join('');
    });
  }

  function retryOfflineEntry(clientId) {
    if (!navigator.onLine) { showToast('لا يوجد اتصال بالإنترنت حالياً', 'warning'); return; }
    syncPendingEntries();
  }

  // ------------------------------------------
  // المزامنة التلقائية (Auto Sync)
  // ------------------------------------------
  function syncPendingEntries() {
    if (syncInFlight || !navigator.onLine || !currentUser || !sessionToken) return;

    offlineGetAll_().then(function (records) {
      var mine = (records || []).filter(function (r) {
        return r.ownerUserId === currentUser.userId && (r.status === 'pending' || r.status === 'failed');
      });
      if (mine.length === 0) return;

      syncInFlight = true;
      var previousState = connectionState;
      updateConnectionUI('syncing');

      var updates = mine.map(function (r) { r.status = 'syncing'; r.message = ''; return offlinePut_(r); });
      Promise.all(updates).then(function () {
        renderOfflineQueue();

        var batch = mine.map(function (r) {
          return { clientId: r.clientId, workDone: r.workDone, shift: r.shift, createdAt: r.createdAt };
        });

        google.script.run
          .withSuccessHandler(function (result) {
            syncInFlight = false;
            if (!result || !result.success) {
              // فشل عام (مثل انتهاء الجلسة) — نُرجع كل السجلات إلى "بانتظار المزامنة"
              Promise.all(mine.map(function (r) { r.status = 'failed'; r.message = result ? result.message : 'فشل غير معروف'; return offlinePut_(r); }))
                .then(renderOfflineQueue);
              updateConnectionUI(navigator.onLine ? 'online' : 'offline');
              if (result && result.message && result.message.indexOf('جلسة') !== -1) handleSessionExpiry();
              return;
            }

            var successCount = 0;
            var byId = {};
            (result.results || []).forEach(function (r) { byId[r.clientId] = r; });

            Promise.all(mine.map(function (r) {
              var res = byId[r.clientId];
              if (res && res.success) {
                successCount++;
                return offlineDelete_(r.clientId);
              }
              r.status  = 'failed';
              r.message = res ? res.message : 'تعذّرت المزامنة';
              return offlinePut_(r);
            })).then(function () {
              renderOfflineQueue();
              if (successCount > 0) showToast('تمت مزامنة ' + successCount + ' إدخال بنجاح', 'success');
              offlineGetAll_().then(function (rest) {
                var stillPending = rest.some(function (r) { return r.ownerUserId === currentUser.userId && r.status !== 'syncing'; });
                if (stillPending) {
                  updateConnectionUI('online');
                } else {
                  updateConnectionUI('synced');
                  setTimeout(function () { updateConnectionUI(navigator.onLine ? 'online' : 'offline'); }, 2200);
                }
              });
            });
          })
          .withFailureHandler(function () {
            syncInFlight = false;
            // تعذّر الاتصال بالخادم (اتصال ضعيف/منقطع فعلياً) — نُرجع الحالة إلى "بانتظار المزامنة" لإعادة المحاولة لاحقاً
            Promise.all(mine.map(function (r) { r.status = 'pending'; r.message = ''; return offlinePut_(r); }))
              .then(renderOfflineQueue);
            updateConnectionUI(navigator.onLine ? 'online' : 'offline');
          })
          .syncOfflineEntries(sessionToken, batch);
      });
    });
  }

  // ------------------------------------------
  // أحداث الاتصال بالإنترنت
  // ------------------------------------------
  window.addEventListener('online', function () {
    updateConnectionUI('online');
    if (currentUser) { showToast('عاد الاتصال بالإنترنت، جاري مزامنة البيانات المحفوظة محلياً...', 'info'); syncPendingEntries(); }
  });
  window.addEventListener('offline', function () {
    updateConnectionUI('offline');
    showToast('انقطع الاتصال بالإنترنت — سيتم حفظ أي عمل جديد محلياً ومزامنته تلقائياً لاحقاً', 'warning');
  });

  // فحص دوري احتياطي: يغطي حالات الاتصال الضعيف/المتقطع التي لا تُطلق
  // أحداث online/offline بشكل موثوق في بعض المتصفحات.
  syncRetryTimer = setInterval(function () {
    if (navigator.onLine && currentUser) syncPendingEntries();
  }, 25000);

  window.onload = function () {
    setSplashState(18, 'التهيئة الأولية', 'جارٍ تجهيز بيئة العمل...');
    var savedTheme = localStorage.getItem('theme') || 'light';
    applyTheme(savedTheme);
    setSplashState(28, 'تجهيز الواجهة', 'جارٍ تحميل إعدادات العرض...');

    /*
     * ترتيب الأولوية في التحقق من الجلسة:
     * 1) localStorage (تذكرني) — يبقى بعد إغلاق المتصفح لمدة 30 يوماً
     * 2) sessionStorage (جلسة عادية) — ينتهي عند إغلاق المتصفح
     * في كلتا الحالتين يتحقق الخادم من صحة التوكن قبل السماح بالدخول.
     */
    var savedToken = null;
    // نوع إعادة الدخول التلقائي — يُرسَل للخادم فقط ليُسجَّل في Logs،
    // ولا يغيّر أي سلوك في تسجيل الدخول أو الصلاحيات:
    //   'remember' → استُعيدت الجلسة من localStorage (خيار "تذكرني")
    //   'session'  → استُعيدت الجلسة من sessionStorage (نفس تبويب/جلسة المتصفح)
    var restoreType = null;

    try {
      var rememberRaw = localStorage.getItem(REMEMBER_KEY);
      if (rememberRaw) {
        var rememberData = JSON.parse(rememberRaw);
        if (rememberData && rememberData.token && rememberData.expiry) {
          if (Date.now() < rememberData.expiry) {
            savedToken = rememberData.token; // توكن "تذكرني" صالح
            restoreType = 'remember';
          } else {
            localStorage.removeItem(REMEMBER_KEY); // انتهت صلاحيته
          }
        }
      }
    } catch (e) {
      localStorage.removeItem(REMEMBER_KEY);
    }

    if (!savedToken) {
      savedToken = sessionStorage.getItem(SESSION_KEY);
      if (savedToken) restoreType = 'session';
    }
    setSplashState(savedToken ? 45 : 58, savedToken ? 'فحص الجلسة' : 'تجهيز الدخول', savedToken ? 'جارٍ التحقق من جلسة المستخدم...' : 'جارٍ تجهيز شاشة تسجيل الدخول...');

    if (savedToken) {
      sessionToken = savedToken;

      // ── وضع بدون اتصال عند فتح الموقع ──
      // إذا كان المتصفح بدون إنترنت أصلاً عند التحميل، لا فائدة من الانتظار
      // حتى تنتهي مهلة استدعاء الخادم: نستعيد بيانات المستخدم المخزّنة محلياً
      // (من آخر تسجيل دخول ناجح) ونفتح التطبيق مباشرة بوضع عدم الاتصال.
      if (!navigator.onLine) {
        setSplashState(78, 'وضع عدم الاتصال', 'جارٍ استعادة بياناتك المحفوظة...');
        restoreOfflineSession_();
        return;
      }

      setSplashState(62, 'التحقق من الأمان', 'جارٍ الاتصال بالخادم بأمان...');
      google.script.run
        .withSuccessHandler(function (result) {
          setSplashState(92, 'اكتمل التحقق', 'جارٍ فتح بيئة العمل...');
          hideSplash();
          if (result && result.success) {
            currentUser = result.user;
            try { localStorage.setItem(USER_KEY, JSON.stringify(result.user)); } catch (e) {}
            updateConnectionUI('online');
            showApp();
            syncPendingEntries();
          } else {
            /* الجلسة غير صالحة على الخادم — نحذف كل شيء محلياً */
            clearSession();
            showLogin();
          }
        })
        .withFailureHandler(function () {
          setSplashState(82, 'اتصال غير مستقر', 'جارٍ محاولة الاستعادة من البيانات المحلية...');
          hideSplash();
          // فشل الاتصال بالخادم (اتصال ضعيف/متقطع) — نحاول الاستعادة من النسخة
          // المحلية المخزّنة بدلاً من إجبار المستخدم على إعادة تسجيل الدخول.
          if (!restoreOfflineSession_()) { clearSession(); showLogin(); }
        })
        .verifySession(savedToken, restoreType);
    } else {
      updateConnectionUI(navigator.onLine ? 'online' : 'offline');
      setTimeout(function () {
        setSplashState(100, 'جاهز للبدء', 'مرحباً بك — يمكنك تسجيل الدخول الآن');
        hideSplash();
        showLogin();
      }, 1100);
    }
  };

  /* استعادة جلسة مستخدم سبق له تسجيل الدخول، من النسخة المخزّنة محلياً
     (localStorage) دون أي اتصال بالخادم — تُستخدم فقط عند تعذّر الاتصال.
     لا تحمل هذه النسخة كلمة مرور أو أي بيانات حساسة، فقط بيانات العرض
     (الاسم/المكتب/الصلاحيات) التي أرسلها الخادم أصلاً عند آخر تحقق ناجح. */
  function restoreOfflineSession_() {
    try {
      var cached = localStorage.getItem(USER_KEY);
      if (!cached) return false;
      currentUser = JSON.parse(cached);
      if (!currentUser || !currentUser.userId) return false;
    } catch (e) { return false; }

    setSplashState(100, 'تمت الاستعادة', 'تم فتح النظام بالبيانات المحفوظة محلياً');
    hideSplash();
    updateConnectionUI('offline');
    showApp();
    showToast('لا يوجد اتصال بالإنترنت — تم فتح التطبيق ببياناتك المحفوظة محلياً', 'warning');
    renderOfflineQueue();
    return true;
  }

  // ==========================================
  // إدارة الشاشات
  // ==========================================
  function setSplashState(percent, label, message) {
    var bar = document.getElementById('splashProgressBar');
    var percentEl = document.getElementById('splashPercent');
    var labelEl = document.getElementById('splashProgressLabel');
    var statusEl = document.getElementById('splashStatus');
    var safePercent = Math.max(0, Math.min(100, Number(percent) || 0));

    if (bar) bar.style.width = safePercent + '%';
    if (percentEl) percentEl.textContent = Math.round(safePercent) + '%';
    if (labelEl) labelEl.textContent = label || '';
    if (statusEl) {
      statusEl.classList.add('is-changing');
      setTimeout(function () {
        statusEl.textContent = message || '';
        statusEl.classList.remove('is-changing');
      }, 120);
    }
  }

  function hideSplash() {
    var splash = document.getElementById('splash');
    setSplashState(100, 'تم التحميل', 'جارٍ فتح النظام...');
    splash.classList.add('hidden');
    setTimeout(function () { splash.style.display = 'none'; }, 500);
  }

  function showLogin() {
    document.getElementById('loginScreen').classList.add('active');
    document.getElementById('appScreen').classList.remove('active');
    setTimeout(function () { document.getElementById('userId').focus(); }, 300);
  }

  function showApp() {
    document.getElementById('loginScreen').classList.remove('active');
    document.getElementById('appScreen').classList.add('active');
    renderUserCard();
    renderOfflineQueue();
    if (navigator.onLine) loadCurrentMonth();
    // ملاحظة أداء: الملف الشخصي الكامل (userProfileExtra) لا يُجلب هنا فوراً
    // لتفادي طلب شبكة إضافي غير ضروري عند كل تسجيل دخول (Lazy Loading) —
    // يُجلب فقط عند أول ضغط فعلي على "عرض كامل البيانات" (انظر toggleUserProfileExtra).
    document.getElementById('userProfileToggle').style.display = 'flex';
  }

  var userProfileExpanded = false;
  var userProfileLoaded   = false; // منع إعادة الجلب بعد أول تحميل ناجح

  /* بطاقة معلومات المستخدم — جلب كامل البيانات التعريفية المتوفرة للمستخدم
     الحالي من جدول البيانات الرئيسي عبر رقمه الذاتي (Username)، بنفس آلية
     الملف الشخصي للعامل. تُستدعى مرة واحدة فقط، عند أول توسيع للبطاقة. */
  function loadMyProfile() {
    var box = document.getElementById('userProfileExtra');
    box.innerHTML = '<div class="user-profile-row"><span class="user-profile-label">جارٍ التحميل...</span></div>';
    google.script.run
      .withSuccessHandler(function (res) {
        if (res && res.success && res.profile && res.profile.length) {
          userProfileLoaded = true;
          renderMyProfile(res.profile);
        } else {
          box.innerHTML = '<div class="user-profile-row"><span class="user-profile-label">لا تتوفر بيانات إضافية</span></div>';
        }
      })
      .withFailureHandler(function () {
        box.innerHTML = '<div class="user-profile-row"><span class="user-profile-label">تعذر جلب البيانات</span></div>';
      })
      .getMyProfile(sessionToken);
  }

  function renderMyProfile(profile) {
    var box = document.getElementById('userProfileExtra');
    var html = '';
    profile.forEach(function (f) {
      html += '<div class="user-profile-row">' +
        '<span class="user-profile-label">' + escHtml(f.label) + '</span>' +
        '<span class="user-profile-value">' + escHtml(f.value || '—') + '</span></div>';
    });
    box.innerHTML = html;
  }

  function toggleUserProfileExtra() {
    userProfileExpanded = !userProfileExpanded;
    document.getElementById('userProfileExtra').style.display = userProfileExpanded ? 'flex' : 'none';
    var icon = document.querySelector('#userProfileToggle .material-icons');
    if (icon) icon.textContent = userProfileExpanded ? 'expand_less' : 'expand_more';
    if (userProfileExpanded && !userProfileLoaded) loadMyProfile();
  }

  function renderUserCard() {
    document.getElementById('displayName').textContent  = currentUser.name || '—';
    document.getElementById('displayId').textContent    = 'الرقم الذاتي: ' + currentUser.userId;
    document.getElementById('displayOffice').textContent = currentUser.office || '—';
    document.getElementById('displayJob').textContent   = currentUser.jobTitle || '—';

    var badge = document.getElementById('supervisorBadge');
    var label = document.getElementById('supervisorLabel');
    /* تحديد نوع المستخدم من الدور الفعلي (role) القادم من الخادم فقط —
       مصدر الحقيقة الوحيد لكل من التسمية المعروضة وإظهار/إخفاء الأزرار.
       لا اعتماد على أي رقم مستخدم مكتوب في الواجهة إطلاقاً. */
    var role = currentUser.role;
    var isLimitedEditor = role === 'limited_editor';
    var isDivisionHeadSupervisor = role === 'supervisor_division_head';
    var isUnitHeadSupervisor = role === 'supervisor_unit_head';
    var isAnySupervisor = isDivisionHeadSupervisor || isUnitHeadSupervisor;
    var isEditorRole = role === 'editor';

    if (currentUser.isSuperAdmin) {
      /* المشرف الخاص — شارة خاصة لا تكشف هويته لغيره على الشاشة */
      badge.style.display = 'inline-flex';
      badge.style.background = 'linear-gradient(135deg,#7B1FA2,#4A148C)';
      label.textContent = 'مشرف عام';
    } else if (isDivisionHeadSupervisor) {
      badge.style.display = 'inline-flex';
      badge.style.background = '';
      label.textContent = 'مشرف رئيس شعبة';
    } else if (isUnitHeadSupervisor) {
      badge.style.display = 'inline-flex';
      badge.style.background = '';
      label.textContent = 'مشرف رئيس وحدة';
    } else if (isEditorRole) {
      /* المحرر — شارة زرقاء مميزة */
      badge.style.display = 'inline-flex';
      badge.style.background = 'linear-gradient(135deg,#1565C0,#42A5F5)';
      label.textContent = 'محرر';
    } else if (isLimitedEditor) {
      /* المحرر المحدود — شارة خضراء مميزة */
      badge.style.display = 'inline-flex';
      badge.style.background = 'linear-gradient(135deg,#2E7D32,#66BB6A)';
      label.textContent = 'محرر محدود — ' + (currentUser.office || '');
    } else {
      badge.style.display = 'none';
      badge.style.background = '';
    }

    /* لوحة تحكم المشرف — متاحة فقط لمن يملك صلاحية الإحصاءات الكاملة
       (المشرفان الجديدان/المحرر/المشرف العام) — المحرر المحدود مستثنى صراحة */
    var isFullSupervisorUser = currentUser.isSuperAdmin || isAnySupervisor || isEditorRole;

    var supBtn = document.getElementById('supervisorPanelBtn');
    if (supBtn) {
      if (isFullSupervisorUser) supBtn.classList.add('visible');
      else supBtn.classList.remove('visible');
    }
    /* تبويب العاملين — متاح للمشرفين والمحرر والمشرف الخاص والمحرر المحدود
       (المحرر المحدود يرى فقط عاملي مكتبه — القيود تُطبَّق من الخادم) */
    var workersTabBtn = document.getElementById('workersTabBtn');
    if (workersTabBtn) {
      if (isFullSupervisorUser || isLimitedEditor) workersTabBtn.classList.add('visible');
      else workersTabBtn.classList.remove('visible');
    }

    /* داخل تبويب العاملين: إضافة/حذف عامل وعرض التقارير متاحان فقط لمن
       يملك صلاحيات إدارية كاملة — المحرر المحدود يرى القائمة والملف
       الشخصي الأساسي فقط (القيد الحقيقي مُطبَّق من الخادم في كل الحالات). */
    canManageWorkersUi = isFullSupervisorUser;
    canViewWorkerReportsUi = isFullSupervisorUser;
    var manageWorkersBtnEl = document.getElementById('manageWorkersBtn');
    if (manageWorkersBtnEl) {
      manageWorkersBtnEl.style.display = canManageWorkersUi ? 'flex' : 'none';
    }

    /* زر لوحة مراقبة النظام — للمشرف الخاص فقط */
    var saBtn = document.getElementById('superAdminMonitorBtn');
    if (saBtn) {
      saBtn.style.display = currentUser.isSuperAdmin ? 'inline-flex' : 'none';
    }

    /* زر تصدير Excel — يظهر لأصحاب صلاحية exportExcel وفق الدور الفعلي
       القادم من الخادم؛ التحقق الحقيقي يتم من جهة الخادم دوماً */
    var canExportUi = isFullSupervisorUser;
    var exportBtn = document.getElementById('exportExcelBtn');
    if (exportBtn) {
      exportBtn.style.display = canExportUi ? 'flex' : 'none';
    }
  }

  function loadCurrentMonth() {
    google.script.run
      .withSuccessHandler(function (res) {
        if (res && res.success) {
          document.getElementById('currentMonthLabel').textContent = res.sheetName;
        }
      })
      .withFailureHandler(function () {})
      .getCurrentMonth(sessionToken);
  }

  // ==========================================
  // تسجيل الدخول
  // ==========================================
  function doLogin() {
    var userId   = document.getElementById('userId').value.trim();
    var password = document.getElementById('password').value;

    if (!userId)   { showLoginError('الرجاء إدخال الرقم الذاتي'); return; }
    if (!password) { showLoginError('الرجاء إدخال كلمة المرور'); return; }

    setLoginLoading(true);
    hideLoginError();

    google.script.run
      .withSuccessHandler(function (result) {
        setLoginLoading(false);

        if (result && result.success) {
          /* تسجيل دخول ناجح */
          sessionToken = result.token;
          currentUser  = result.user;
          try { localStorage.setItem(USER_KEY, JSON.stringify(result.user)); } catch (e) {}
          updateConnectionUI(navigator.onLine ? 'online' : 'offline');

          /* حفظ الجلسة حسب اختيار "تذكرني" */
          var rememberMe = document.getElementById('rememberMe').checked;
          try {
            if (rememberMe) {
              /* localStorage — يبقى 30 يوماً حتى بعد إغلاق المتصفح */
              var expiry = Date.now() + REMEMBER_DAYS * 24 * 60 * 60 * 1000;
              localStorage.setItem(REMEMBER_KEY, JSON.stringify({ token: result.token, expiry: expiry }));
              sessionStorage.removeItem(SESSION_KEY);
            } else {
              /* sessionStorage — ينتهي عند إغلاق المتصفح */
              sessionStorage.setItem(SESSION_KEY, result.token);
              localStorage.removeItem(REMEMBER_KEY);
            }
          } catch (storageErr) {
            /* بعض المتصفحات تمنع التخزين في وضع التصفح الخاص — نكمل الجلسة في الذاكرة */
            console.warn('تعذّر حفظ الجلسة محلياً:', storageErr);
          }

          document.getElementById('userId').value   = '';
          document.getElementById('password').value = '';
          showApp();
          showToast('مرحباً ' + currentUser.name, 'success');

        } else if (result && result.needsSetup) {
          /* لا توجد كلمة مرور — نفتح مودال الإنشاء */
          pendingUserId = userId;
          openSetPasswordModal();

        } else {
          showLoginError(result ? result.message : 'خطأ في الاتصال');
        }
      })
      .withFailureHandler(function () {
        setLoginLoading(false);
        showLoginError('خطأ في الاتصال بالخادم');
      })
      .login(userId, password, 'يدوي'); // تسجيل دخول يدوي دائماً هنا (إدخال بيانات الاعتماد بالنموذج)
  }

  document.getElementById('userId').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') document.getElementById('password').focus();
  });
  document.getElementById('password').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') doLogin();
  });

  function setLoginLoading(isLoading) {
    document.getElementById('loginBtn').disabled = isLoading;
    document.getElementById('loginBtnText').style.display  = isLoading ? 'none' : 'inline';
    document.getElementById('loginSpinner').style.display  = isLoading ? 'inline' : 'none';
  }
  function showLoginError(msg) {
    var el = document.getElementById('loginError');
    el.textContent   = msg;
    el.style.display = 'block';
  }
  function hideLoginError() {
    document.getElementById('loginError').style.display = 'none';
  }

  // ==========================================
  // إنشاء كلمة المرور (أول مرة)
  // ==========================================
  function openSetPasswordModal() {
    document.getElementById('newPassword').value     = '';
    document.getElementById('confirmPassword').value = '';
    document.getElementById('pwStrengthFill').style.width = '0%';
    document.getElementById('pwStrengthText').textContent = '';
    openModal('setPasswordModal');
    setTimeout(function () { document.getElementById('newPassword').focus(); }, 200);
  }

  function cancelSetPassword() {
    pendingUserId = null;
    closeModal('setPasswordModal');
  }

  function doSetPassword() {
    var newPw     = document.getElementById('newPassword').value;
    var confirmPw = document.getElementById('confirmPassword').value;

    if (!newPw)     { showToast('الرجاء إدخال كلمة المرور الجديدة', 'warning'); return; }
    if (!confirmPw) { showToast('الرجاء تأكيد كلمة المرور', 'warning'); return; }
    if (newPw !== confirmPw) {
      showToast('كلمة المرور وتأكيدها غير متطابقَيْن', 'error');
      document.getElementById('confirmPassword').focus();
      return;
    }
    if (!pendingUserId) {
      showToast('حدث خطأ، أعد المحاولة', 'error');
      closeModal('setPasswordModal');
      return;
    }

    setSetPwLoading(true);

    google.script.run
      .withSuccessHandler(function (result) {
        setSetPwLoading(false);
        if (result && result.success) {
          closeModal('setPasswordModal');
          showToast('تم إنشاء كلمة المرور بنجاح — يمكنك الآن تسجيل الدخول', 'success');
          /* ملء حقل الرقم الذاتي تلقائياً لتسهيل تسجيل الدخول */
          document.getElementById('userId').value   = pendingUserId;
          document.getElementById('password').value = '';
          pendingUserId = null;
          document.getElementById('password').focus();
        } else {
          showToast(result ? result.message : 'فشل إنشاء كلمة المرور', 'error');
        }
      })
      .withFailureHandler(function () {
        setSetPwLoading(false);
        showToast('خطأ في الاتصال بالخادم', 'error');
      })
      .createPassword(pendingUserId, newPw);
  }

  function setSetPwLoading(isLoading) {
    document.getElementById('setPwBtn').disabled = isLoading;
    document.getElementById('setPwBtnText').style.display  = isLoading ? 'none' : 'inline';
    document.getElementById('setPwSpinner').style.display  = isLoading ? 'inline' : 'none';
  }

  document.getElementById('newPassword').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') document.getElementById('confirmPassword').focus();
  });
  document.getElementById('confirmPassword').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') doSetPassword();
  });

  /* مؤشر قوة كلمة المرور */
  function checkPasswordStrength(pw) {
    var fill = document.getElementById('pwStrengthFill');
    var text = document.getElementById('pwStrengthText');
    if (!pw) { fill.style.width = '0%'; text.textContent = ''; fill.style.background = ''; return; }

    var score = 0;
    if (pw.length >= 6) score++;
    if (pw.length >= 10) score++;
    if (/[A-Za-z]/.test(pw) && /[0-9]/.test(pw)) score++;
    if (/[^A-Za-z0-9]/.test(pw)) score++;

    var configs = [
      { pct: '25%', color: '#E53935', label: 'ضعيفة جداً' },
      { pct: '50%', color: '#FB8C00', label: 'ضعيفة' },
      { pct: '75%', color: '#FDD835', label: 'متوسطة' },
      { pct: '100%', color: '#43A047', label: 'قوية' }
    ];
    var cfg = configs[Math.min(score, 3)];
    fill.style.width      = cfg.pct;
    fill.style.background = cfg.color;
    text.textContent      = cfg.label;
    text.style.color      = cfg.color;
  }

  // ==========================================
  // تسجيل الخروج
  // ==========================================
  function doLogout() {
    showConfirmDialog({
      type:        'warning',
      icon:        'logout',
      title:       'تسجيل الخروج',
      message:     'هل أنت متأكد من رغبتك بتسجيل الخروج من النظام؟',
      confirmText: 'خروج',
      cancelText:  'إلغاء',
      onConfirm: function () {
        google.script.run
          .withSuccessHandler(function () {})
          .withFailureHandler(function () {})
          .logout(sessionToken);
        clearSession();
        showLogin();
        showToast('تم تسجيل الخروج بنجاح', 'info');
      }
    });
  }

  function clearSession() {
    /* حذف الجلسة من كلا المخزنَيْن */
    sessionStorage.removeItem(SESSION_KEY);
    localStorage.removeItem(REMEMBER_KEY);
    sessionToken     = null;
    currentUser      = null;
    supDashboardData = null;
  }

  // ==========================================
  // لوحة الإدارة — Admin Drawer
  // ==========================================
  function openAdminPanel() {
    if (!currentUser) return;

    /* تعبئة بيانات المستخدم */
    document.getElementById('adminDisplayName').textContent   = currentUser.name     || '—';
    document.getElementById('adminDisplayId').textContent     = 'الرقم الذاتي: ' + currentUser.userId;
    document.getElementById('adminDisplayOffice').textContent = currentUser.office   || '—';
    document.getElementById('adminDisplayJob').textContent    = currentUser.jobTitle || '—';

    /* إعادة ضبط نموذج تغيير كلمة المرور */
    document.getElementById('currentPwd').value                      = '';
    document.getElementById('newPwd').value                          = '';
    document.getElementById('confirmPwd').value                      = '';
    document.getElementById('changePwStrengthFill').style.width      = '0%';
    document.getElementById('changePwStrengthFill').style.background = '';
    document.getElementById('changePwStrengthText').textContent      = '';
    document.getElementById('changePwError').style.display           = 'none';

    /* إعادة ضبط قسم الإحصاءات */
    document.getElementById('statSkeletonGrid').style.display = 'grid';
    document.getElementById('statCardsGrid').style.display    = 'none';
    document.getElementById('statError').style.display        = 'none';
    document.getElementById('statTotal').textContent  = '0';
    document.getElementById('statMonth').textContent  = '0';
    document.getElementById('statLastDate').textContent = '—';
    document.getElementById('statLastMod').textContent  = '—';

    document.getElementById('adminOverlay').classList.add('open');
    document.getElementById('adminDrawer').classList.add('open');
    document.body.style.overflow = 'hidden';

    /* تحميل الإحصاءات */
    loadActivitySummary();

    setTimeout(function () { document.getElementById('currentPwd').focus(); }, 380);
  }

  function closeAdminPanel() {
    document.getElementById('adminOverlay').classList.remove('open');
    document.getElementById('adminDrawer').classList.remove('open');
    document.body.style.overflow = '';
  }

  // ==========================================
  // ملخص النشاط — Activity Summary
  // ==========================================

  function loadActivitySummary() {
    google.script.run
      .withSuccessHandler(function (res) {
        if (!res || !res.success) {
          document.getElementById('statSkeletonGrid').style.display = 'none';
          document.getElementById('statError').style.display        = 'block';
          document.getElementById('statError').textContent =
            res ? res.message : 'تعذّر تحميل الإحصاءات';
          return;
        }
        renderActivityStats(res);
      })
      .withFailureHandler(function () {
        document.getElementById('statSkeletonGrid').style.display = 'none';
        document.getElementById('statError').style.display        = 'block';
        document.getElementById('statError').textContent = 'خطأ في الاتصال بالخادم';
      })
      .getActivitySummary(sessionToken);
  }

  function renderActivityStats(data) {
    /* إخفاء الـ skeleton وإظهار البطاقات */
    document.getElementById('statSkeletonGrid').style.display = 'none';
    document.getElementById('statCardsGrid').style.display    = 'grid';

    /* تحديث القيم النصية مباشرة */
    document.getElementById('statLastDate').textContent = data.lastReportDate  || '—';
    document.getElementById('statLastMod').textContent  = data.lastModifiedDate || '—';

    /* تحريك الأرقام */
    animateCount('statTotal', data.totalReports        || 0, 900);
    animateCount('statMonth', data.currentMonthReports || 0, 750);

    /* انيميشن ظهور البطاقات بتسلسل */
    var cards = document.querySelectorAll('#statCardsGrid .stat-card');
    cards.forEach(function (card, idx) {
      card.style.opacity   = '0';
      card.style.transform = 'translateY(14px)';
      card.style.transition = 'opacity 0.35s ease, transform 0.35s ease';
      setTimeout(function () {
        card.style.opacity   = '1';
        card.style.transform = 'translateY(0)';
      }, 60 + idx * 70);
    });
  }

  function animateCount(elId, target, duration) {
    var el    = document.getElementById(elId);
    if (!el)  return;
    if (target === 0) { el.textContent = '0'; return; }
    var start     = 0;
    var startTime = null;
    function step(timestamp) {
      if (!startTime) startTime = timestamp;
      var progress = Math.min((timestamp - startTime) / duration, 1);
      /* easeOut cubic */
      var ease     = 1 - Math.pow(1 - progress, 3);
      el.textContent = Math.round(ease * target);
      if (progress < 1) requestAnimationFrame(step);
      else el.textContent = target;
    }
    requestAnimationFrame(step);
  }

  /* إغلاق اللوحات بضغطة Escape */
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
      if (document.getElementById('saPanel').classList.contains('open')) {
        closeSuperAdminPanel();
      } else if (document.getElementById('supPanel').classList.contains('open')) {
        closeSupervisorPanel();
      } else if (document.getElementById('adminDrawer').classList.contains('open')) {
        closeAdminPanel();
      }
    }
  });

  /* مؤشر قوة كلمة المرور في لوحة الإدارة */
  function checkNewPwStrength(pw) {
    var fill = document.getElementById('changePwStrengthFill');
    var text = document.getElementById('changePwStrengthText');
    if (!pw) { fill.style.width = '0%'; text.textContent = ''; fill.style.background = ''; return; }

    var score = 0;
    if (pw.length >= 6)  score++;
    if (pw.length >= 10) score++;
    if (/[A-Za-z]/.test(pw) && /[0-9]/.test(pw)) score++;
    if (/[^A-Za-z0-9]/.test(pw)) score++;

    var configs = [
      { pct: '25%',  color: '#E53935', label: 'ضعيفة جداً' },
      { pct: '50%',  color: '#FB8C00', label: 'ضعيفة'      },
      { pct: '75%',  color: '#FDD835', label: 'متوسطة'     },
      { pct: '100%', color: '#43A047', label: 'قوية'        }
    ];
    var cfg = configs[Math.min(score, 3)];
    fill.style.width      = cfg.pct;
    fill.style.background = cfg.color;
    text.textContent      = cfg.label;
    text.style.color      = cfg.color;
  }

  /* تغيير كلمة المرور */
  function doChangePassword() {
    var currentPwd = document.getElementById('currentPwd').value;
    var newPwd     = document.getElementById('newPwd').value;
    var confirmPwd = document.getElementById('confirmPwd').value;

    document.getElementById('changePwError').style.display = 'none';

    if (!currentPwd) { showChangePwError('الرجاء إدخال كلمة المرور الحالية');      return; }
    if (!newPwd)     { showChangePwError('الرجاء إدخال كلمة المرور الجديدة');      return; }
    if (!confirmPwd) { showChangePwError('الرجاء تأكيد كلمة المرور الجديدة');      return; }
    if (newPwd !== confirmPwd) {
      showChangePwError('كلمة المرور الجديدة وتأكيدها غير متطابقَيْن'); return;
    }
    if (newPwd === currentPwd) {
      showChangePwError('كلمة المرور الجديدة يجب أن تختلف عن الحالية'); return;
    }

    setChangePwLoading(true);

    /* نحفظ اسم المستخدم قبل استدعاء clearSession الذي يصفّره */
    var savedUserId = currentUser ? currentUser.userId : '';

    google.script.run
      .withSuccessHandler(function (result) {
        setChangePwLoading(false);
        if (result && result.success) {
          closeAdminPanel();
          showToast('تم تغيير كلمة المرور — يرجى تسجيل الدخول مجدداً', 'success');
          /* تأخير قصير ليرى المستخدم رسالة النجاح ثم تُمسح الجلسة */
          setTimeout(function () {
            clearSession();
            showLogin();
            document.getElementById('userId').value   = savedUserId;
            document.getElementById('password').value = '';
          }, 1600);
        } else {
          showChangePwError(result ? result.message : 'فشل تغيير كلمة المرور');
        }
      })
      .withFailureHandler(function () {
        setChangePwLoading(false);
        showChangePwError('خطأ في الاتصال بالخادم');
      })
      .changePassword(sessionToken, currentPwd, newPwd);
  }

  function showChangePwError(msg) {
    var el = document.getElementById('changePwError');
    el.textContent   = msg;
    el.style.display = 'block';
  }

  function setChangePwLoading(isLoading) {
    document.getElementById('changePwBtn').disabled             = isLoading;
    document.getElementById('changePwBtnText').style.display    = isLoading ? 'none'   : 'inline';
    document.getElementById('changePwSpinner').style.display    = isLoading ? 'inline' : 'none';
  }

  // ==========================================
  // إرسال الأعمال
  // ==========================================
  function submitWork() {
    var workDone = document.getElementById('workDone').value.trim();
    var shift    = document.getElementById('shiftSelect').value;

    if (!workDone) { showToast('الرجاء إدخال الأعمال المنفذة', 'warning'); return; }
    if (!shift)    { showToast('الرجاء اختيار نوع الدوام', 'warning');     return; }

    // ── وضع بدون اتصال: لا فائدة من محاولة الاتصال بالخادم إن كان
    // المتصفح نفسه يعلم بعدم وجود إنترنت — نحفظ الإدخال محلياً فوراً ──
    if (!navigator.onLine) {
      queueOfflineEntry(workDone, shift);
      document.getElementById('workDone').value    = '';
      document.getElementById('shiftSelect').value = '';
      return;
    }

    setSubmitLoading(true);

    google.script.run
      .withSuccessHandler(function (result) {
        setSubmitLoading(false);
        if (result && result.success) {
          document.getElementById('workDone').value    = '';
          document.getElementById('shiftSelect').value = '';
          showToast('تم الحفظ بنجاح ليوم ' + result.dateStr, 'success');
        } else {
          showToast(result ? result.message : 'فشل الحفظ', 'error');
          if (result && result.message && result.message.includes('جلسة')) {
            handleSessionExpiry();
          }
        }
      })
      .withFailureHandler(function () {
        setSubmitLoading(false);
        // فشل الاتصال بالخادم فعلياً (اتصال ضعيف/انقطع للتو رغم أن المتصفح
        // كان يظن أنه متصل) — لا نُفقد بيانات المستخدم، نحفظها محلياً بدلاً
        // من مجرد إظهار رسالة خطأ.
        queueOfflineEntry(workDone, shift);
        document.getElementById('workDone').value    = '';
        document.getElementById('shiftSelect').value = '';
        updateConnectionUI('offline');
      })
      .submitWork(sessionToken, workDone, shift);
  }

  function setSubmitLoading(isLoading) {
    document.getElementById('submitBtn').disabled = isLoading;
    document.getElementById('submitBtnText').style.display = isLoading ? 'none' : 'inline';
    document.getElementById('submitSpinner').style.display = isLoading ? 'inline' : 'none';
  }

  // ==========================================
  // التبويبات
  // ==========================================
  // ==========================================
  // تبويب العاملين — Workers Tab
  // ==========================================

  function loadWorkersList() {
    var view = document.getElementById('workersListView');
    var rView = document.getElementById('workerReportsView');
    rView.style.display = 'none';
    view.style.display  = 'block';
    view.innerHTML =
      '<div class="empty-state"><span class="material-icons">hourglass_empty</span>' +
      '<p>جارٍ تحميل قائمة العاملين...</p></div>';

    google.script.run
      .withSuccessHandler(function (res) {
        if (!res || !res.success) {
          view.innerHTML =
            '<div class="empty-state"><span class="material-icons">error_outline</span>' +
            '<p>' + escHtml(res ? res.message : 'خطأ في الاتصال بالخادم') + '</p></div>';
          return;
        }
        renderWorkersList(res.workers || []);
      })
      .withFailureHandler(function () {
        view.innerHTML =
          '<div class="empty-state"><span class="material-icons">error_outline</span>' +
          '<p>خطأ في الاتصال بالخادم</p></div>';
      })
      .getWorkersList(sessionToken);
  }

  function renderWorkersList(workers) {
    var view = document.getElementById('workersListView');
    if (!workers || workers.length === 0) {
      view.innerHTML =
        '<div class="empty-state"><span class="material-icons">people_outline</span>' +
        '<p>لا يوجد عاملون مسجلون</p></div>';
      return;
    }

    var html = '<div class="workers-table-wrapper">' +
      '<table class="workers-table"><thead><tr>' +
      '<th>#</th><th>الاسم</th><th>الرقم الذاتي</th><th>الشعبة / الوحدة</th><th>المسمى الوظيفي</th><th></th>' +
      '</tr></thead><tbody>';

    workers.forEach(function (w, idx) {
      html += '<tr>' +
        '<td style="color:var(--text-muted);font-weight:700;">' + (idx + 1) + '</td>' +
        '<td>' +
        '<button class="btn-worker-name" type="button"' +
        ' data-worker-id="' + escHtml(w.userId) + '"' +
        ' data-worker-name="' + escHtml(w.name) + '"' +
        ' title="عرض الملف الشخصي">' +
        '<span class="material-icons">person</span>' + escHtml(w.name) + '</button>' +
        '</td>' +
        '<td style="direction:ltr;text-align:right;">' + escHtml(w.userId) + '</td>' +
        '<td>' + escHtml(w.office || '—') + '</td>' +
        '<td>' + escHtml(w.jobTitle || '—') + '</td>' +
        '<td>' +
        // زر عرض التقارير: يظهر فقط لمن يملك صلاحية إدارية كاملة (المحرر
        // المحدود مستثنى) — القيد الحقيقي مُطبَّق من الخادم في getWorkerReports
        (canViewWorkerReportsUi ?
          '<button class="btn-view-reports"' +
          ' data-worker-id="' + escHtml(w.userId) + '"' +
          ' data-worker-name="' + escHtml(w.name) + '">' +
          '<span class="material-icons">bar_chart</span>عرض التقارير</button>' : '') +
        '</td></tr>';
    });

    html += '</tbody></table></div>';
    view.innerHTML = html;

    /* استخدام تفويض الأحداث بدلاً من onclick مباشرة — آمن مع القيم العشوائية */
    view.addEventListener('click', function handleViewClick(e) {
      var reportsBtn = e.target.closest('.btn-view-reports');
      if (reportsBtn) {
        view.removeEventListener('click', handleViewClick);
        showWorkerReports(reportsBtn.dataset.workerId, reportsBtn.dataset.workerName);
        return;
      }
      var nameBtn = e.target.closest('.btn-worker-name');
      if (nameBtn) {
        openWorkerProfile(nameBtn.dataset.workerId, nameBtn.dataset.workerName);
      }
    });
  }

  // ==========================================
  // نافذة إضافة / حذف / تعديل / استدعاء عامل
  // ==========================================
  var workerModalMode = 'add'; // 'add' | 'edit' — يتحدد بعد نجاح الاستدعاء
  var workerBusy = false;      // منع الضغط المتكرر أثناء تنفيذ عملية

  function openWorkerModal() {
    resetWorkerForm();
    openModal('workerModal');
  }

  function closeWorkerModal() {
    closeModal('workerModal');
    resetWorkerForm();
  }

  function resetWorkerForm() {
    workerModalMode = 'add';
    ['workerFormUserId', 'workerFormName', 'workerFormOffice', 'workerFormJobTitle'].forEach(function (id) {
      var el = document.getElementById(id);
      el.value = '';
      el.classList.remove('has-error');
    });
    document.getElementById('workerFormUserId').removeAttribute('readonly');
    clearWorkerFieldErrors();
    document.getElementById('workerAddBtn').style.display    = '';
    document.getElementById('workerUpdateBtn').style.display = 'none';
    document.getElementById('workerDeleteBtn').style.display = 'none';
  }

  function clearWorkerFieldErrors() {
    ['workerFormUserId', 'workerFormName'].forEach(function (id) {
      document.getElementById(id).classList.remove('has-error');
      var errEl = document.getElementById('err-' + id);
      if (errEl) errEl.classList.remove('show');
    });
  }

  function showWorkerFieldError(id, message) {
    var field = document.getElementById(id);
    field.classList.add('has-error');
    var errEl = document.getElementById('err-' + id);
    if (errEl) {
      if (message) errEl.querySelector('span:last-child').textContent = message;
      errEl.classList.add('show');
    }
  }

  function readWorkerForm() {
    return {
      userId:   document.getElementById('workerFormUserId').value.trim(),
      name:     document.getElementById('workerFormName').value.trim(),
      office:   document.getElementById('workerFormOffice').value.trim(),
      jobTitle: document.getElementById('workerFormJobTitle').value.trim()
    };
  }

  /* منع الضغط المتكرر أثناء تنفيذ أي عملية على العاملين */
  function withWorkerBusyGuard(btnId, textId, spinnerId, fn) {
    if (workerBusy) return;
    workerBusy = true;
    var btn = document.getElementById(btnId), text = document.getElementById(textId), spinner = document.getElementById(spinnerId);
    if (btn) btn.disabled = true;
    if (text) text.style.display = 'none';
    if (spinner) spinner.style.display = 'inline';
    var done = function () {
      workerBusy = false;
      if (btn) btn.disabled = false;
      if (text) text.style.display = '';
      if (spinner) spinner.style.display = 'none';
    };
    fn(done);
  }

  function workerFind() {
    clearWorkerFieldErrors();
    var workerId = document.getElementById('workerFormUserId').value.trim();
    if (!workerId) { showWorkerFieldError('workerFormUserId', 'الرجاء إدخال الرقم الذاتي للاستدعاء'); return; }

    withWorkerBusyGuard('workerFindBtn', 'workerFindText', 'workerFindSpinner', function (done) {
      google.script.run
        .withSuccessHandler(function (res) {
          done();
          if (!res || !res.success) {
            showToast(res ? res.message : 'خطأ في الاتصال بالخادم', 'error');
            return;
          }
          var w = res.worker;
          document.getElementById('workerFormUserId').value   = w.userId;
          document.getElementById('workerFormUserId').setAttribute('readonly', 'readonly');
          document.getElementById('workerFormName').value     = w.name;
          document.getElementById('workerFormOffice').value   = w.office;
          document.getElementById('workerFormJobTitle').value = w.jobTitle;

          workerModalMode = 'edit';
          document.getElementById('workerAddBtn').style.display    = 'none';
          document.getElementById('workerUpdateBtn').style.display = '';
          document.getElementById('workerDeleteBtn').style.display = '';
          showToast('تم العثور على العامل: ' + w.name, 'success');
        })
        .withFailureHandler(function () {
          done();
          showToast('فشل الاتصال بالخادم', 'error');
        })
        .findWorker(sessionToken, workerId);
    });
  }

  function workerAdd() {
    clearWorkerFieldErrors();
    var data = readWorkerForm();
    var hasError = false;
    if (!data.userId) { showWorkerFieldError('workerFormUserId'); hasError = true; }
    if (!data.name)   { showWorkerFieldError('workerFormName');   hasError = true; }
    if (hasError) return;

    withWorkerBusyGuard('workerAddBtn', 'workerAddText', 'workerAddSpinner', function (done) {
      google.script.run
        .withSuccessHandler(function (res) {
          done();
          if (!res || !res.success) {
            showToast(res ? res.message : 'خطأ في الاتصال بالخادم', 'error');
            return;
          }
          showToast(res.message, 'success');
          resetWorkerForm(); // تنظيف الحقول وبقاء النافذة مفتوحة لإضافة عامل آخر
          loadWorkersList();
        })
        .withFailureHandler(function () {
          done();
          showToast('فشل الاتصال بالخادم', 'error');
        })
        .addWorker(sessionToken, data);
    });
  }

  function workerUpdate() {
    if (workerModalMode !== 'edit') { showToast('الرجاء استدعاء العامل أولاً', 'warning'); return; }
    clearWorkerFieldErrors();
    var data = readWorkerForm();
    if (!data.name) { showWorkerFieldError('workerFormName'); return; }

    withWorkerBusyGuard('workerUpdateBtn', 'workerUpdateText', 'workerUpdateSpinner', function (done) {
      google.script.run
        .withSuccessHandler(function (res) {
          done();
          if (!res || !res.success) {
            showToast(res ? res.message : 'خطأ في الاتصال بالخادم', 'error');
            return;
          }
          showToast(res.message, 'success');
          loadWorkersList();
        })
        .withFailureHandler(function () {
          done();
          showToast('فشل الاتصال بالخادم', 'error');
        })
        .updateWorker(sessionToken, data);
    });
  }

  function workerDelete() {
    if (workerModalMode !== 'edit') { showToast('الرجاء استدعاء العامل أولاً', 'warning'); return; }
    var workerId = document.getElementById('workerFormUserId').value.trim();
    var workerName = document.getElementById('workerFormName').value.trim();

    showConfirmDialog({
      type:        'warning',
      icon:        'warning_amber',
      title:       'تأكيد حذف العامل',
      message:     'هل أنت متأكد من حذف العامل "' + workerName + '" (' + workerId + ') نهائياً؟ لا يمكن التراجع عن هذا الإجراء.',
      confirmText: 'حذف',
      cancelText:  'إلغاء',
      onConfirm: function () {
        withWorkerBusyGuard('workerDeleteBtn', 'workerDeleteText', 'workerDeleteSpinner', function (done) {
          google.script.run
            .withSuccessHandler(function (res) {
              done();
              if (!res || !res.success) {
                showToast(res ? res.message : 'خطأ في الاتصال بالخادم', 'error');
                return;
              }
              showToast(res.message, 'success');
              closeWorkerModal();
              loadWorkersList();
            })
            .withFailureHandler(function () {
              done();
              showToast('فشل الاتصال بالخادم', 'error');
            })
            .deleteWorker(sessionToken, workerId);
        });
      }
    });
  }

  // ==========================================
  // نافذة "معلومات العامل" — ملف شخصي كامل من جدول البيانات الرئيسي
  // ==========================================
  function openWorkerProfile(workerId, workerName) {
    var body = document.getElementById('workerProfileBody');
    body.innerHTML =
      '<div class="empty-state"><span class="material-icons">hourglass_empty</span>' +
      '<p>جارٍ تحميل بيانات ' + escHtml(workerName) + '...</p></div>';
    openModal('workerProfileModal');

    google.script.run
      .withSuccessHandler(function (res) {
        if (!res || !res.success) {
          body.innerHTML =
            '<div class="empty-state"><span class="material-icons">error_outline</span>' +
            '<p>' + escHtml(res ? res.message : 'خطأ في الاتصال بالخg�دم') + '</p></div>';
          return;
        }
        renderWorkerProfile(res.profile || [], workerName);
      })
      .withFailureHandler(function () {
        body.innerHTML =
          '<div class="empty-state"><span class="material-icons">error_outline</span>' +
          '<p>خطأ في الاتصال بالخادم</p></div>';
      })
      .getWorkerProfile(sessionToken, workerId);
  }

  function renderWorkerProfile(profile, workerName) {
    var body = document.getElementById('workerProfileBody');
    if (!profile || profile.length === 0) {
      body.innerHTML =
        '<div class="empty-state"><span class="material-icons">person_off</span>' +
        '<p>لم يتم العثور على بيانات العامل</p></div>';
      return;
    }

    var html =
      '<div class="worker-profile-header">' +
      '<div class="worker-profile-avatar"><span class="material-icons">person</span></div>' +
      '<div class="worker-profile-header-text">' +
      '<div class="worker-profile-header-name">' + escHtml(workerName) + '</div>' +
      '<div class="worker-profile-header-sub">الملف الشخصي للعامل</div>' +
      '</div>' +
      '</div>' +
      '<div class="worker-profile-fields">';

    profile.forEach(function (f) {
      var isEmail = /email|بريد/i.test(f.label || '');
      html +=
        '<div class="worker-profile-row' + (isEmail ? ' is-email' : '') + '">' +
        '<span class="worker-profile-label">' + escHtml(f.label) + '</span>' +
        '<span class="worker-profile-value">' + escHtml(f.value || '—') + '</span>' +
        '</div>';
    });

    html += '</div>';
    body.innerHTML = html;
  }

  function showWorkerReports(workerId, workerName) {
    var view  = document.getElementById('workersListView');
    var rView = document.getElementById('workerReportsView');
    view.style.display  = 'none';
    rView.style.display = 'block';

    rView.innerHTML =
      '<div class="worker-reports-header">' +
      '<button class="btn-back-workers" onclick="loadWorkersList()">' +
      '<span class="material-icons">arrow_forward_ios</span>رجوع</button>' +
      '<div class="worker-reports-name">' + escHtml(workerName) + '</div></div>' +
      '<div class="empty-state"><span class="material-icons">hourglass_empty</span>' +
      '<p>جارٍ جلب التقارير...</p></div>';

    google.script.run
      .withSuccessHandler(function (res) {
        if (!res || !res.success) {
          rView.innerHTML =
            '<div class="worker-reports-header">' +
            '<button class="btn-back-workers" onclick="loadWorkersList()">' +
            '<span class="material-icons">arrow_forward_ios</span>رجوع</button>' +
            '<div class="worker-reports-name">' + escHtml(workerName) + '</div></div>' +
            '<div class="empty-state"><span class="material-icons">error_outline</span>' +
            '<p>' + escHtml(res ? res.message : 'خطأ في الاتصال') + '</p></div>';
          return;
        }
        renderWorkerReports(res.entries || [], workerName, res.total || 0);
      })
      .withFailureHandler(function () {
        rView.innerHTML =
          '<div class="worker-reports-header">' +
          '<button class="btn-back-workers" onclick="loadWorkersList()">' +
          '<span class="material-icons">arrow_forward_ios</span>رجوع</button>' +
          '<div class="worker-reports-name">' + escHtml(workerName) + '</div></div>' +
          '<div class="empty-state"><span class="material-icons">error_outline</span>' +
          '<p>خطأ في الاتصال بالخادم</p></div>';
      })
      .getWorkerReports(sessionToken, workerId);
  }

  function renderWorkerReports(entries, workerName, total) {
    var rView = document.getElementById('workerReportsView');

    var header =
      '<div class="worker-reports-header">' +
      '<button class="btn-back-workers" onclick="loadWorkersList()">' +
      '<span class="material-icons">arrow_forward_ios</span>رجوع</button>' +
      '<div class="worker-reports-name">' + escHtml(workerName) + '</div>' +
      (total > 0 ? '<span class="worker-reports-count">' + total + ' إدخال</span>' : '') +
      '</div>';

    if (!entries || entries.length === 0) {
      rView.innerHTML = header +
        '<div class="empty-state"><span class="material-icons">inbox</span>' +
        '<p>لا توجد إدخالات مسجلة لهذا الموظف</p></div>';
      return;
    }

    var cardsHtml = '';
    entries.forEach(function (e) {
      var shiftBadgeClass = 'badge-muted';
      if (e.shift) {
        if (e.shift.indexOf('غير') !== -1) shiftBadgeClass = 'badge-error';
        else if (e.shift.indexOf('مهم') !== -1) shiftBadgeClass = 'badge-warning';
        else shiftBadgeClass = 'badge-success';
      }

      cardsHtml +=
        '<div class="worker-report-card">' +
        '<div class="worker-report-card-header">' +
        '<div>' +
        '<div class="worker-report-date">' + escHtml(e.date || '—') + '</div>' +
        '<div class="worker-report-month">' + escHtml(e.arabicMonth) + ' ' + escHtml(String(e.sheetYear)) + '</div>' +
        '</div>' +
        '<div style="display:flex;gap:6px;flex-wrap:wrap;">' +
        (e.shift ? '<span class="badge ' + shiftBadgeClass + '">' + escHtml(e.shift) + '</span>' : '') +
        (e.office ? '<span class="badge badge-primary">' + escHtml(e.office) + '</span>' : '') +
        '</div>' +
        '</div>' +
        '<div class="worker-report-body">';

      if (e.workDone) {
        cardsHtml +=
          '<div class="worker-report-section">' +
          '<div class="worker-report-label"><span class="material-icons">task_alt</span>الأعمال المنفذة</div>' +
          '<div class="worker-report-text">' + escHtml(e.workDone) + '</div>' +
          '</div>';
      }

      if (e.supervisorNote && e.supervisorNote.trim()) {
        cardsHtml +=
          '<div class="worker-report-section">' +
          '<div class="worker-report-label" style="color:var(--warning);"><span class="material-icons">rate_review</span>ملاحظة المشرف المباشر</div>' +
          '<div class="worker-report-text">' + escHtml(e.supervisorNote) + '</div>' +
          '</div>';
      }

      if (e.chiefRating && e.chiefRating.trim()) {
        cardsHtml +=
          '<div class="worker-report-section">' +
          '<div class="worker-report-label" style="color:var(--primary);"><span class="material-icons">star_rate</span>تقييم رئيس الشعبة</div>' +
          '<div class="worker-report-text">' + escHtml(e.chiefRating) + '</div>' +
          '</div>';
      }

      cardsHtml += '</div></div>';
    });

    rView.innerHTML = header + cardsHtml;
  }

  function switchTab(tabId, el) {
    document.querySelectorAll('.tab-content').forEach(function (t) { t.classList.remove('active'); });
    document.querySelectorAll('.tab').forEach(function (t) { t.classList.remove('active'); });
    document.getElementById(tabId).classList.add('active');
    el.classList.add('active');
  }

  // ==========================================
  // مراجعة الإدخالات
  // ==========================================
  var selectedReviewMonth = '';

  function setReviewEmptyState(message, icon) {
    document.getElementById('entriesContainer').innerHTML =
      '<div class="empty-state"><span class="material-icons">' + (icon || 'event_note') +
      '</span><p>' + escHtml(message) + '</p></div>';
  }

  function resetReviewDaySelect(message) {
    var select = document.getElementById('daySelect');
    select.innerHTML = '<option value="" selected disabled>' + escHtml(message || 'اختر يوماً') + '</option>';
    select.value = '';
  }

  function loadReviewMonths() {
    var monthSelect = document.getElementById('monthSelect');
    var daySelect = document.getElementById('daySelect');
    monthSelect.innerHTML = '<option value="" selected disabled>جارٍ تحميل الشهور...</option>';
    monthSelect.disabled = true;
    daySelect.disabled = true;
    resetReviewDaySelect('اختر الشهر أولاً');
    setReviewEmptyState('اختر الشهر ثم اليوم لعرض الإدخالات', 'calendar_month');

    google.script.run
      .withSuccessHandler(function (result) {
        monthSelect.disabled = false;
        monthSelect.innerHTML = '<option value="" selected disabled>اختر الشهر</option>';

        if (!result || !result.success || !result.sheets || result.sheets.length === 0) {
          monthSelect.innerHTML = '<option value="" selected disabled>لا توجد شيتات شهرية</option>';
          monthSelect.disabled = true;
          resetReviewDaySelect('اختر الشهر أولاً');
          setReviewEmptyState('لا توجد شيتات شهرية متاحة للمراجعة', 'event_busy');
          if (result && result.message) showToast(result.message, 'warning');
          return;
        }

        result.sheets.forEach(function (sheetName) {
          var option = document.createElement('option');
          option.value = sheetName;
          option.textContent = sheetName;
          monthSelect.appendChild(option);
        });

        selectedReviewMonth = result.latestSheetName || result.sheets[0];
        monthSelect.value = selectedReviewMonth;
        onReviewMonthChanged(selectedReviewMonth);
      })
      .withFailureHandler(function () {
        monthSelect.disabled = true;
        monthSelect.innerHTML = '<option value="" selected disabled>خطأ في تحميل الشهور</option>';
        resetReviewDaySelect('اختر الشهر أولاً');
        setReviewEmptyState('تعذر تحميل الشهور من الخادم', 'cloud_off');
        showToast('خطأ في الاتصال بالخادم', 'error');
      })
      .getMonthlySheets(sessionToken);
  }

  function onReviewMonthChanged(sheetName) {
    if (!sheetName) return;
    selectedReviewMonth = sheetName;
    var daySelect = document.getElementById('daySelect');
    daySelect.disabled = true;
    daySelect.innerHTML = '<option value="" selected disabled>جارٍ تحميل الأيام...</option>';
    setReviewEmptyState('جارٍ تحميل أيام ' + sheetName + '...', 'hourglass_empty');
    loadDays(sheetName);
  }

  function loadDays(sheetName) {
    sheetName = sheetName || selectedReviewMonth;
    if (!sheetName) {
      resetReviewDaySelect('اختر الشهر أولاً');
      setReviewEmptyState('اختر الشهر ثم اليوم لعرض الإدخالات', 'calendar_month');
      return;
    }

    var select = document.getElementById('daySelect');
    select.disabled = true;
    select.innerHTML = '<option value="" selected disabled>جارٍ التحميل...</option>';
    setReviewEmptyState('جارٍ تحميل الأيام...', 'hourglass_empty');

    google.script.run
      .withSuccessHandler(function (result) {
        select.disabled = false;
        select.innerHTML = '<option value="" selected disabled>اختر يوماً</option>';
        if (result && result.success && result.days && result.days.length > 0) {
          var cleanDays = result.days.filter(function (day) {
            return day !== null && day !== undefined && String(day).trim() !== '';
          });

          if (cleanDays.length === 0) {
            select.innerHTML = '<option value="" selected disabled>لا توجد إدخالات في هذا الشهر</option>';
            select.disabled = true;
            setReviewEmptyState('لا توجد إدخالات لهذا الشهر', 'event_busy');
            return;
          }

          cleanDays.forEach(function (day) {
            var opt = document.createElement('option');
            opt.value = String(day);
            opt.textContent = String(day);
            select.appendChild(opt);
          });
          setReviewEmptyState('اختر يوماً لعرض الإدخالات', 'event_note');
        } else {
          select.innerHTML = '<option value="" selected disabled>لا توجد إدخالات في هذا الشهر</option>';
          select.disabled = true;
          setReviewEmptyState('لا توجد إدخالات لهذا الشهر', 'event_busy');
          if (result && result.message) showToast(result.message, 'warning');
        }
      })
      .withFailureHandler(function () {
        select.disabled = true;
        select.innerHTML = '<option value="" selected disabled>خطأ في التحميل</option>';
        setReviewEmptyState('تعذر تحميل الأيام من الخادم', 'cloud_off');
        showToast('خطأ في الاتصال بالخادم', 'error');
      })
      .getDaysFromSelectedMonth(sessionToken, sheetName);
  }

  function loadEntriesForDay(dateStr) {
    if (!dateStr) {
      setReviewEmptyState('اختر يوماً لعرض الإدخالات', 'event_note');
      return;
    }

    if (!selectedReviewMonth) {
      showToast('الرجاء اختيار الشهر أولاً', 'warning');
      return;
    }

    setReviewEmptyState('جارٍ تحميل الإدخالات...', 'hourglass_empty');

    google.script.run
      .withSuccessHandler(function (result) {
        if (result && result.success) {
          currentDayEntries = result.entries;
          renderEntries(result.entries);
        } else {
          showToast(result ? result.message : 'خطأ في التحميل', 'error');
        }
      })
      .withFailureHandler(function () {
        showToast('خطأ في الاتصال', 'error');
      })
      .getEntriesForDay(sessionToken, dateStr, selectedReviewMonth);
  }

  function renderEntries(entries) {
    var container = document.getElementById('entriesContainer');
    if (!entries || entries.length === 0) {
      container.innerHTML =
        '<div class="empty-state"><span class="material-icons">inbox</span><p>لا توجد إدخالات لهذا اليوم</p></div>';
      return;
    }

    /* لا يوجد أي قيد زمني على ملاحظات المشرف المباشر أو تقييم رئيس الشعبة.
       القيد الفعلي الوحيد هو RBAC، ويصل من الخادم ضمن كل إدخال عبر
       entry.canEditSupervisor1/2. */

    var html = '<div class="entries-list">';

    entries.forEach(function (entry) {
      var rid         = entry.rowIndex;
      var canEdit     = entry.editableByOwner;
      var canSup1     = entry.canEditSupervisor1;
      var canSup2     = entry.canEditSupervisor2;
      var canEditWork = !!entry.canEditWorkAsSupervisor;

      html += '<div class="entry-card" data-row="' + rid + '">';

      html += '<div class="entry-card-header">';
      html += '<div>';
      html += '<div class="entry-name">' + escHtml(entry.name) + '</div>';
      html += '<div class="entry-meta">' + escHtml(entry.office) + ' &bull; ' + escHtml(entry.date) + '</div>';
      html += '</div>';
      html += '<div class="entry-badges">';
      html += '<span class="badge badge-primary">' + escHtml(entry.shift || '') + '</span>';
      if (entry.isOwner) {
        html += canEdit
          ? '<span class="badge badge-success"><span class="material-icons" style="font-size:12px;">edit</span>قابل للتعديل</span>'
          : '<span class="badge badge-error">انتهت مدة التعديل</span>';
      }
      html += '</div>';
      html += '</div>';

      html += '<div class="entry-section">';
      html += '<div class="entry-section-label label-work"><span class="material-icons">task_alt</span>الأعمال المنفذة</div>';

      html += '<div class="entry-work-display" data-row="' + rid + '">';
      html += '<div class="entry-work-text">' + escHtml(entry.workDone || '') + '</div>';
      if (canEditWork) {
        html += '<div class="entry-section-actions">'
          + '<button class="btn-edit-work-compact entry-btn-edit-work" data-row="' + rid + '">'
          + '<span class="material-icons">edit</span>تعديل العمل المنفذ</button>'
          + '</div>';
      }
      html += '</div>';

      if (canEditWork) {
        html += '<div class="entry-work-edit" data-row="' + rid + '" style="display:none;">';
        html += '<textarea class="textarea-field work-edit-large work-edit-textarea" data-row="' + rid + '">'
          + escHtml(entry.workDone || '') + '</textarea>';
        html += '<div class="entry-section-actions">'
          + '<button class="btn-save-inline work entry-btn-save-work" data-row="' + rid + '">'
          + '<span class="material-icons" style="font-size:16px;">save</span>حفظ</button>'
          + '<button class="btn btn-outline entry-btn-cancel-work" data-row="' + rid + '">إلغاء</button>'
          + '</div>';
        html += '</div>';
      }

      html += '</div>';

      if (entry.hasOwnProperty('supervisorNote')) {
        html += '<div class="entry-section">';
        html += '<div class="entry-section-label label-sup1"><span class="material-icons">rate_review</span>ملاحظات المشرف المباشر</div>';

        if (canSup1) {
          if (entry.supervisorNote && entry.supervisorNote.trim()) {
            html += '<div class="lock-notice" style="background:rgba(251,140,0,0.06);border-color:rgba(251,140,0,0.2);color:var(--warning);">'
              + '<span class="material-icons">edit_note</span>ملاحظة موجودة — يمكنك تعديلها</div>';
          }
          html += '<textarea class="textarea-field small sup1-textarea" data-row="' + rid + '" '
            + 'placeholder="اكتب الملاحظة هنا...">'
            + escHtml(entry.supervisorNote || '') + '</textarea>';
          html += '<div class="entry-section-actions">'
            + '<button class="btn-save-inline sup1 entry-btn-save-sup1" data-row="' + rid + '">'
            + '<span class="material-icons" style="font-size:16px;">save</span>حفظ الملاحظة</button>'
            + '</div>';
        } else {
          // لا يوجد أي قيد زمني على هذه الصلاحية بعد الآن؛ عدم القدرة على
          // التعديل هنا يعني فقط أن المستخدم لا يملك صلاحية RBAC المطلوبة.
          if (entry.supervisorNote && entry.supervisorNote.trim()) {
            html += '<div class="existing-note">' + escHtml(entry.supervisorNote) + '</div>';
          } else {
            html += '<div class="existing-note" style="color:var(--text-muted);">لا توجد ملاحظة بعد</div>';
          }
        }
        html += '</div>';
      }

      if (entry.hasOwnProperty('chiefRating')) {
        html += '<div class="entry-section">';
        html += '<div class="entry-section-label label-sup2"><span class="material-icons">star_rate</span>تقييم رئيس الشعبة</div>';

        if (!canSup2) {
          // لا يوجد أي قيد زمني على هذه الصلاحية بعد الآن؛ عدم القدرة على
          // التعديل هنا يعني فقط أن المستخدم لا يملك صلاحية RBAC المطلوبة.
          if (entry.chiefRating && entry.chiefRating.trim()) {
            html += '<div class="existing-note">' + escHtml(entry.chiefRating) + '</div>';
          } else {
            html += '<div class="existing-note" style="color:var(--text-muted);">لا يوجد تقييم بعد</div>';
          }
        } else {
          if (entry.chiefRating && entry.chiefRating.trim()) {
            html += '<div class="lock-notice" style="background:rgba(21,101,192,0.06);border-color:rgba(21,101,192,0.2);color:var(--primary);">'
              + '<span class="material-icons">edit_note</span>تقييم موجود — يمكنك تعديله</div>';
          }
          html += '<textarea class="textarea-field small sup2-textarea" data-row="' + rid + '" '
            + 'placeholder="اكتب التقييم هنا...">'
            + escHtml(entry.chiefRating || '') + '</textarea>';
          html += '<div class="entry-section-actions">'
            + '<button class="btn-save-inline sup2 entry-btn-save-sup2" data-row="' + rid + '">'
            + '<span class="material-icons" style="font-size:16px;">save</span>حفظ التقييم</button>'
            + '</div>';
        }
        html += '</div>';
      }

      if (entry.isOwner && canEdit) {
        html += '<div class="entry-actions">'
          + '<button class="btn btn-outline entry-btn-edit" data-row="' + rid + '">'
          + '<span class="material-icons" style="font-size:16px;">drive_file_rename_outline</span>تعديل الإدخال</button>'
          + '</div>';
      }

      html += '</div>';
    });

    html += '</div>';
    container.innerHTML = html;
  }

  function saveInlineSupervisorNote(btn, rowIndex, note) {
    btn.disabled = true;
    var origHtml = btn.innerHTML;
    btn.innerHTML = '<span class="spinner"></span>';

    google.script.run
      .withSuccessHandler(function (result) {
        btn.disabled = false;
        btn.innerHTML = origHtml;
        if (result && result.success) {
          showToast('تم حفظ الملاحظة بنجاح', 'success');
          var entry = currentDayEntries.find(function (e) { return e.rowIndex === rowIndex; });
          if (entry) entry.supervisorNote = note;
          var day = document.getElementById('daySelect').value;
          if (day) loadEntriesForDay(day);
        } else {
          showToast(result ? result.message : 'فشل الحفظ', 'error');
          if (result && result.message && result.message.includes('جلسة')) handleSessionExpiry();
        }
      })
      .withFailureHandler(function () {
        btn.disabled = false;
        btn.innerHTML = origHtml;
        showToast('خطأ في الاتصال بالخادم', 'error');
      })
      .saveSupervisorNote(sessionToken, rowIndex, note, selectedReviewMonth);
  }

  function saveInlineChiefRating(btn, rowIndex, rating) {
    btn.disabled = true;
    var origHtml = btn.innerHTML;
    btn.innerHTML = '<span class="spinner"></span>';

    google.script.run
      .withSuccessHandler(function (result) {
        btn.disabled = false;
        btn.innerHTML = origHtml;
        if (result && result.success) {
          showToast('تم حفظ التقييم بنجاح', 'success');
          var entry = currentDayEntries.find(function (e) { return e.rowIndex === rowIndex; });
          if (entry) entry.chiefRating = rating;
          var day = document.getElementById('daySelect').value;
          if (day) loadEntriesForDay(day);
        } else {
          showToast(result ? result.message : 'فشل الحفظ', 'error');
          if (result && result.message && result.message.includes('جلسة')) handleSessionExpiry();
        }
      })
      .withFailureHandler(function () {
        btn.disabled = false;
        btn.innerHTML = origHtml;
        showToast('خطأ في الاتصال بالخادم', 'error');
      })
      .saveChiefRating(sessionToken, rowIndex, rating, selectedReviewMonth);
  }

  function saveInlineWorkDone(btn, rowIndex, workDone) {
    if (!workDone) { showToast('الرجاء إدخال نص الأعمال المنفذة', 'warning'); return; }

    btn.disabled = true;
    var origHtml = btn.innerHTML;
    btn.innerHTML = '<span class="spinner"></span>';

    google.script.run
      .withSuccessHandler(function (result) {
        btn.disabled = false;
        btn.innerHTML = origHtml;
        if (result && result.success) {
          showToast('تم تحديث العمل المنفذ بنجاح', 'success');
          var entry = currentDayEntries.find(function (e) { return e.rowIndex === rowIndex; });
          if (entry) entry.workDone = workDone;
          var day = document.getElementById('daySelect').value;
          if (day) loadEntriesForDay(day);
        } else {
          showToast(result ? result.message : 'فشل تحديث العمل المنفذ', 'error');
          if (result && result.message && result.message.includes('جلسة')) handleSessionExpiry();
        }
      })
      .withFailureHandler(function () {
        btn.disabled = false;
        btn.innerHTML = origHtml;
        showToast('خطأ في الاتصال بالخادم', 'error');
      })
      .updateWorkDoneBySupervisor(sessionToken, rowIndex, workDone, selectedReviewMonth);
  }

  // ==========================================
  // مربع حوار التعديل (للمالك)
  // ==========================================
  function openEditModal(rowIndex) {
    var entry = currentDayEntries.find(function (e) { return e.rowIndex === rowIndex; });
    if (!entry) return;
    document.getElementById('editRowIndex').value = rowIndex;
    document.getElementById('editWorkDone').value = entry.workDone || '';
    document.getElementById('editShift').value    = entry.shift || 'موجود';
    openModal('editModal');
  }

  var lastModalFocus = null;

  function openModal(id) {
    var modal = document.getElementById(id);
    if (!modal) return;
    lastModalFocus = document.activeElement;
    modal.classList.add('open');
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    document.body.classList.add('modal-is-open');
    var focusTarget = modal.querySelector('input:not([type="hidden"]), textarea, select, button');
    if (focusTarget) {
      setTimeout(function () { focusTarget.focus(); }, 40);
    }
  }

  function closeModal(id) {
    var modal = document.getElementById(id);
    if (!modal) return;
    modal.classList.remove('open');
    if (!document.querySelector('.modal-overlay.open')) {
      document.body.classList.remove('modal-is-open');
    }
    if (lastModalFocus && typeof lastModalFocus.focus === 'function') {
      setTimeout(function () { lastModalFocus.focus(); }, 0);
    }
  }

  document.querySelectorAll('.modal-overlay').forEach(function (overlay) {
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) {
        /* لا نغلق مودال كلمة المرور بالنقر الخارجي لمنع الإغلاق العرضي */
        if (overlay.id !== 'setPasswordModal') {
          closeModal(overlay.id);
        }
      }
    });
  });

  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    var opened = document.querySelector('.modal-overlay.open');
    if (opened && opened.id !== 'setPasswordModal') closeModal(opened.id);
  });

  function saveEdit() {
    var rowIndex = parseInt(document.getElementById('editRowIndex').value);
    var workDone = document.getElementById('editWorkDone').value.trim();
    var shift    = document.getElementById('editShift').value;

    if (!workDone) { showToast('الرجاء إدخال الأعمال المنفذة', 'warning'); return; }

    document.getElementById('saveEditBtn').disabled = true;
    document.getElementById('saveEditText').style.display    = 'none';
    document.getElementById('saveEditSpinner').style.display = 'inline';

    google.script.run
      .withSuccessHandler(function (result) {
        document.getElementById('saveEditBtn').disabled = false;
        document.getElementById('saveEditText').style.display    = 'inline';
        document.getElementById('saveEditSpinner').style.display = 'none';
        if (result && result.success) {
          closeModal('editModal');
          showToast('تم التعديل بنجاح', 'success');
          var day = document.getElementById('daySelect').value;
          if (day) loadEntriesForDay(day);
        } else {
          showToast(result ? result.message : 'فشل التعديل', 'error');
        }
      })
      .withFailureHandler(function () {
        document.getElementById('saveEditBtn').disabled = false;
        document.getElementById('saveEditText').style.display    = 'inline';
        document.getElementById('saveEditSpinner').style.display = 'none';
        showToast('خطأ في الاتصال بالخادم', 'error');
      })
      .updateEntry(sessionToken, rowIndex, workDone, shift, selectedReviewMonth);
  }

  // ==========================================
  // مستمع النقر الموحّد لقائمة الإدخالات
  // ==========================================
  (function setupEntriesListener() {
    var container = document.getElementById('entriesContainer');
    container.addEventListener('click', function (e) {
      var btn = e.target.closest('button');
      if (!btn) return;

      var rowIndex = parseInt(btn.getAttribute('data-row'), 10);
      if (isNaN(rowIndex)) return;

      if (btn.classList.contains('entry-btn-edit')) {
        openEditModal(rowIndex);

      } else if (btn.classList.contains('entry-btn-save-sup1')) {
        var ta1  = container.querySelector('.sup1-textarea[data-row="' + rowIndex + '"]');
        var note = ta1 ? ta1.value.trim() : '';
        saveInlineSupervisorNote(btn, rowIndex, note);

      } else if (btn.classList.contains('entry-btn-save-sup2')) {
        var ta2    = container.querySelector('.sup2-textarea[data-row="' + rowIndex + '"]');
        var rating = ta2 ? ta2.value.trim() : '';
        saveInlineChiefRating(btn, rowIndex, rating);

      } else if (btn.classList.contains('entry-btn-edit-work')) {
        var display = container.querySelector('.entry-work-display[data-row="' + rowIndex + '"]');
        var editBox = container.querySelector('.entry-work-edit[data-row="' + rowIndex + '"]');
        if (display) display.style.display = 'none';
        if (editBox) editBox.style.display = 'block';
        var taAutoSize = editBox ? editBox.querySelector('.work-edit-textarea') : null;
        if (taAutoSize) { autoResizeTextarea(taAutoSize); taAutoSize.focus(); }

      } else if (btn.classList.contains('entry-btn-cancel-work')) {
        var displayC = container.querySelector('.entry-work-display[data-row="' + rowIndex + '"]');
        var editBoxC = container.querySelector('.entry-work-edit[data-row="' + rowIndex + '"]');
        if (editBoxC) editBoxC.style.display = 'none';
        if (displayC) displayC.style.display = 'block';

      } else if (btn.classList.contains('entry-btn-save-work')) {
        var taWork      = container.querySelector('.work-edit-textarea[data-row="' + rowIndex + '"]');
        var workDoneVal = taWork ? taWork.value.trim() : '';
        saveInlineWorkDone(btn, rowIndex, workDoneVal);
      }
    });
  })();

  // ==========================================
  // تكبير مربع النص تلقائياً
  // ==========================================
  function autoResizeTextarea(ta) {
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = Math.max(ta.scrollHeight, 220) + 'px';
  }
  document.addEventListener('input', function (e) {
    if (e.target && e.target.classList && e.target.classList.contains('work-edit-textarea')) {
      autoResizeTextarea(e.target);
    }
  });

  function autoResizeMainWorkDone(ta) {
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = ta.scrollHeight + 'px';
  }
  (function initMainWorkDoneAutoResize() {
    var mainWorkDone = document.getElementById('workDone');
    if (!mainWorkDone) return;
    autoResizeMainWorkDone(mainWorkDone);
    mainWorkDone.addEventListener('input', function () { autoResizeMainWorkDone(mainWorkDone); });
  })();

  // ==========================================
  // الثيم المظلم
  // ==========================================
  function toggleTheme() {
    var current = document.documentElement.getAttribute('data-theme') || 'light';
    var next    = current === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    localStorage.setItem('theme', next);
  }
  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    document.getElementById('themeIcon').textContent = theme === 'dark' ? 'light_mode' : 'dark_mode';
  }

  // ==========================================
  // إظهار/إخفاء كلمة المرور
  // ==========================================
  function togglePwVisibility(fieldId, iconId) {
    var field = document.getElementById(fieldId);
    var icon  = document.getElementById(iconId);
    if (!field) return;
    if (field.type === 'password') {
      field.type  = 'text';
      if (icon) icon.textContent = 'visibility_off';
    } else {
      field.type  = 'password';
      if (icon) icon.textContent = 'visibility';
    }
  }

  // ==========================================
  // Toast إشعارات
  // ==========================================
  function showToast(message, type) {
    type = type || 'info';
    var icons = {
      success: 'check_circle',
      error:   'error_outline',
      warning: 'warning_amber',
      info:    'info_outline'
    };
    var container = document.getElementById('toastContainer');
    var toast     = document.createElement('div');
    toast.className = 'toast toast-' + type;
    toast.innerHTML = '<span class="material-icons">' + (icons[type] || 'info') + '</span>'
                    + '<span>' + escHtml(message) + '</span>';
    container.appendChild(toast);
    setTimeout(function () {
      toast.classList.add('hiding');
      setTimeout(function () { toast.remove(); }, 300);
    }, 3500);
  }

  // ==========================================
  // معالجة انتهاء الجلسة
  // ==========================================
  function handleSessionExpiry() {
    clearSession();
    showLogin();
    showToast('انتهت جلستك، الرجاء تسجيل الدخول مجدداً', 'warning');
  }

  // ==========================================
  // أدوات مساعدة
  // ==========================================
  function escHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // ==========================================
  // الملاحظات الشخصية الخاصة (Personal Notes)
  // ميزة مستقلة تماماً — لا تتقاطع مع أي وظيفة أخرى في النظام.
  // كل الاتصال بالخادم عبر google.script.run بدون أي إعادة تحميل للصفحة.
  // ==========================================
  var myNotes            = [];     // نسخة محلية من ملاحظات المستخدم الحالي فقط
  var notesLoadedOnce    = false;  // لتفادي إعادة الجلب في كل فتح للنافذة
  var activeEditingNoteId = null;  // null = ملاحظة جديدة، غير ذلك = تعديل ملاحظة موجودة

  function openPersonalNotes() {
    if (!sessionToken) return;
    document.getElementById('personalNotesModal').classList.add('open');
    backToNotesList();
    if (!notesLoadedOnce) {
      loadMyNotes();
    }
  }

  function closePersonalNotes() {
    document.getElementById('personalNotesModal').classList.remove('open');
  }

  function loadMyNotes() {
    var loading = document.getElementById('notesLoadingState');
    var empty   = document.getElementById('notesEmptyState');
    var grid    = document.getElementById('notesGrid');
    loading.style.display = 'flex';
    empty.style.display   = 'none';
    grid.innerHTML = '';

    google.script.run
      .withSuccessHandler(function (res) {
        loading.style.display = 'none';
        if (res && res.success) {
          myNotes         = res.notes || [];
          notesLoadedOnce = true;
          renderNotesList();
        } else if (res && res.message === 'انتهت صلاحية الجلسة') {
          closePersonalNotes();
          handleSessionExpiry();
        } else {
          showToast((res && res.message) || 'تعذر جلب الملاحظات', 'error');
        }
      })
      .withFailureHandler(function () {
        loading.style.display = 'none';
        showToast('فشل الاتصال بالخادم', 'error');
      })
      .getMyNotes(sessionToken);
  }

  function renderNotesList() {
    var grid   = document.getElementById('notesGrid');
    var empty  = document.getElementById('notesEmptyState');
    var query  = (document.getElementById('notesSearchInput').value || '').trim().toLowerCase();
    var sortBy = document.getElementById('notesSortSelect').value;

    var list = myNotes.filter(function (n) {
      if (!query) return true;
      return (n.title || '').toLowerCase().indexOf(query) !== -1 ||
             (n.content || '').toLowerCase().indexOf(query) !== -1;
    });

    list.sort(function (a, b) {
      if (sortBy === 'title_asc')    return (a.title || '').localeCompare(b.title || '', 'ar');
      if (sortBy === 'created_desc') return String(b.createdAt).localeCompare(String(a.createdAt));
      return String(b.updatedAt).localeCompare(String(a.updatedAt)); // updated_desc (افتراضي)
    });

    if (!notesLoadedOnce) return; // ما زال التحميل جارياً

    if (list.length === 0) {
      grid.innerHTML = '';
      empty.style.display = 'flex';
      empty.querySelector('p').textContent = myNotes.length === 0
        ? 'لا توجد ملاحظات بعد — ابدأ بإضافة أول ملاحظة لك'
        : 'لا توجد نتائج مطابقة لبحثك';
      return;
    }
    empty.style.display = 'none';

    var html = '';
    for (var i = 0; i < list.length; i++) {
      var n = list[i];
      html += '<div class="note-card" onclick="openNoteEditor(\'' + n.noteId + '\')">' +
              '<div class="note-card-title">' + (escHtml(n.title) || 'بدون عنوان') + '</div>' +
              '<div class="note-card-preview">' + escHtml(n.content) + '</div>' +
              '<div class="note-card-date"><span class="material-icons">schedule</span>' + escHtml(n.updatedAt) + '</div>' +
              '</div>';
    }
    grid.innerHTML = html;
  }

  /* ضبط ارتفاع مربع محتوى الملاحظة تلقائياً بحسب طول النص، بنفس أسلوب
     autoResizeTextarea المستخدم أصلاً في حقل "الأعمال المنفذة" — لا يُقصّ
     أي جزء من النص، ولا تبقى مساحة فارغة كبيرة للملاحظات القصيرة، والتمرير
     الفعلي يحدث على مستوى صفحة الملاحظات بالكامل عند الحاجة فقط. */
  function autoResizeNoteContent(ta) {
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = Math.max(ta.scrollHeight, 160) + 'px';
  }
  (function initNoteContentAutoResize() {
    var ta = document.getElementById('noteEditorContent');
    if (!ta) return;
    ta.addEventListener('input', function () { autoResizeNoteContent(ta); });
  })();

  function openNoteEditor(noteId) {
    activeEditingNoteId = noteId;
    document.getElementById('notesListView').style.display = 'none';
    document.getElementById('noteEditorView').style.display = 'block';

    var titleField   = document.getElementById('noteEditorTitle');
    var contentField = document.getElementById('noteEditorContent');
    var metaBox      = document.getElementById('noteEditorMeta');
    var deleteBtn    = document.getElementById('noteDeleteBtn');

    if (noteId) {
      var note = null;
      for (var i = 0; i < myNotes.length; i++) {
        if (myNotes[i].noteId === noteId) { note = myNotes[i]; break; }
      }
      if (!note) { backToNotesList(); return; }
      titleField.value   = note.title;
      contentField.value = note.content;
      metaBox.innerHTML  = '<span>أُنشئت: ' + escHtml(note.createdAt) + '</span>' +
                           '<span>آخر تعديل: ' + escHtml(note.updatedAt) + '</span>';
      deleteBtn.style.display = 'inline-flex';
    } else {
      titleField.value   = '';
      contentField.value = '';
      metaBox.innerHTML  = '';
      deleteBtn.style.display = 'none';
    }
    // ضبط الارتفاع فوراً حسب المحتوى المحمّل (قصير كان أو طويل جداً)
    setTimeout(function () {
      autoResizeNoteContent(contentField);
      titleField.focus();
    }, 50);
  }

  function backToNotesList() {
    activeEditingNoteId = null;
    document.getElementById('noteEditorView').style.display = 'none';
    document.getElementById('notesListView').style.display = 'block';
    renderNotesList();
  }

  function setNoteSaveLoading(isLoading) {
    document.getElementById('noteSaveBtn').disabled = isLoading;
    document.getElementById('noteSaveBtnText').style.display = isLoading ? 'none' : 'inline';
    document.getElementById('noteSaveSpinner').style.display = isLoading ? 'inline-flex' : 'none';
  }

  function saveNoteFromEditor() {
    var title   = document.getElementById('noteEditorTitle').value.trim();
    var content = document.getElementById('noteEditorContent').value.trim();
    if (!title && !content) {
      showToast('الرجاء كتابة عنوان أو محتوى للملاحظة', 'warning');
      return;
    }

    setNoteSaveLoading(true);

    function onDone(res) {
      setNoteSaveLoading(false);
      if (res && res.success) {
        showToast('تم حفظ الملاحظة بنجاح', 'success');
        loadMyNotesAfterChange();
      } else if (res && res.message === 'انتهت صلاحية الجلسة') {
        closePersonalNotes();
        handleSessionExpiry();
      } else {
        showToast((res && res.message) || 'تعذر حفظ الملاحظة', 'error');
      }
    }
    function onFail() {
      setNoteSaveLoading(false);
      showToast('فشل الاتصال بالخادم', 'error');
    }

    if (activeEditingNoteId) {
      google.script.run.withSuccessHandler(onDone).withFailureHandler(onFail)
        .updateNote(sessionToken, activeEditingNoteId, title, content);
    } else {
      google.script.run.withSuccessHandler(onDone).withFailureHandler(onFail)
        .createNote(sessionToken, title, content);
    }
  }

  function deleteNoteFromEditor() {
    if (!activeEditingNoteId) return;
    var noteId = activeEditingNoteId;
    showConfirmDialog({
      type:        'delete',
      icon:        'delete_outline',
      title:       'حذف الملاحظة',
      message:     'هل أنت متأكد من حذف هذه الملاحظة؟ لا يمكن التراجع عن هذا الإجراء.',
      confirmText: 'حذف',
      cancelText:  'إلغاء',
      onConfirm: function () {
        google.script.run
          .withSuccessHandler(function (res) {
            if (res && res.success) {
              showToast('تم حذف الملاحظة', 'success');
              loadMyNotesAfterChange();
            } else if (res && res.message === 'انتهت صلاحية الجلسة') {
              closePersonalNotes();
              handleSessionExpiry();
            } else {
              showToast((res && res.message) || 'تعذر حذف الملاحظة', 'error');
            }
          })
          .withFailureHandler(function () {
            showToast('فشل الاتصال بالخادم', 'error');
          })
          .deleteNote(sessionToken, noteId);
      }
    });
  }

  /* بعد أي إضافة/تعديل/حذف نعيد جلب القائمة كاملة من الخادم لضمان تطابقها
     تماماً مع ما هو مخزَّن فعلياً (مصدر الحقيقة الوحيد هو الخادم). */
  function loadMyNotesAfterChange() {
    backToNotesList();
    google.script.run
      .withSuccessHandler(function (res) {
        if (res && res.success) {
          myNotes = res.notes || [];
          renderNotesList();
        }
      })
      .withFailureHandler(function () {})
      .getMyNotes(sessionToken);
  }

  // ==========================================
  // لوحة تحكم المشرف — Supervisor Panel (جديدة)
  // ==========================================

  function openSupervisorPanel() {
    if (!currentUser) return;
    var supRole = currentUser.role;
    var canOpenSupPanel = currentUser.isSuperAdmin ||
      supRole === 'supervisor_unit_head' || supRole === 'supervisor_division_head' || supRole === 'editor';
    if (!canOpenSupPanel) {
      showToast('ليس لديك صلاحية الوصول', 'error');
      return;
    }
    document.getElementById('supOverlay').classList.add('open');
    document.getElementById('supPanel').classList.add('open');
    document.body.style.overflow = 'hidden';
    resetSupPanel();
    switchSupTab('supTabToday', document.getElementById('supTab1'));
    loadAdminDashboard();
  }

  function closeSupervisorPanel() {
    document.getElementById('supOverlay').classList.remove('open');
    document.getElementById('supPanel').classList.remove('open');
    document.body.style.overflow = '';
  }

  function resetSupPanel() {
    document.getElementById('supLoadingState').style.display = 'flex';
    document.getElementById('supErrorState').style.display   = 'none';
    document.getElementById('supContent').style.display      = 'none';
    document.getElementById('supAdminName').textContent      = '—';
    document.getElementById('supAdminRole').textContent      = '—';
    document.getElementById('supLastRefresh').textContent    = '—';
  }

  function refreshSupervisorPanel() {
    if (!document.getElementById('supPanel').classList.contains('open')) return;
    resetSupPanel();
    loadAdminDashboard();
  }

  function loadAdminDashboard() {
    google.script.run
      .withSuccessHandler(function (res) {
        document.getElementById('supLoadingState').style.display = 'none';
        if (!res || !res.success) {
          document.getElementById('supErrorState').style.display = 'flex';
          document.getElementById('supErrorMsg').textContent =
            res ? res.message : 'خطأ في الاتصال بالخادم';
          return;
        }
        supDashboardData = res;
        document.getElementById('supAdminName').textContent = res.adminName || '—';
        document.getElementById('supAdminRole').textContent = res.adminRole || '—';

        animateCount('supStatMonthTotal', res.totalMonthEntries || 0, 800);
        animateCount('supStatTodayCount', res.todayCount        || 0, 600);
        animateCount('supStatActiveUsers', res.activeUsers      || 0, 700);

        document.getElementById('supTodayBadge').textContent = res.todayCount || 0;
        renderTodayList(res.todaySubmitters || [], res.todayDate || '');

        document.getElementById('supMonthBadge').textContent = (res.monthlyStats || []).length;
        renderMonthlyTable(res.monthlyStats || [], res.currentMonth || '');

        var now = new Date();
        var mm  = now.getMinutes() < 10 ? '0' + now.getMinutes() : String(now.getMinutes());
        document.getElementById('supLastRefresh').textContent = 'آخر تحديث: ' + now.getHours() + ':' + mm;
        document.getElementById('supContent').style.display = 'block';
      })
      .withFailureHandler(function () {
        document.getElementById('supLoadingState').style.display = 'none';
        document.getElementById('supErrorState').style.display   = 'flex';
        document.getElementById('supErrorMsg').textContent       = 'خطأ في الاتصال بالخادم';
      })
      .getAdminDashboardData(sessionToken);
  }

  function renderTodayList(submitters, todayDate) {
    var container = document.getElementById('supTodayList');
    if (!submitters || submitters.length === 0) {
      container.innerHTML =
        '<div class="empty-state" style="padding:32px 16px;">' +
        '<span class="material-icons">inbox</span>' +
        '<p>لا توجد إدخالات لهذا اليوم حتى الآن<br>' +
        '<span style="font-size:0.8rem;opacity:0.6;">' + escHtml(todayDate) + '</span></p></div>';
      return;
    }
    var shiftClass = function(s) {
      if (!s) return 'sup-shift-present';
      if (s.indexOf('غير') !== -1) return 'sup-shift-absent';
      if (s.indexOf('مهم') !== -1) return 'sup-shift-mission';
      return 'sup-shift-present';
    };
    var html = '';
    submitters.forEach(function (s, idx) {
      html += '<div class="sup-user-row">' +
        '<div class="sup-user-num">' + (idx + 1) + '</div>' +
        '<div class="sup-user-info">' +
        '<div class="sup-user-name">' + escHtml(s.name) + '</div>' +
        '<div class="sup-user-meta">ر.ذ: ' + escHtml(s.userId) + '</div>' +
        '</div>' +
        '<div class="sup-user-right">' +
        '<span class="sup-shift-badge ' + shiftClass(s.shift) + '">' + escHtml(s.shift || 'موجود') + '</span>' +
        '<span class="sup-time-text">' + escHtml(s.time || '') + '</span>' +
        '</div></div>';
    });
    container.innerHTML = html;
  }

  function renderMonthlyTable(stats, monthName) {
    var container = document.getElementById('supMonthlyTable');
    if (!stats || stats.length === 0) {
      container.innerHTML =
        '<div class="empty-state" style="padding:32px 16px;">' +
        '<span class="material-icons">bar_chart</span>' +
        '<p>لا توجد بيانات لهذا الشهر</p></div>';
      return;
    }
    var rankBadge = function(r) {
      if (r === 1) return '<span class="sup-rank-badge rank-1">1</span>';
      if (r === 2) return '<span class="sup-rank-badge rank-2">2</span>';
      if (r === 3) return '<span class="sup-rank-badge rank-3">3</span>';
      return '<span class="sup-rank-badge rank-other">' + r + '</span>';
    };
    var html = '<table class="sup-monthly-table"><thead><tr>' +
      '<th style="width:40px;">#</th><th>الموظف</th>' +
      '<th style="text-align:center;">الإدخالات</th>' +
      '<th style="text-align:center;">اليوم</th>' +
      '</tr></thead><tbody>';
    stats.forEach(function (s, idx) {
      html += '<tr>' +
        '<td style="text-align:center;">' + rankBadge(idx + 1) + '</td>' +
        '<td><div style="font-weight:700;font-size:0.85rem;">' + escHtml(s.name) + '</div>' +
        '<div style="font-size:0.72rem;color:var(--text-muted);">' + escHtml(s.userId) + '</div></td>' +
        '<td style="text-align:center;font-weight:800;font-size:1rem;color:#7B1FA2;">' + s.count + '</td>' +
        '<td style="text-align:center;">' +
        (s.submittedToday
          ? '<span class="today-dot">أرسل</span>'
          : '<span style="font-size:0.72rem;color:var(--text-muted);">—</span>') +
        '</td></tr>';
    });
    html += '</tbody></table>';
    container.innerHTML = html;
  }

  function switchSupTab(tabId, clickedTab) {
    document.querySelectorAll('.sup-tab-content').forEach(function (t) { t.classList.remove('active'); });
    document.querySelectorAll('.sup-tab').forEach(function (t) { t.classList.remove('active'); });
    document.getElementById(tabId).classList.add('active');
    clickedTab.classList.add('active');
  }

  // ==========================================
  // مركز التصدير والتقارير — Export & Reports Center
  // إضافة مستقلة تماماً داخل لوحة تحكم المشرف: لا تُعدّل أ)� دالة موجودة
  // (تعتمد فقط على google.script.run نحو الدوال الجديدة في الخادم)، ولا
  // تُستدعى من أي مكان آخر في الواجهة.
  // ==========================================
  var expEmployeesLoaded = false;   // لتفادي إعادة جلب قائمة الموظفين في كل فتح للتبويب
  var expCurrentPeriod   = 'today';
  var expLastReportData  = null;    // آخر بيانات تقرير تم توليدها (headers/rows)
  var expLastReportStats = null;    // آخر إحصاءات تم حسابها

  function initExportCenter() {
    if (expEmployeesLoaded) return;
    expEmployeesLoaded = true;
    google.script.run
      .withSuccessHandler(function (res) {
        if (!res || !res.success) return;
        renderExportFilterOptions(res.workers || []);
      })
      .withFailureHandler(function () {})
      .getWorkersList(sessionToken);
  }

  function renderExportFilterOptions(workers) {
    var empSel = document.getElementById('expFilterEmployee');
    var offSel = document.getElementById('expFilterOffice');
    var offices = {};
    workers.forEach(function (w) {
      var opt = document.createElement('option');
      opt.value = w.userId;
      opt.textContent = w.name;
      empSel.appendChild(opt);
      if (w.office) offices[w.office] = true;
    });
    Object.keys(offices).sort(function (a, b) { return a.localeCompare(b, 'ar'); }).forEach(function (o) {
      var opt = document.createElement('option');
      opt.value = o; opt.textContent = o;
      offSel.appendChild(opt);
    });
  }

  function setExportPeriod(period, btn) {
    expCurrentPeriod = period;
    document.querySelectorAll('.exp-period-btn').forEach(function (b) { b.classList.remove('active'); });
    btn.classList.add('active');
    var isCustom = period === 'custom';
    document.getElementById('expCustomFromGroup').style.display = isCustom ? 'block' : 'none';
    document.getElementById('expCustomToGroup').style.display   = isCustom ? 'block' : 'none';
  }

  /**
   * حساب تاريخي البداية والنهاية (YYYY-MM-DD) حسب الفترة المختارة.
   */
  function computeExportDateRange_() {
    var now = new Date();
    var toStr = function (d) {
      var m = d.getMonth() + 1, day = d.getDate();
      return d.getFullYear() + '-' + (m < 10 ? '0' + m : m) + '-' + (day < 10 ? '0' + day : day);
    };
    if (expCurrentPeriod === 'today') {
      return { startDate: toStr(now), endDate: toStr(now) };
    }
    if (expCurrentPeriod === 'week') {
      var start = new Date(now); start.setDate(now.getDate() - 6);
      return { startDate: toStr(start), endDate: toStr(now) };
    }
    if (expCurrentPeriod === 'month') {
      var start2 = new Date(now.getFullYear(), now.getMonth(), 1);
      return { startDate: toStr(start2), endDate: toStr(now) };
    }
    // فترة مخصصة
    var from = document.getElementById('expDateFrom').value;
    var to   = document.getElementById('expDateTo').value;
    return { startDate: from || toStr(now), endDate: to || toStr(now) };
  }

  function generateExportReport() {
    if (expCurrentPeriod === 'custom') {
      var f = document.getElementById('expDateFrom').value;
      var t = document.getElementById('expDateTo').value;
      if (!f || !t) { showToast('الرجاء تحديد تاريخي البداية والنهاية', 'warning'); return; }
      if (f > t) { showToast('تاريخ البداية يجب أن يسبق تاريخ النهاية', 'warning'); return; }
    }

    var range = computeExportDateRange_();
    var filters = {
      startDate: range.startDate,
      endDate: range.endDate,
      employeeId: document.getElementById('expFilterEmployee').value,
      office: document.getElementById('expFilterOffice').value,
      dataType: document.getElementById('expFilterDataType').value
    };

    var btn = document.getElementById('expGenerateBtn');
    btn.disabled = true;
    document.getElementById('expGenerateBtnText').textContent = 'جارٍ التجهيز...';
    document.getElementById('expGenerateSpinner').style.display = 'inline-block';

    var pending = 2, hadError = false;
    function done() {
      pending--;
      if (pending > 0) return;
      btn.disabled = false;
      document.getElementById('expGenerateBtnText').textContent = 'إنشاء التقرير';
      document.getElementById('expGenerateSpinner').style.display = 'none';
      if (!hadError) {
        document.getElementById('expResultsWrap').style.display = 'block';
        document.getElementById('expEmptyHint').style.display   = 'none';
      }
    }

    google.script.run
      .withSuccessHandler(function (res) {
        if (!res || !res.success) {
          hadError = true;
          showToast(res ? res.message : 'فشل تجهيز بيانات التقرير', 'error');
          done(); return;
        }
        expLastReportData = res;
        document.getElementById('expRangeLabel').textContent = 'الفترة: ' + (res.rangeLabel || '');
        done();
      })
      .withFailureHandler(function () {
        hadError = true;
        showToast('فشل الاتصال بالخادم', 'error');
        done();
      })
      .getExportReportData(sessionToken, filters);

    google.script.run
      .withSuccessHandler(function (res) {
        if (!res || !res.success) {
          hadError = true;
          showToast(res ? res.message : 'فشل حساب الإحصاءات', 'error');
          done(); return;
        }
        expLastReportStats = res;
        renderExportStats(res);
        done();
      })
      .withFailureHandler(function () {
        hadError = true;
        showToast('فشل الاتصال بالخادم', 'error');
        done();
      })
      .getExportReportStats(sessionToken, filters);
  }

  function renderExportStats(stats) {
    animateCount('expStatEmployees', stats.totalEmployees || 0, 500);
    animateCount('expStatEntries', stats.totalEntries || 0, 500);
    document.getElementById('expStatMostActive').textContent =
      stats.mostActiveDay ? (stats.mostActiveDay.date + ' (' + stats.mostActiveDay.count + ')') : '—';
    document.getElementById('expStatLeastActive').textContent =
      stats.leastActiveDay ? (stats.leastActiveDay.date + ' (' + stats.leastActiveDay.count + ')') : '—';

    var container = document.getElementById('expEmployeeStats');
    var list = stats.perEmployee || [];
    if (list.length === 0) {
      container.innerHTML = '<div class="exp-empty-hint" style="padding:16px;">لا توجد إدخالات مطابقة للفلاتر المختارة</div>';
      return;
    }
    var maxCount = Math.max.apply(null, list.map(function (e) { return e.count; }));
    var html = '';
    list.forEach(function (e) {
      var pct = maxCount > 0 ? Math.round((e.count / maxCount) * 100) : 0;
      html += '<div class="exp-emp-row">' +
        '<div class="exp-emp-name">' + escHtml(e.name) + '</div>' +
        '<div class="exp-emp-bar-track"><div class="exp-emp-bar-fill" style="width:' + pct + '%;"></div></div>' +
        '<div class="exp-emp-meta">' + e.count + ' إدخال · معدل ' + e.avgPerDay + '/يوم · التزام ' + e.complianceRate + '%</div>' +
        '</div>';
    });
    container.innerHTML = html;
  }

  /**
   * بناء عنصر HTML كامل لمعاينة التقرير (يُستخدم في PDF/HTML/الطباعة).
   * يُعاد داخل حاوية مخفية عن الشاشة لا تؤثر على أي جزء ظاهر من الواجهة.
   */
  function buildExportReportContainer_() {
    var data = expLastReportData;
    if (!data || !data.rows) return null;
    var now = new Date();
    var generatedAt = now.toLocaleDateString('ar-EG') + ' — ' + todayStr();

    var thead = '<tr>' + data.headers.map(function (h) { return '<th>' + escHtml(h) + '</th>'; }).join('') + '</tr>';
    var tbody = data.rows.map(function (r) {
      var cells = [r.date, r.dept, r.office, r.workshop, r.name, r.workDone, r.shift];
      if (data.canSeeSup1) cells.push(r.supervisorNote || '');
      if (data.canSeeSup2) cells.push(r.chiefRating || '');
      return '<tr>' + cells.map(function (c) { return '<td>' + escHtml(c) + '</td>'; }).join('') + '</tr>';
    }).join('');

    var html =
      '<div style="font-family:Cairo,Arial,sans-serif; direction:rtl; text-align:right; color:#1A1A1A; background:#fff; padding:24px;">' +
      '<h1 style="font-size:20px; margin:0 0 4px 0;">تقرير الأعمال اليومية — نظام إدارة الأعمال اليومية</h1>' +
      '<div style="font-size:12px; color:#555; margin-bottom:2px;">القسم: ' + escHtml(FIXED_DEPT_LABEL) + '</div>' +
      '<div style="font-size:12px; color:#555; margin-bottom:2px;">الفترة: ' + escHtml(data.rangeLabel || '') + '</div>' +
      '<div style="font-size:12px; color:#555; margin-bottom:2px;">أُعِدّ بواسطة: ' + escHtml((currentUser && currentUser.name) || '') + '</div>' +
      '<div style="font-size:12px; color:#555; margin-bottom:14px;">تاريخ الإصدار: ' + escHtml(generatedAt) + '</div>' +
      '<table style="width:100%; border-collapse:collapse; font-size:11px;">' +
      '<thead style="background:#4A148C; color:#fff;">' + thead + '</thead>' +
      '<tbody>' + tbody + '</tbody></table>' +
      '<div style="font-size:11px; color:#777; margin-top:16px;">إجمالي السجلات: ' + data.rows.length + '</div>' +
      '</div>';

    var container = document.getElementById('exportReportPreview');
    container.innerHTML = html;
    var styleTags =
      '<style>table{width:100%;border-collapse:collapse;}' +
      'th,td{border:1px solid #ccc;padding:5px 7px;text-align:right;}' +
      'thead th{background:#4A148C;color:#fff;}' +
      'tbody tr:nth-child(even){background:#f5f2fa;}</style>';
    container.querySelector('table').setAttribute('style', container.querySelector('table').getAttribute('style'));
    return { el: container, styleTags: styleTags, html: html };
  }

  var FIXED_DEPT_LABEL = 'المالية والحسابات';

  function ensureReportReady_() {
    if (!expLastReportData || !expLastReportData.rows) {
      showToast('الرجاء إنشاء التقرير أولاً', 'warning');
      return false;
    }
    return true;
  }

  function exportReportAsHtml() {
    if (!ensureReportReady_()) return;
    var built = buildExportReportContainer_();
    var doc = '<!DOCTYPE html><html lang="ar" dir="rtl"><head><meta charset="UTF-8">' +
      '<title>تقرير الأعمال اليومية</title>' + built.styleTags + '</head><body>' + built.html + '</body></html>';
    var blob = new Blob([doc], { type: 'text/html;charset=utf-8' });
    downloadBlob_(blob, 'تقرير_الأعمال_' + todayStr() + '.html');
    showToast('تم تصدير HTML بنجاح', 'success');
  }

  function exportReportAsCsv() {
    if (!ensureReportReady_()) return;
    var data = expLastReportData;
    var lines = [data.headers.join(',')];
    data.rows.forEach(function (r) {
      var cells = [r.date, r.dept, r.office, r.workshop, r.name, r.workDone, r.shift];
      if (data.canSeeSup1) cells.push(r.supervisorNote || '');
      if (data.canSeeSup2) cells.push(r.chiefRating || '');
      lines.push(cells.map(csvEscape_).join(','));
    });
    // BOM لضمان ظهور الأحرف العربية بشكل صحيح عند الفتح في Excel
    var blob = new Blob(['\uFEFF' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    downloadBlob_(blob, 'تقرير_الأعمال_' + todayStr() + '.csv');
    showToast('تم تصدير CSV بنجاح', 'success');
  }

  function csvEscape_(val) {
    var s = String(val == null ? '' : val);
    if (/[",\n]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  function exportReportAsExcel() {
    if (!ensureReportReady_()) return;
    var data = expLastReportData;
    var aoa = [data.headers];
    data.rows.forEach(function (r) {
      var cells = [r.date, r.dept, r.office, r.workshop, r.name, r.workDone, r.shift];
      if (data.canSeeSup1) cells.push(r.supervisorNote || '');
      if (data.canSeeSup2) cells.push(r.chiefRating || '');
      aoa.push(cells);
    });
    try {
      var ws = XLSX.utils.aoa_to_sheet(aoa);
      ws['!cols'] = data.headers.map(function () { return { wch: 20 }; });
      var wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'تقرير الأعمال');
      XLSX.writeFile(wb, 'تقرير_الأعمال_' + todayStr() + '.xlsx');
      showToast('تم تصدير Excel بنجاح (' + data.rows.length + ' سجل)', 'success');
    } catch (e) {
      showToast('خطأ في إنشاء ملف Excel: ' + e.message, 'error');
    }
  }

  function exportReportAsPdf() {
    if (!ensureReportReady_()) return;
    var btn = document.getElementById('expBtnPdf');
    btn.disabled = true;
    showToast('جارٍ تجهيز ملف PDF...', 'info');
    var built = buildExportReportContainer_();
    html2canvas(built.el, { scale: 2, useCORS: true }).then(function (canvas) {
      var pdf = new jspdf.jsPDF('p', 'mm', 'a4');
      var pageWidth  = pdf.internal.pageSize.getWidth();
      var pageHeight = pdf.internal.pageSize.getHeight();
      var imgWidth   = pageWidth;
      var imgHeight  = (canvas.height * imgWidth) / canvas.width;
      var heightLeft = imgHeight;
      var position   = 0;
      var imgData = canvas.toDataURL('image/jpeg', 0.95);

      pdf.addImage(imgData, 'JPEG', 0, position, imgWidth, imgHeight);
      heightLeft -= pageHeight;
      while (heightLeft > 0) {
        position = heightLeft - imgHeight;
        pdf.addPage();
        pdf.addImage(imgData, 'JPEG', 0, position, imgWidth, imgHeight);
        heightLeft -= pageHeight;
      }
      pdf.save('تقرير_الأعمال_' + todayStr() + '.pdf');
      btn.disabled = false;
      showToast('تم تصدير PDF بنجاح', 'success');
    }).catch(function (e) {
      btn.disabled = false;
      showToast('خطأ في إنشاء ملف PDF: ' + e.message, 'error');
    });
  }

  function printExportReport() {
    if (!ensureReportReady_()) return;
    var built = buildExportReportContainer_();
    var iframe = document.createElement('iframe');
    iframe.style.position = 'fixed';
    iframe.style.right = '-99999px';
    iframe.style.width = '0'; iframe.style.height = '0'; iframe.style.border = '0';
    document.body.appendChild(iframe);
    var doc = iframe.contentDocument || iframe.contentWindow.document;
    doc.open();
    doc.write('<!DOCTYPE html><html lang="ar" dir="rtl"><head><meta charset="UTF-8">' +
      '<title>طباعة التقرير</title>' + built.styleTags +
      '<style>@page{size:A4;margin:14mm;} body{margin:0;}</style></head><body>' + built.html + '</body></html>');
    doc.close();
    setTimeout(function () {
      iframe.contentWindow.focus();
      iframe.contentWindow.print();
      setTimeout(function () { document.body.removeChild(iframe); }, 1000);
    }, 350);
  }

  function downloadBlob_(blob, fileName) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = fileName;
    document.body.appendChild(a); a.click();
    setTimeout(function () { document.body.removeChild(a); URL.revokeObjectURL(url); }, 500);
  }


  // ==========================================
  // نظام النوافذ المنبثقة المطوّر
  // Material Design Dialogs
  // ==========================================

  /**
   * _mdEsc — ترميز HTML لمنع XSS داخل النوافذ
   */
  function _mdEsc(str) {
    return String(str || '')
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  /**
   * showMdDialog — النافذة الديناميكية الأساسية
   * config: {
   *   type:        'success'|'error'|'warning'|'info'|'delete',
   *   icon:        'material-icon-name',
   *   title:       string,
   *   message:     string,
   *   confirmText: string,
   *   cancelText:  string | undefined (undefined = بدون زر إلغاء),
   *   onConfirm:   function,
   *   onCancel:    function (اختياري)
   * }
   */
  function showMdDialog(config) {
    /* إزالة أي نافذة مفتوحة */
    var prev = document.getElementById('_mdBackdrop');
    if (prev) prev.remove();

    var type        = config.type        || 'info';
    var icon        = config.icon        || 'info_outline';
    var title       = config.title       || '';
    var message     = config.message     || '';
    var confirmText = config.confirmText || 'موافق';
    var cancelText  = config.cancelText;
    var hasCancel   = typeof cancelText === 'string';

    var actionsHtml = hasCancel
      ? '<div class="md-dialog-actions">' +
          '<button class="md-btn md-btn-' + type + '" id="_mdOk">' +
            '<span class="material-icons">' + _mdEsc(icon) + '</span>' + _mdEsc(confirmText) +
          '</button>' +
          '<button class="md-btn md-btn-cancel" id="_mdCancel">' + _mdEsc(cancelText) + '</button>' +
        '</div>'
      : '<div class="md-dialog-actions md-single">' +
          '<button class="md-btn md-btn-' + type + '" id="_mdOk">' +
            '<span class="material-icons">' + _mdEsc(icon) + '</span>' + _mdEsc(confirmText) +
          '</button>' +
        '</div>';

    var backdrop = document.createElement('div');
    backdrop.className = 'md-dialog-backdrop';
    backdrop.id = '_mdBackdrop';
    backdrop.setAttribute('role', 'dialog');
    backdrop.setAttribute('aria-modal', 'true');
    backdrop.innerHTML =
      '<div class="md-dialog">' +
        '<div class="md-dialog-icon-ring md-icon-' + type + '">' +
          '<span class="material-icons">' + _mdEsc(icon) + '</span>' +
        '</div>' +
        '<div class="md-dialog-title">' + _mdEsc(title) + '</div>' +
        '<div class="md-dialog-msg">'   + _mdEsc(message) + '</div>' +
        actionsHtml +
      '</div>';

    document.body.appendChild(backdrop);

    /* علامة تمنع أي إغلاق أو استجابة مزدوجة */
    var _closed = false;

    function _onKey(e) {
      if (e.key === 'Enter')                 { _doClose(config.onConfirm);       }
      if (e.key === 'Escape' && hasCancel)   { _doClose(config.onCancel || null); }
    }

    function _doClose(cb) {
      if (_closed) return;           /* منع الاستدعاء المزدوج */
      _closed = true;
      document.removeEventListener('keydown', _onKey); /* تنظيف دائم بغض النظر عن طريقة الإغلاق */
      backdrop.classList.add('md-closing');
      setTimeout(function () { backdrop.remove(); if (cb) cb(); }, 220);
    }

    document.getElementById('_mdOk').addEventListener('click', function () {
      _doClose(config.onConfirm);
    });

    if (hasCancel) {
      document.getElementById('_mdCancel').addEventListener('click', function () {
        _doClose(config.onCancel || null);
      });
      /* إغلاق بالنقر على الخلفية */
      backdrop.addEventListener('click', function (e) {
        if (e.target === backdrop) _doClose(config.onCancel || null);
      });
    }

    /* تسجيل اختصارات لوحة المفاتيح بعد تأخير قصير لتجنب التداخل مع الضغطة الحالية */
    setTimeout(function () { document.addEventListener('keydown', _onKey); }, 50);
  }

  // ==========================================
  // لوحة مراقبة النظام — Super Admin Panel
  // ==========================================
  function openSuperAdminPanel() {
    if (!currentUser || !currentUser.isSuperAdmin) return;
    document.getElementById('saOverlay').classList.add('open');
    document.getElementById('saPanel').classList.add('open');
    document.body.style.overflow = 'hidden';
    /* إعادة ضبط */
    document.getElementById('saLoadingState').style.display = 'block';
    document.getElementById('saErrorState').style.display   = 'none';
    document.getElementById('saContent').style.display      = 'none';
    document.getElementById('saLastRefresh').textContent    = '—';
    document.getElementById('saStatTotalLogs').textContent  = '—';
    document.getElementById('saStatTodayLogs').textContent  = '—';
    document.getElementById('saStatUsers').textContent      = '—';
    document.getElementById('saStatSheets').textContent     = '—';
    switchSaTab('logs');
    loadSuperAdminLogs();
  }

  // ==========================================
  // التبديل بين تبويبي: سجل العمليات / إدارة المستخدمين
  // ==========================================
  var _saUmDataCache = null; // ذاكرة مؤقتة على جهة العميل لبيانات آخر تحميل

  function switchSaTab(tab) {
    var logsBtn  = document.getElementById('saTabLogsBtn');
    var usersBtn = document.getElementById('saTabUsersBtn');
    var logsView = document.getElementById('saContent');
    var usersView = document.getElementById('saUsersContent');
    var refreshBtn = document.getElementById('saRefreshBtn');

    if (tab === 'users') {
      logsBtn.classList.remove('active'); usersBtn.classList.add('active');
      document.getElementById('saLoadingState').style.display = 'none';
      document.getElementById('saErrorState').style.display   = 'none';
      logsView.style.display = 'none';
      usersView.style.display = 'block';
      if (refreshBtn) refreshBtn.onclick = loadUserManagementData;
      loadUserManagementData();
    } else {
      usersBtn.classList.remove('active'); logsBtn.classList.add('active');
      usersView.style.display = 'none';
      if (refreshBtn) refreshBtn.onclick = loadSuperAdminLogs;
      loadSuperAdminLogs();
    }
  }

  function loadUserManagementData() {
    document.getElementById('saUmLoadingState').style.display = 'block';
    document.getElementById('saUmContent').style.display = 'none';
    google.script.run
      .withSuccessHandler(function (res) {
        document.getElementById('saUmLoadingState').style.display = 'none';
        if (!res || !res.success) {
          showToast(res ? res.message : 'خطأ في جلب بيانات المستخدمين', 'error');
          return;
        }
        _saUmDataCache = res;
        document.getElementById('saUmContent').style.display = 'block';
        renderUserManagementCounts(res.counts);
        renderUserManagementTable();
        var now = new Date();
        var mm  = now.getMinutes() < 10 ? '0' + now.getMinutes() : String(now.getMinutes());
        document.getElementById('saLastRefresh').textContent = 'آخر تحديث: ' + now.getHours() + ':' + mm;
      })
      .withFailureHandler(function () {
        document.getElementById('saUmLoadingState').style.display = 'none';
        showToast('فشل الاتصال بالخادم', 'error');
      })
      .getUserManagementData(sessionToken);
  }

  function renderUserManagementCounts(counts) {
    counts = counts || {};
    var labels = {
      supervisor_division_head: 'مشرفو رئيس شعبة',
      supervisor_unit_head: 'مشرفو رئيس وحدة',
      editor: 'محررون',
      limited_editor: 'محررون محدودون',
      none: 'بدون صلاحية'
    };
    var html = '';
    ['supervisor_division_head','supervisor_unit_head','editor','limited_editor','none'].forEach(function (k) {
      html += '<span class="sa-um-count-chip">' + labels[k] + ': ' + (counts[k] || 0) + '</span>';
    });
    document.getElementById('saUmCounts').innerHTML = html;
  }

  function roleLabelClient_(role) {
    if (role === 'supervisor_division_head') return 'مشرف رئيس شعبة';
    if (role === 'supervisor_unit_head') return 'مشرف رئيس وحدة';
    if (role === 'editor') return 'محرر';
    if (role === 'limited_editor') return 'محرر محدود';
    return 'بدون صلاحية';
  }

  function renderUserManagementTable() {
    if (!_saUmDataCache) return;
    var search = (document.getElementById('saUmSearch').value || '').trim().toLowerCase();
    var filter = document.getElementById('saUmFilter').value;
    var users = _saUmDataCache.users || [];
    var list = document.getElementById('saUmList');

    var filtered = users.filter(function (u) {
      var role = u.role || 'none';
      if (filter !== 'all' && role !== filter) return false;
      if (search) {
        var hay = (u.name + ' ' + u.userId).toLowerCase();
        if (hay.indexOf(search) === -1) return false;
      }
      return true;
    });

    if (filtered.length === 0) {
      list.innerHTML = '<div style="text-align:center;padding:32px;color:var(--text-muted);">لا يوجد مستخدمون مطابقون</div>';
      return;
    }

    var html = '';
    filtered.forEach(function (u) {
      var role = u.role || 'none';
      var selId = 'saUmSel_' + u.userId;
      var offId = 'saUmOff_' + u.userId;
      html += '<div class="sa-um-card">' +
        '<div class="sa-um-card-top">' +
          '<div><div class="sa-um-card-name">' + escHtml(u.name) + '</div>' +
          '<div class="sa-um-card-id">الرقم الذاتي: ' + escHtml(u.userId) + (u.office ? ' — ' + escHtml(u.office) : '') + '</div></div>' +
          '<span class="sa-um-role-badge sa-um-role-' + role + '">' + roleLabelClient_(role) + '</span>' +
        '</div>' +
        '<div class="sa-um-card-controls">' +
          '<select class="sa-um-select" id="' + selId + '" onchange="onSaUmRoleChange(\'' + u.userId + '\')">' +
            '<option value="">اختر دوراً...</option>' +
            '<option value="supervisor_division_head"' + (role==='supervisor_division_head'?' selected':'') + '>مشرف رئيس شعبة</option>' +
            '<option value="supervisor_unit_head"' + (role==='supervisor_unit_head'?' selected':'') + '>مشرف رئيس وحدة</option>' +
            '<option value="editor"' + (role==='editor'?' selected':'') + '>محرر</option>' +
            '<option value="limited_editor"' + (role==='limited_editor'?' selected':'') + '>محرر محدود</option>' +
          '</select>' +
          '<input type="text" class="sa-um-office-input" id="' + offId + '" placeholder="اسم المكتب"' +
            (role==='limited_editor' ? ' style="display:inline-block;"' : '') +
            ' value="' + escHtml(u.roleOffice || u.office || '') + '">' +
          '<button class="sa-um-btn-save" onclick="saveUserRole(\'' + u.userId + '\')"><span class="material-icons">check</span>حفظ</button>' +
          (role !== 'none' ? '<button class="sa-um-btn-remove" onclick="confirmRemoveUserRole(\'' + u.userId + '\', \'' + escHtml(u.name) + '\', \'' + roleLabelClient_(role) + '\')"><span class="material-icons">remove_circle_outline</span>إزالة</button>' : '') +
        '</div>' +
      '</div>';
    });
    list.innerHTML = html;
  }

  function onSaUmRoleChange(userId) {
    var sel = document.getElementById('saUmSel_' + userId);
    var off = document.getElementById('saUmOff_' + userId);
    if (!sel || !off) return;
    off.style.display = sel.value === 'limited_editor' ? 'inline-block' : 'none';
  }

  function saveUserRole(userId) {
    var sel = document.getElementById('saUmSel_' + userId);
    var off = document.getElementById('saUmOff_' + userId);
    var role = sel ? sel.value : '';
    var office = off ? off.value.trim() : '';
    if (!role) { showToast('الرجاء اختيار دور أولاً', 'warning'); return; }
    if (role === 'limited_editor' && !office) { showToast('الرجاء إدخال اسم المكتب للمحرر المحدود', 'warning'); return; }

    google.script.run
      .withSuccessHandler(function (res) {
        if (!res || !res.success) { showToast(res ? res.message : 'فشل تحديث الصلاحية', 'error'); return; }
        showToast(res.message, 'success');
        loadUserManagementData();
      })
      .withFailureHandler(function () { showToast('فشل الاتصال بالخادم', 'error'); })
      .setUserRole(sessionToken, userId, role, office);
  }

  var _saUmRemoveInFlight = {}; // منع تنفيذ عملية الحذف أكثر من مرة لنفس المستخدم أثناء الانتظار

  function confirmRemoveUserRole(userId, userName, roleLabel) {
    showConfirmDialog({
      type: 'error',
      icon: 'remove_circle_outline',
      title: 'تأكيد إزالة الصلاحية',
      message: 'هل أنت متأكد من إزالة صلاحية "' + roleLabel + '" عن المستخدم "' + userName +
        ' (' + userId + ')"؟ سيعود مستخدماً عادياً بدون أي صلاحية إضافية. لا يمكن التراجع عن هذا الإجراء.',
      confirmText: 'تأكيد الإزالة',
      cancelText: 'إلغاء',
      onConfirm: function () { removeUserRoleClient(userId); }
    });
  }

  function removeUserRoleClient(userId) {
    // منع التنفيذ المزدوج إذا تم النقر على "تأكيد" أكثر من مرة قبل انتهاء الطلب
    if (_saUmRemoveInFlight[userId]) return;
    _saUmRemoveInFlight[userId] = true;

    var btn = document.querySelector('.sa-um-btn-remove[data-uid="' + userId + '"]');
    google.script.run
      .withSuccessHandler(function (res) {
        delete _saUmRemoveInFlight[userId];
        if (!res || !res.success) {
          showToast(res ? res.message : 'فشل إزالة الصلاحية — لم تُطبَّق أي تغييرات', 'error');
          return;
        }
        showToast(res.message || 'تمت إزالة الصلاحية بنجاح', 'success');
        // تحديث الجدول محلياً فوراً دون إعادة تحميل الصفحة، ثم إعادة المزامنة مع الخادم
        loadUserManagementData();
      })
      .withFailureHandler(function () {
        delete _saUmRemoveInFlight[userId];
        showToast('فشل الاتصال بالخادم — الرجاء المحاولة مرة أخرى', 'error');
      })
      .removeUserRole(sessionToken, userId);
  }

  function closeSuperAdminPanel() {
    document.getElementById('saOverlay').classList.remove('open');
    document.getElementById('saPanel').classList.remove('open');
    document.body.style.overflow = '';
  }

  function loadSuperAdminLogs() {
    document.getElementById('saLoadingState').style.display = 'block';
    document.getElementById('saErrorState').style.display   = 'none';
    document.getElementById('saContent').style.display      = 'none';

    google.script.run
      .withSuccessHandler(function (res) {
        document.getElementById('saLoadingState').style.display = 'none';
        if (!res || !res.success) {
          document.getElementById('saErrorState').style.display = 'block';
          document.getElementById('saErrorMsg').textContent =
            res ? res.message : 'خطأ في الاتصال بالخادم';
          return;
        }
        renderSuperAdminLogs(res);
      })
      .withFailureHandler(function () {
        document.getElementById('saLoadingState').style.display = 'none';
        document.getElementById('saErrorState').style.display   = 'block';
        document.getElementById('saErrorMsg').textContent = 'خطأ في الاتصال بالخادم';
      })
      .getSuperAdminLogsData(sessionToken);
  }

  function renderSuperAdminLogs(res) {
    /* إحصاءات الهيدر */
    animateCount('saStatTotalLogs', res.totalLogs  || 0, 700);
    animateCount('saStatTodayLogs', res.todayCount || 0, 500);
    animateCount('saStatUsers',     res.usersCount || 0, 600);
    animateCount('saStatSheets',    res.sheetsCount|| 0, 400);

    /* بناء جدول السجلات */
    var rows = res.logs || [];
    var tbody = document.getElementById('saLogsTbody');
    if (rows.length === 0) {
      tbody.innerHTML =
        '<tr><td colspan="6" style="text-align:center;padding:24px;color:var(--text-muted);">لا توجد سجلات حتى الآن</td></tr>';
    } else {
      var opClass = function (op) {
        if (op.indexOf('دخول') !== -1)  return 'sa-op-login';
        if (op.indexOf('أعمال') !== -1) return 'sa-op-submit';
        if (op.indexOf('تعديل') !== -1) return 'sa-op-edit';
        if (op.indexOf('Excel') !== -1 || op.indexOf('تصدير') !== -1) return 'sa-op-export';
        if (op.indexOf('مرور') !== -1)  return 'sa-op-pass';
        return '';
      };
      var html = '';
      rows.forEach(function (r, idx) {
        html += '<tr>' +
          '<td style="color:var(--text-muted);font-weight:700;">' + (idx + 1) + '</td>' +
          '<td style="font-weight:700;white-space:nowrap;font-size:0.8rem;">' + escHtml(r.name || r.userId) + '</td>' +
          '<td><span class="sa-op-badge ' + opClass(r.operation) + '">' + escHtml(r.operation) + '</span></td>' +
          '<td style="white-space:nowrap;font-size:0.75rem;">' + escHtml(r.date) + '</td>' +
          '<td style="font-size:0.75rem;direction:ltr;">' + escHtml(r.time) + '</td>' +
          '<td style="font-size:0.72rem;color:var(--text-muted);">' + escHtml(r.sheet || '—') + '</td>' +
          '</tr>';
      });
      tbody.innerHTML = html;
    }

    var now = new Date();
    var mm  = now.getMinutes() < 10 ? '0' + now.getMinutes() : String(now.getMinutes());
    document.getElementById('saLastRefresh').textContent = 'آخر تحديث: ' + now.getHours() + ':' + mm;
    document.getElementById('saContent').style.display = 'block';
  }

  /**
   * showConfirmDialog — نافذة تأكيد (نعم / إلغاء)
   */
  function showConfirmDialog(config) {
    if (typeof config.cancelText === 'undefined') config.cancelText = 'إلغاء';
    showMdDialog(config);
  }

  /**
   * showAlertDialog — نافذة تنبيه بدون إلغاء
   */
  function showAlertDialog(config) {
    config.cancelText = undefined;
    showMdDialog(config);
  }


  // ==========================================
  // تصدير Excel — للمشرفين والمحرر فقط (التحقق الحقيقي على الخادم)
  // ==========================================
  function exportWorkExcel() {
    // التحقق من الهوية مرة أخرى على جهة العميل (طبقة دفاع إضافية فقط —
    // التحقق الفعلي والملزم أمنياً يتم داخل getMonthlyDataForExport على الخادم)
    var canExportUi = !!currentUser && (currentUser.isSuperAdmin ||
      currentUser.role === 'supervisor_division_head' || currentUser.role === 'supervisor_unit_head' ||
      currentUser.role === 'editor');
    if (!canExportUi) {
      showToast('غير مصرح لك بتصدير البيانات', 'error');
      return;
    }

    var exportSelect = document.getElementById('exportSheetSelect');
    var confirmBtn = document.getElementById('confirmExportSheetBtn');
    if (exportSelect) {
      exportSelect.disabled = true;
      exportSelect.innerHTML = '<option value="" selected disabled>جارٍ تحميل الشهور...</option>';
    }
    if (confirmBtn) confirmBtn.disabled = true;
    openModal('exportSheetModal');

    google.script.run
      .withSuccessHandler(function (res) {
        if (!res || !res.success || !res.sheets || res.sheets.length === 0) {
          if (exportSelect) {
            exportSelect.innerHTML = '<option value="" selected disabled>لا توجد شيتات شهرية</option>';
            exportSelect.disabled = true;
          }
          if (confirmBtn) confirmBtn.disabled = true;
          showToast(res ? res.message : 'لا توجد شيتات شهرية للتصدير', 'warning');
          return;
        }

        exportSelect.disabled = false;
        exportSelect.innerHTML = '<option value="" selected disabled>اختر الشيت الشهري</option>';
        res.sheets.forEach(function (sheetName) {
          var option = document.createElement('option');
          option.value = sheetName;
          option.textContent = sheetName;
          exportSelect.appendChild(option);
        });
        exportSelect.value = res.latestSheetName || res.sheets[0];
        if (confirmBtn) confirmBtn.disabled = false;
      })
      .withFailureHandler(function () {
        if (exportSelect) {
          exportSelect.disabled = true;
          exportSelect.innerHTML = '<option value="" selected disabled>خطأ في تحميل الشهور</option>';
        }
        if (confirmBtn) confirmBtn.disabled = true;
        showToast('خطأ في الاتصال بالخادم', 'error');
      })
      .getMonthlySheetsForExport(sessionToken);
  }

  function confirmExportWorkExcel() {
    var selectedSheetName = document.getElementById('exportSheetSelect').value;
    if (!selectedSheetName) {
      showToast('الرجاء اختيار الشيت الشهري أولاً', 'warning');
      return;
    }

    closeModal('exportSheetModal');

    var exportBtn = document.getElementById('exportExcelBtn');
    var confirmBtn = document.getElementById('confirmExportSheetBtn');
    if (exportBtn) {
      exportBtn.disabled = true;
      exportBtn.innerHTML = '<span class="material-icons" style="animation:spin 1s linear infinite;display:inline-block;">sync</span> جاري التجهيز...';
    }
    if (confirmBtn) confirmBtn.disabled = true;

    showToast('جاري تجهيز ملف Excel لشيت ' + selectedSheetName + '...', 'info');

    google.script.run
      .withSuccessHandler(function (res) {
        if (exportBtn) {
          exportBtn.disabled = false;
          exportBtn.innerHTML = '<span class="material-icons">table_view</span> تصدير Excel';
        }
        if (!res || res.error) {
          showToast(res ? res.error : 'فشل التصدير', 'error');
          return;
        }
        if (!res.data || res.data.length === 0) {
          showToast('لا توجد بيانات للتصدير في الشيت ' + selectedSheetName, 'warning');
          return;
        }

        try {
          var ws = XLSX.utils.aoa_to_sheet(res.data);

          // ضبط اتجاه الورقة RTL
          if (!ws['!cols']) ws['!cols'] = [];
          for (var i = 0; i < (res.data[0] ? res.data[0].length : 1); i++) {
            if (!ws['!cols'][i]) ws['!cols'][i] = {};
            ws['!cols'][i].wch = 20;
          }

          var wb = XLSX.utils.book_new();
          XLSX.utils.book_append_sheet(wb, ws, 'الأعمال اليومية');

          var fileName = 'الأعمال_اليومية_' + (res.month || '') + '_' + todayStr() + '.xlsx';
          XLSX.writeFile(wb, fileName);
          showToast('تم تصدير Excel بنجاح (' + (res.data.length - 1) + ' سجل)', 'success');
        } catch (xlsxErr) {
          showToast('خطأ في إنشاء الملف: ' + xlsxErr.message, 'error');
        }
      })
      .withFailureHandler(function (err) {
        if (exportBtn) {
          exportBtn.disabled = false;
          exportBtn.innerHTML = '<span class="material-icons">table_view</span> تصدير Excel';
        }
        showToast('فشل الاتصال بالخادم', 'error');
      })
      .getMonthlyDataForExport(sessionToken, selectedSheetName);
  }

  function todayStr() {
    var d = new Date();
    return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate();
  }


