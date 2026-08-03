// ====================================================
// api.js — طبقة التواصل مع الخادم
//
// يُحاكي هذا الملف واجهة google.script.run تماماً
// فيحوّل كل استدعاء من نمط:
//   google.script.run
//     .withSuccessHandler(cb)
//     .withFailureHandler(err)
//     .functionName(arg1, arg2)
//
// إلى طلب fetch() POST لرابط API_URL المحدد في config.js
// دون الحاجة لتعديل أي سطر في app.js
// ====================================================

(function () {
  'use strict';

  // قائمة كل الدوال المتاحة في الخادم
  var SERVER_FUNCTIONS = [
    // ── المصادقة وإدارة الجلسات ──
    'login',
    'logout',
    'verifySession',
    'createPassword',
    'changePassword',

    // ── إرسال الأعمال اليومية ──
    'submitWork',
    'syncOfflineEntries',

    // ── الإحصاءات والأشهر ──
    'getActivitySummary',
    'getCurrentMonth',
    'getMonthlySheets',
    'getMonthlySheetsForExport',
    'getDaysFromSelectedMonth',

    // ── إدخالات اليوم ──
    'getEntriesForDay',
    'updateEntry',
    'updateWorkDoneBySupervisor',
    'saveSupervisorNote',
    'saveChiefRating',

    // ── ملف العاملين ──
    'getWorkersList',
    'findWorker',
    'getWorkerProfile',
    'getMyProfile',
    'addWorker',
    'updateWorker',
    'deleteWorker',
    'getWorkerReports',

    // ── لوحة المشرف ──
    'getAdminDashboardData',
    'checkAdminAccess',

    // ── مركز التصدير ──
    'getMonthlyDataForExport',
    'getExportReportData',
    'getExportReportStats',

    // ── لوحة المشرف الخاص (Super Admin) ──
    'getSuperAdminLogsData',
    'getUserManagementData',
    'setUserRole',
    'removeUserRole',

    // ── الملاحظات الشخصية المشفرة ──
    'getMyNotes',
    'createNote',
    'updateNote',
    'deleteNote'
  ];

  // --------------------------------------------------
  // createProxy() — ينشئ كائن تسلسلي يحاكي google.script.run
  // يُستدعى في كل مرة يصل فيها الكود إلى google.script.run
  // حتى تظل معالجات النجاح/الفشل معزولة لكل استدعاء
  // --------------------------------------------------
  function createProxy() {
    var successHandler = function () {};
    var failureHandler = function () {};

    var proxy = {
      withSuccessHandler: function (fn) {
        successHandler = fn || function () {};
        return proxy;
      },
      withFailureHandler: function (fn) {
        failureHandler = fn || function () {};
        return proxy;
      }
    };

    SERVER_FUNCTIONS.forEach(function (fnName) {
      proxy[fnName] = function () {
        var args = Array.prototype.slice.call(arguments);
        var onSuccess = successHandler;
        var onFailure = failureHandler;

        // إعادة ضبط المعالجات فوراً (يحاكي سلوك GAS الأصلي)
        successHandler = function () {};
        failureHandler = function () {};

        callApi(fnName, args, onSuccess, onFailure);
      };
    });

    return proxy;
  }

  // --------------------------------------------------
  // callApi() — يُجري طلب POST الفعلي للخادم
  // Content-Type: text/plain يتجنب طلبات CORS preflight
  // --------------------------------------------------
  function callApi(action, args, onSuccess, onFailure) {
    var url = (typeof APP_CONFIG !== 'undefined' && APP_CONFIG.API_URL)
      ? APP_CONFIG.API_URL
      : '';

    if (!url || url === 'YOUR_GOOGLE_APPS_SCRIPT_WEB_APP_URL_HERE') {
      console.error('[API] لم يتم تعيين API_URL في config.js');
      onFailure(new Error('API_URL غير محدد'));
      return;
    }

    fetch(url, {
      method: 'POST',
      body: JSON.stringify({ action: action, args: args }),
      headers: { 'Content-Type': 'text/plain;charset=utf-8' }
    })
      .then(function (response) {
        if (!response.ok) {
          throw new Error('HTTP ' + response.status + ' ' + response.statusText);
        }
        return response.json();
      })
      .then(function (result) {
        onSuccess(result);
      })
      .catch(function (err) {
        console.error('[API] خطأ في الاتصال:', action, err);
        onFailure(err);
      });
  }

  // --------------------------------------------------
  // تعريف google.script.run كخاصية ديناميكية
  // تُنشئ proxy جديد عند كل وصول — هذا ضروري حتى
  // تعمل السلسلة .withSuccessHandler().functionName()
  // بشكل مستقل لكل استدعاء
  // --------------------------------------------------
  if (typeof window.google === 'undefined') {
    window.google = {};
  }
  if (typeof window.google.script === 'undefined') {
    window.google.script = {};
  }

  Object.defineProperty(window.google.script, 'run', {
    get: function () {
      return createProxy();
    },
    configurable: true
  });

  console.info('[API] تم تهيئة طبقة التواصل مع الخادم');
})();
