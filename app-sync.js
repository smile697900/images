/* =============================================================================
   app-sync.js — 원스텝 워크플로우 보드에 "PC ↔ 폰 자동 동기화"를 붙이는 어댑터
   -----------------------------------------------------------------------------
   · 원본 보드 코드는 건드리지 않고, saveData() 를 감싸서 자동으로 올리고
     6초마다 새 기록을 확인해 내려받습니다.
   · 저장 위치: GitHub 비공개 저장소의 board.json  또는  비밀 Gist
   · 토큰은 이 기기의 localStorage 에만 저장되며 외부로 전송되지 않습니다
     (api.github.com 외에는 어떤 서버도 거치지 않습니다).
   ========================================================================== */
(function () {
  'use strict';

  if (typeof window === 'undefined') return;
  if (!window.OnestepSync) { console.warn('[cloud] sync.js 가 먼저 로드되어야 합니다.'); return; }

  var POLL_MS = 6000;
  var PUSH_DEBOUNCE_MS = 1200;
  var VERSION = '1.0';

  var store = {
    getItem: function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    setItem: function (k, v) { try { localStorage.setItem(k, v); } catch (e) {} },
    removeItem: function (k) { try { localStorage.removeItem(k); } catch (e) {} }
  };
  var sync = window.OnestepSync.create({ storage: store });

  var S = {
    pushTimer: null,
    pushing: false,
    pushQueued: false,
    lastPushedHash: null,
    autoTimer: null,
    lastResult: '',
    installing: false
  };

  /* ------------------------------------------------------------- utilities */
  function hashStr(s) {
    var h = 5381;
    for (var i = 0; i < s.length; i++) { h = ((h << 5) + h + s.charCodeAt(i)) | 0; }
    return h + ':' + s.length;
  }
  function board() { try { return boardData; } catch (e) { return null; } }
  function boardJson() { var b = board(); if (!b) return null; return JSON.stringify(b); }
  function revOf(b) { var v = b && b._syncRev; return typeof v === 'number' && v >= 0 ? v : 0; }
  function persistQuietly(b, rev) {
    try {
      if (typeof rev === 'number') b._syncRev = rev;
      var js = JSON.stringify(b);
      var at = b.savedAt || new Date().toISOString();
      localStorage.setItem(CURRENT_STORAGE_KEY, js);
      localStorage.setItem(LS_TIME_KEY, at);
      idbPut('board', { json: js, savedAt: at }, 'main').catch(function () {});
    } catch (e) {}
  }
  function hasData(b) { return !!(b && ((b.cards && b.cards.length) || (b.archive && b.archive.length))); }
  function toast(msg) { try { showToast(msg); } catch (e) { console.log(msg); } }
  function hhmm(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
  }
  function el(id) { return document.getElementById(id); }

  /* ------------------------------------------------------- 입금 계좌 문구 */
  // 공개 코드(HTML)에는 계좌번호를 넣지 않습니다. 기기에서 한 번 저장하면 그 기기에만 보관됩니다.
  var BANK_KEY = 'onestep_deposit_accounts_v1';
  function bankStore() { try { return JSON.parse(localStorage.getItem(BANK_KEY) || '{}') || {}; } catch (e) { return {}; } }
  function saveBankStore(o) { try { localStorage.setItem(BANK_KEY, JSON.stringify(o)); } catch (e) {} }
  function applyDepositAccounts() {
    var b = bankStore();
    try {
      if (b.hana) DEPOSIT_BANKS.hana = b.hana;
      if (b.busan) DEPOSIT_BANKS.busan = b.busan;
    } catch (e) { return; }
    try {
      var span = el('txtSelectedBankAccount');
      if (span) {
        var key = (typeof getSelectedDepositBank === 'function' && getSelectedDepositBank() === 'busan') ? 'busan' : 'hana';
        span.textContent = DEPOSIT_BANKS[key];
      }
    } catch (e) {}
  }

  /* --------------------------------------------------------------- badge */
  function updateBadge(kind, extra) {
    var b = el('cloudBadge');
    if (!b) return;
    var info = sync.info();
    var txt, color, title;
    if (kind === 'off' || !info.configured) {
      txt = '☁️ 동기화 꺼짐'; color = '#94a3b8';
      title = '클릭하면 PC·폰 자동 동기화를 켤 수 있습니다';
    } else if (kind === 'saving' || info.busy) {
      txt = '☁️ 올리는 중…'; color = '#38bdf8'; title = 'GitHub에 저장 중입니다';
    } else if (kind === 'error') {
      txt = '⚠️ 동기화 오류'; color = '#ef4444'; title = info.lastError || '동기화 오류';
    } else if (kind === 'warn') {
      txt = '☁️ 충돌 확인'; color = '#f59e0b'; title = info.lastError || '다른 기기가 먼저 저장했습니다';
    } else {
      txt = '☁️ 동기화 ' + (hhmm(info.lastPushAt || info.lastPullAt) ? hhmm(info.lastPushAt || info.lastPullAt) : '준비');
      color = '#22c55e';
      title = 'PC·폰 자동 동기화 작동 중 — ' + info.target;
    }
    b.textContent = txt;
    b.style.color = color;
    b.title = title + (extra ? ' · ' + extra : '');
    var folderBadge = el('folderSaveBadge');
    // 웹판은 'PC 폴더 자동저장(실행.bat)' 안내가 해당 없으므로 항상 숨깁니다.
    if (folderBadge) folderBadge.style.display = 'none';
  }

  /* ---------------------------------------------------------- pull / apply */
  function syncModalOpenOnly() {
    var open = document.querySelectorAll('.modal-overlay.active');
    for (var i = 0; i < open.length; i++) {
      var id = open[i].id;
      if (id === 'firstRunModal' || id === 'cloudSyncModal') continue;
      return false;
    }
    return true;
  }
  function canApplyNow() {
    if (document.querySelector('.lightbox.active')) return false;
    if (S.pushing || S.pushTimer) return false;
    if (!syncModalOpenOnly()) return false;
    var ae = document.activeElement;
    if (ae && /^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName)) {
      var inSync = ae.closest ? ae.closest('#cloudSyncModal') : null;
      if (!inSync) return false;
    }
    return true;
  }

  function applyRemote(out) {
    var payload = out && out.payload;
    if (!payload || !payload.data) return false;
    var data = payload.data;
    if (!Array.isArray(data.cards)) data.cards = [];
    if (!Array.isArray(data.archive)) data.archive = [];
    if (!Array.isArray(data.columns) || !data.columns.length) {
      try { data.columns = JSON.parse(JSON.stringify(DEFAULT_DATA_EMPTY.columns)); } catch (e) { return false; }
    }
    // 지금 화면 내용을 앱 내부 백업에 남겨두고 덮어씁니다(되돌릴 수 있음)
    try { var cur = boardJson(); if (cur) writeAutoSnapshot(cur); } catch (e) {}
    boardData = data;
    try { persistQuietly(boardData, typeof out.rev === 'number' ? out.rev : revOf(boardData)); } catch (e) {}
    try { renderBoard(el('searchInput') ? el('searchInput').value : ''); } catch (e) {}
    try { updateSaveStatus(true); updateStorageIndicator(); } catch (e) {}
    try { refreshBadgeTexts(); } catch (e) {}
    S.lastPushedHash = hashStr(JSON.stringify(boardData));
    var firstRun = el('firstRunModal');
    if (firstRun && firstRun.classList.contains('active')) firstRun.classList.remove('active');
    updateBadge('ok');
    toast('📱 ' + (out.deviceName || '다른 기기') + '에서 바뀐 내용을 불러왔습니다.');
    return true;
  }

  function pullNow(force) {
    if (!sync.isReady()) return Promise.resolve(null);
    var b = board();
    if (!b) return Promise.resolve(null);
    if (force !== true && (S.pushing || S.pushTimer)) return Promise.resolve(null);
    return sync.pull({ localRev: revOf(b), force: !!force }).then(function (out) {
      renderStatus();
      if (!out) return out;
      if (out.action === 'apply') {
        if (canApplyNow()) applyRemote(out);
        else if (force === true) {
          var ok = window.confirm('지금 편집 중인 창이 열려 있습니다.\n서버의 최신 기록으로 바꾸면 지금 화면 내용은 앱 내부 백업으로 남고 화면이 교체됩니다. 계속할까요?');
          if (ok) applyRemote(out);
        }
      } else if (out.ok === false && out.reason === 'error') {
        updateBadge('error');
      } else if (out.ok !== false) {
        updateBadge('ok');
      }
      return out;
    });
  }

  /* -------------------------------------------------------------- push */
  function schedulePush(delay) {
    if (S.pushTimer) clearTimeout(S.pushTimer);
    S.pushTimer = setTimeout(function () { S.pushTimer = null; pushNow(false); }, delay || PUSH_DEBOUNCE_MS);
  }

  function pushNow(force) {
    if (!sync.isReady()) return Promise.resolve(null);
    var b = board();
    if (!b) return Promise.resolve(null);
    if (S.pushing) { S.pushQueued = true; return Promise.resolve(null); }
    var text = JSON.stringify(b);
    var h = hashStr(text);
    if (!force && h === S.lastPushedHash) return Promise.resolve(null);
    S.pushing = true;
    updateBadge('saving');
    return sync.push(b, { savedAt: b.savedAt, localRev: revOf(b), force: !!force }).then(function (out) {
      S.pushing = false;
      if (out && out.ok) {
        persistQuietly(b, out.rev);
        S.lastPushedHash = hashStr(JSON.stringify(b));
        updateBadge('ok');
        renderStatus();
      } else if (out && out.conflict) {
        updateBadge('warn');
        toast('☁️ 다른 기기(' + (out.remoteDevice || '?') + ')가 먼저 저장했습니다. 최신 내용을 불러옵니다.');
        pullNow(true);
      } else if (out && out.reason === 'busy') {
        schedulePush(1500);
      } else {
        updateBadge('error');
        renderStatus();
      }
      if (S.pushQueued) { S.pushQueued = false; schedulePush(600); }
      return out;
    });
  }

  function onLocalChange() {
    if (!sync.isReady()) return;
    var text = boardJson();
    if (!text) return;
    if (hashStr(text) === S.lastPushedHash) return;
    updateBadge('saving');
    schedulePush();
  }

  /* ------------------------------------------------------------- install */
  function install() {
    if (S.installing) return;
    S.installing = true;

    // 0) 계좌 문구는 공개 코드에 없으므로 기기 저장값을 적용
    try { applyDepositAccounts(); } catch (e) {}

    // 0-1) 웹판은 클라우드 동기화 + 앱 내부 자동백업이 있으므로, 2분마다 Downloads 로
    //      JSON 파일을 쏟아내는 자동 다운로드를 끕니다(수동 [📥 지금 백업]은 그대로 동작).
    try { window.maybeAutoDownloadBackup = function () { return false; }; } catch (e) {}

    // 1) saveData 감싸기 → 편집할 때마다 자동 업로드
    try {
      if (typeof window.saveData === 'function' && !window.saveData.__cloudWrapped) {
        var orig = window.saveData;
        var wrapped = function () {
          var r = orig.apply(this, arguments);
          try { onLocalChange(); } catch (e) {}
          return r;
        };
        wrapped.__cloudWrapped = true;
        window.saveData = wrapped;
      }
    } catch (e) { console.warn('[cloud] saveData 패치 실패', e); }

    // 2) 웹 버전에서는 "PC 폴더 자동저장(실행.bat)" 안내 대신 동기화 안내
    try {
      window.showFirstRunNotice = function () {
        var fm = el('firstRunModal');
        if (fm) fm.classList.remove('active');
        if (!sync.isReady()) setTimeout(function () { UI.open(true); }, 350);
        else toast('☁️ 클라우드 동기화로 기록을 불러오는 중입니다…');
      };
    } catch (e) {}

    // 3) 주기적 확인 + 탭 복귀/포커스 시 즉시 확인
    if (S.autoTimer) clearInterval(S.autoTimer);
    S.autoTimer = setInterval(function () {
      if (document.visibilityState === 'visible') pullNow(false);
    }, POLL_MS);
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') pullNow(false);
    });
    window.addEventListener('focus', function () { pullNow(false); });
    window.addEventListener('online', function () { toast('☁️ 인터넷 연결됨 — 동기화 재개'); pullNow(false); });
    window.addEventListener('offline', function () { updateBadge('error', '오프라인'); });

    // 4) 시작 시: 원격이 더 최신이면 이 기기 데이터가 올라가지 않도록 먼저 내려받기 확인
    setTimeout(function () {
      updateBadge(sync.isReady() ? 'ok' : 'off');
      if (sync.isReady()) pullNow(false);
    }, 1200);
  }

  /* ------------------------------------------------------------------ UI */
  var UI = {
    built: false,
    open: function (isFirst) {
      UI.build();
      UI.fill();
      el('cloudSyncModal').classList.add('active');
      if (isFirst) setStatus('처음 한 번만 설정하면 됩니다. 아래 방법 중 하나를 고르세요.', 'info');
    },
    close: function () { var m = el('cloudSyncModal'); if (m) m.classList.remove('active'); },

    build: function () {
      if (UI.built) return;
      UI.built = true;
      var wrap = document.createElement('div');
      wrap.className = 'modal-overlay';
      wrap.id = 'cloudSyncModal';
      wrap.innerHTML = ''
        + '<div class="modal" style="max-width:620px;">'
        + '  <div class="modal-header">'
        + '    <h2>☁️ PC ↔ 폰 자동 동기화</h2>'
        + '    <button class="close-btn" id="btnCloseCloud">&times;</button>'
        + '  </div>'
        + '  <div class="modal-body">'
        + '    <div id="cloudStatusBox" style="font-size:0.8rem; line-height:1.5; background:#1e293b; border:1px solid #334155; border-radius:8px; padding:10px 12px; color:#cbd5e1;">동기화 상태를 확인 중…</div>'
        + '    <div class="form-group">'
        + '      <label>저장 방식</label>'
        + '      <select id="cloudMode">'
        + '        <option value="off">사용 안 함 (이 기기에만 저장)</option>'
        + '        <option value="repo">① GitHub 비공개 저장소 (권장 · 안전)</option>'
        + '        <option value="gist">② 비밀 Gist (간편 · 사진 적을 때)</option>'
        + '      </select>'
        + '    </div>'
        + '    <div class="form-group">'
        + '      <label>GitHub 토큰 (PAT)</label>'
        + '      <input type="password" id="cloudToken" placeholder="ghp_... 또는 github_pat_..." autocomplete="off" spellcheck="false">'
        + '      <span style="font-size:0.7rem; color:#94a3b8; line-height:1.45;">이 기기 브라우저에만 저장됩니다. 화면·채팅·서버로 전송되지 않습니다.</span>'
        + '    </div>'
        + '    <div id="cloudRepoFields">'
        + '      <div class="form-row-3">'
        + '        <div class="form-group"><label>아이디</label><input type="text" id="cloudOwner" placeholder="smile697900"></div>'
        + '        <div class="form-group"><label>저장소</label><input type="text" id="cloudRepo" placeholder="onestep-workflow-data"></div>'
        + '        <div class="form-group"><label>파일 경로</label><input type="text" id="cloudPath" placeholder="board.json"></div>'
        + '      </div>'
        + '      <div class="form-group"><label>브랜치 (비우면 기본 브랜치)</label><input type="text" id="cloudBranch" placeholder="main"></div>'
        + '    </div>'
        + '    <div style="font-size:0.72rem; color:#94a3b8; line-height:1.5;" id="cloudHelp"></div>'
        + '    <details style="border:1px solid #334155; border-radius:8px; padding:8px 10px;">'
        + '      <summary style="cursor:pointer; font-size:0.78rem; color:#94a3b8; font-weight:700;">🏦 입금 계좌 문구 (이 기기에만 저장 · 공개 코드에 없음)</summary>'
        + '      <div class="form-group" style="margin-top:8px;"><label>하나은행</label><input type="text" id="cloudBankHana" placeholder="하나은행 000-000000-00000 예금주"></div>'
        + '      <div class="form-group"><label>부산은행</label><input type="text" id="cloudBankBusan" placeholder="부산은행 0000000000000 예금주"></div>'
        + '      <button type="button" class="btn-secondary" id="btnCloudBankSave" style="margin-top:6px;">계좌 저장</button>'
        + '    </details>'
        + '    <div style="display:flex; gap:8px; flex-wrap:wrap;">'
        + '      <button type="button" class="btn-primary" id="btnCloudConnect">🔗 연결하고 저장</button>'
        + '      <button type="button" class="btn-secondary" id="btnCloudTest">연결 테스트</button>'
        + '      <button type="button" class="btn-secondary" id="btnCloudPush">⬆ 지금 올리기</button>'
        + '      <button type="button" class="btn-secondary" id="btnCloudPull">⬇ 지금 내려받기</button>'
        + '      <button type="button" class="btn-secondary" id="btnCloudCode" style="border-color:#a78bfa;color:#ddd6fe;">⚙️ 설정 코드 복사</button>'
        + '      <button type="button" class="btn-secondary" id="btnCloudCodeIn" style="border-color:#a78bfa;color:#ddd6fe;">⚙️ 설정 코드 붙여넣기</button>'
        + '      <button type="button" class="btn-secondary" id="btnCloudOff" style="border-color:#ef4444;color:#fca5a5;">연결 해제</button>'
        + '    </div>'
        + '  </div>'
        + '  <div class="modal-footer">'
        + '    <span style="font-size:0.72rem; color:#94a3b8;">편집하면 약 1~2초 뒤 자동으로 올라가고, 다른 기기에서는 6초 안에 반영됩니다.</span>'
        + '    <button type="button" id="btnCloseCloud2">닫기</button>'
        + '  </div>'
        + '</div>';
      document.body.appendChild(wrap);

      el('btnCloseCloud').onclick = UI.close;
      el('btnCloseCloud2').onclick = UI.close;
      wrap.addEventListener('click', function (e) { if (e.target === wrap) UI.close(); });
      el('cloudMode').onchange = UI.onModeChange;
      el('btnCloudConnect').onclick = UI.connect;
      el('btnCloudTest').onclick = UI.test;
      el('btnCloudPush').onclick = UI.forcePush;
      el('btnCloudPull').onclick = UI.forcePull;
      el('btnCloudCode').onclick = UI.exportCode;
      el('btnCloudCodeIn').onclick = UI.importCode;
      el('btnCloudOff').onclick = UI.disconnect;
      el('btnCloudBankSave').onclick = UI.saveBanks;
      renderStatus();
    },

    fill: function () {
      var c = sync.getConfig();
      el('cloudMode').value = sync.isReady() ? c.mode : (c.mode === 'off' ? 'off' : c.mode);
      el('cloudToken').value = c.token || '';
      el('cloudOwner').value = c.owner || '';
      el('cloudRepo').value = c.repo || '';
      el('cloudPath').value = c.path || '';
      el('cloudBranch').value = c.branch || '';
      var bk = bankStore();
      if (el('cloudBankHana')) el('cloudBankHana').value = bk.hana || '';
      if (el('cloudBankBusan')) el('cloudBankBusan').value = bk.busan || '';
      UI.onModeChange();
      renderStatus();
    },

    onModeChange: function () {
      var m = el('cloudMode').value;
      el('cloudRepoFields').style.display = m === 'repo' ? '' : 'none';
      var help = el('cloudHelp');
      if (m === 'repo') {
        help.innerHTML = '비공개 저장소 1개에 <b>board.json</b> 한 파일로 저장합니다. '
          + '토큰은 <b>Fine-grained token</b> → Repository access: <b>Only select repositories</b> → 저장소 선택 → '
          + 'Permissions → <b>Contents: Read and write</b> 만 주면 충분합니다.';
      } else if (m === 'gist') {
        help.innerHTML = '토큰은 <b>classic token</b> 에서 <b>gist</b> 권한만 체크하면 됩니다. '
          + '첫 저장 때 <b>비밀 Gist</b>가 자동으로 만들어집니다. (사진이 많아 1MB를 넘으면 저장소 방식을 쓰세요)';
      } else {
        help.innerHTML = '동기화를 끄면 이 브라우저에만 저장됩니다. 백업은 [💾 백업/복원]에서 받을 수 있습니다.';
      }
    },

    readForm: function () {
      return {
        mode: el('cloudMode').value,
        token: el('cloudToken').value.trim(),
        owner: el('cloudOwner').value.trim(),
        repo: el('cloudRepo').value.trim(),
        path: el('cloudPath').value.trim() || 'board.json',
        branch: el('cloudBranch').value.trim()
      };
    },

    connect: function () {
      var c = UI.readForm();
      if (c.mode === 'off') { UI.disconnect(); return; }
      if (!c.token) { setStatus('토큰을 입력해 주세요.', 'err'); return; }
      if (c.mode === 'repo' && (!c.owner || !c.repo)) { setStatus('아이디와 저장소 이름을 입력해 주세요.', 'err'); return; }
      sync.configure(c);
      setStatus('연결 확인 중…', 'info');
      sync.test().then(function (info) {
        var lines = ['✅ 토큰 확인됨: <b>' + (info.login || '?') + '</b>'];
        if (c.mode === 'repo') {
          if (info.repoFound && info.repoPrivate) lines.push('✅ 비공개 저장소 <b>' + c.owner + '/' + c.repo + '</b> 사용 가능');
          else if (info.repoFound && !info.repoPrivate) lines.push('⚠️ 저장소가 <b>공개</b>로 되어 있습니다. 고객 정보가 노출되므로 비공개로 바꾸거나 새 비공개 저장소를 만드세요.');
          else lines.push('⚠️ 저장소 <b>' + c.owner + '/' + c.repo + '</b> 를 찾지 못했습니다. GitHub에서 <b>Private</b> 저장소를 하나 만들고 이름을 정확히 넣어주세요.');
        } else {
          lines.push('✅ Gist 권한 확인 — 첫 저장 때 비밀 Gist가 자동 생성됩니다.');
        }
        setStatus(lines.join('<br>'), 'ok');
        return sync.pull({ localRev: revOf(board()), force: false }).then(function (out) {
          renderStatus();
          if (out && out.action === 'apply') {
            var ok = window.confirm('서버에 더 최신 기록이 있습니다.\n이 기기 화면을 서버 기록으로 바꿀까요?\n(지금 화면 내용은 앱 내부 백업에 남습니다)');
            if (ok) applyRemote(out); else pushNow(true);
          } else if (hasData(board())) {
            setStatus('이 기기 기록을 서버에 처음 올리는 중…', 'info');
            return pushNow(true).then(function (r) {
              if (r && r.ok) setStatus('✅ 연결 완료 — 이 기기 기록을 올렸습니다. 폰에서 같은 설정을 하면 그대로 보입니다.', 'ok');
              else setStatus('⚠️ 업로드 실패: ' + ((r && (r.error || r.reason)) || '알 수 없음'), 'err');
              renderStatus();
            });
          } else {
            setStatus('✅ 연결됨. 다른 기기에서 올린 기록을 기다리는 중입니다.', 'ok');
          }
        });
      }).catch(function (e) {
        setStatus('❌ ' + (e && e.message ? e.message : '연결 실패'), 'err');
      }).then(function () { updateBadge(sync.isReady() ? (sync.info().lastError ? 'error' : 'ok') : 'off'); renderStatus(); });
    },

    test: function () {
      var c = UI.readForm();
      if (!c.token) { setStatus('토큰을 입력해 주세요.', 'err'); return; }
      sync.configure(c);
      setStatus('확인 중…', 'info');
      sync.test().then(function (info) {
        var t = ['✅ 토큰: <b>' + (info.login || '?') + '</b>'];
        if (info.mode === 'repo') t.push(info.repoFound ? (info.repoPrivate ? '✅ 비공개 저장소 접근 OK' : '⚠️ 공개 저장소입니다') : '⚠️ 저장소를 찾지 못했습니다');
        setStatus(t.join('<br>'), 'ok');
      }).catch(function (e) { setStatus('❌ ' + (e.message || '실패'), 'err'); });
    },

    forcePush: function () {
      if (!sync.isReady()) { setStatus('먼저 연결해 주세요.', 'err'); return; }
      setStatus('올리는 중…', 'info');
      pushNow(true).then(function (r) {
        if (r && r.ok) setStatus('✅ 이 기기 기록을 서버에 올렸습니다.', 'ok');
        else setStatus('⚠️ ' + ((r && (r.error || (r.conflict ? '다른 기기가 먼저 저장했습니다. [지금 내려받기]를 눌러 확인하세요.' : r.reason))) || '실패'), 'err');
        renderStatus();
      });
    },

    forcePull: function () {
      if (!sync.isReady()) { setStatus('먼저 연결해 주세요.', 'err'); return; }
      setStatus('내려받는 중…', 'info');
      pullNow(true).then(function (out) {
        if (out && out.action === 'apply') setStatus('✅ 서버 기록으로 교체했습니다.', 'ok');
        else if (out && out.reason === 'remote-empty') setStatus('⚠️ 서버에 아직 기록이 없습니다. [지금 올리기]를 누르세요.', 'err');
        else if (out && out.ok) setStatus('이미 최신입니다.', 'ok');
        else setStatus('⚠️ ' + ((out && (out.error || out.reason)) || '실패'), 'err');
        renderStatus();
      });
    },

    saveBanks: function () {
      var o = {};
      var hana = el('cloudBankHana') ? el('cloudBankHana').value.trim() : '';
      var busan = el('cloudBankBusan') ? el('cloudBankBusan').value.trim() : '';
      if (hana) o.hana = hana;
      if (busan) o.busan = busan;
      saveBankStore(o);
      applyDepositAccounts();
      setStatus('✅ 입금 계좌 문구를 이 기기에 저장했습니다. (카드 창의 [입금 계좌]에 바로 반영)', 'ok');
      toast('🏦 계좌 문구 저장 완료');
    },

    // 설정 코드: 모드·저장소·토큰을 한 줄로 묶어 다른 기기로 옮길 때 씁니다(전달 수단은 사용자가 선택)
    exportCode: function () {
      var c = sync.getConfig();
      var banks = bankStore();
      if (!c.token || !sync.isReady()) { setStatus('먼저 연결해 주세요.', 'err'); return; }
      var code = '';
      try {
        var pack = { mode: c.mode, token: c.token, owner: c.owner, repo: c.repo, path: c.path, branch: c.branch, gistId: c.gistId, apiBase: c.apiBase, banks: banks };
        code = btoa(unescape(encodeURIComponent(JSON.stringify(pack))));
      } catch (e) { setStatus('설정 코드를 만들지 못했습니다.', 'err'); return; }
      var done = function () { setStatus('✅ 설정 코드를 복사했습니다.<br>다른 기기에서 <b>[⚙️ 설정 코드 붙여넣기]</b>를 눌러 붙여넣으면 10초 만에 연결됩니다.<br><span style="color:#fbbf24;">이 코드에는 토큰이 들어 있으니 아무에게나 보내지 마세요.</span>', 'ok'); };
      var fail = function () { setStatus('복사 권한이 없습니다. 아래 코드를 길게 눌러 직접 복사하세요:<br><textarea id="cloudCodeBox" style="width:100%;height:70px;margin-top:6px;background:#0f172a;color:#e2e8f0;border:1px solid #334155;border-radius:6px;padding:6px;font-size:11px;" readonly>' + code + '</textarea>', 'info'); };
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(code).then(done).catch(fail); return; }
      } catch (e) {}
      fail();
    },

    importCode: function () {
      var code = window.prompt('다른 기기에서 [⚙️ 설정 코드 복사]로 복사한 코드를 붙여넣으세요.');
      if (!code) return;
      code = String(code).trim();
      var cfg;
      try { cfg = JSON.parse(decodeURIComponent(escape(atob(code)))); } catch (e) { setStatus('⚠️ 코드를 읽지 못했습니다. 복사한 코드가 잘리지 않았는지 확인해 주세요.', 'err'); return; }
      if (!cfg || !cfg.token || !cfg.mode) { setStatus('⚠️ 올바른 설정 코드가 아닙니다.', 'err'); return; }
      if (cfg.banks && (cfg.banks.hana || cfg.banks.busan)) { saveBankStore(cfg.banks); applyDepositAccounts(); }
      var banks = cfg.banks; delete cfg.banks;
      sync.configure(cfg);
      UI.fill();
      setStatus('✅ 설정을 가져왔습니다. 연결을 확인합니다…', 'info');
      setTimeout(function () { UI.connect(); }, 60);
    },

    disconnect: function () {
      if (!window.confirm('이 기기에서 동기화 연결을 해제할까요? (저장된 토큰이 이 기기에서 삭제됩니다)')) return;
      sync.forget();
      updateBadge('off');
      renderStatus();
      setStatus('동기화 연결을 해제했습니다. 이 기기 데이터는 그대로 남아 있습니다.', 'info');
    }
  };

  function setStatus(html, kind) {
    var box = el('cloudStatusBox');
    if (!box) return;
    box.innerHTML = html;
    box.style.borderColor = kind === 'err' ? '#ef4444' : kind === 'ok' ? '#22c55e' : '#334155';
  }

  function renderStatus() {
    var info = sync.info();
    var box = el('cloudStatusBox');
    if (!box) return;
    var rows = [];
    if (!info.configured) {
      if (!box.innerHTML || /확인 중/.test(box.textContent)) {
        setStatus('아직 동기화가 꺼져 있습니다. 아래에서 방식을 고르고 토큰을 넣으면 켜집니다.', 'info');
      }
      return;
    }
    rows.push('저장 방식: <b>' + (info.mode === 'repo' ? '비공개 저장소' : '비밀 Gist') + '</b> · ' + escapeHtml(info.target));
    rows.push('이 기기: ' + escapeHtml(info.device.name));
    if (info.lastPushAt) rows.push('마지막 업로드: ' + hhmm(info.lastPushAt));
    if (info.lastPullAt) rows.push('마지막 확인: ' + hhmm(info.lastPullAt));
    if (info.lastError) rows.push('<span style="color:#fca5a5;">⚠️ ' + escapeHtml(info.lastError) + '</span>');
    else rows.push('<span style="color:#86efac;">정상 작동 중</span>');
    setStatus(rows.join('<br>'), info.lastError ? 'err' : 'ok');
    updateBadge(info.lastError ? 'error' : 'ok');
  }
  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* ---------------------------------------------------------------- start */
  window.OnestepSyncUI = UI;
  window.OnestepCloud = { sync: sync, UI: UI, pullNow: pullNow, pushNow: pushNow, version: VERSION };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(install, 0); });
  } else {
    setTimeout(install, 0);
  }
})();
