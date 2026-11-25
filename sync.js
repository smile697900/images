/* =============================================================================
   OnestepSync v1.1 — 원스텝 워크플로우 보드 PC↔모바일 양방향 동기화 엔진
   -----------------------------------------------------------------------------
   · 저장소: GitHub (비공개 저장소의 JSON 파일  또는  비밀 Gist)
   · 토큰은 이 기기의 브라우저 저장소에만 보관되며 코드에는 포함되지 않습니다.
   · 서버 없이 브라우저에서 api.github.com 을 직접 호출합니다(CORS 허용 확인됨).
   · 최신 판단은 "리비전 번호(rev)"로 합니다. (기기 시계가 달라도 순서가 틀어지지 않음)
   · Node 테스트에서도 쓸 수 있도록 의존성 주입식(UMD)으로 작성했습니다.
   ========================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.OnestepSync = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var APP_TAG = 'onestep-workflow-board';
  var PAYLOAD_VERSION = 1;
  var CFG_KEY = 'onestep_sync_cfg_v1';
  var DEV_KEY = 'onestep_sync_device_v1';
  var GIST_FILE = 'onestep-board.json';
  var DEFAULT_REPO = { owner: 'smile697900', repo: 'onestep-workflow-data', path: 'board.json', branch: '' };
  var API_FALLBACK = 'https://api.github.com';

  /* ---------------------------------------------------------------- helpers */
  function b64encodeUtf8(str) {
    var bytes = new TextEncoder().encode(str);
    var bin = '';
    var CH = 0x8000;
    for (var i = 0; i < bytes.length; i += CH) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
    }
    return btoa(bin);
  }
  function b64decodeUtf8(b64) {
    var bin = atob(String(b64 || '').replace(/\s/g, ''));
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }
  function isIso(s) { return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(s) && !isNaN(Date.parse(s)); }
  function safeJson(text) {
    try { return JSON.parse(text); } catch (e) { return null; }
  }
  function isoOrNull(s) { return isIso(s) ? new Date(s).toISOString() : null; }

  /* ------------------------------------------------------------------- core */
  function createSync(options) {
    options = options || {};
    var store = options.storage;                 // {getItem, setItem, removeItem} (localStorage 호환)
    var fetchFn = options.fetch || (typeof fetch !== 'undefined' ? fetch.bind(typeof self !== 'undefined' ? self : this) : null);
    var log = options.log || function () {};
    var state = {
      remoteRev: null,           // 서버 기록의 리비전 (마지막으로 확인/기록한 값)
      sha: null,                 // repo 파일 sha (충돌 방지)
      etag: null,                // 조건부 GET용
      lastError: null,
      lastPushAt: null,
      lastPullAt: null,
      serverOffsetMs: 0,         // 참고용(표시) — 순서 판단에는 쓰지 않음
      busy: false
    };
    var device = loadDevice();

    /* ---------------- config ---------------- */
    function loadCfg() {
      var raw = store && store.getItem ? store.getItem(CFG_KEY) : null;
      var c = raw ? safeJson(raw) : null;
      c = c || {};
      return {
        mode: c.mode || 'off',                                     // 'off' | 'repo' | 'gist'
        token: c.token || '',
        owner: c.owner || DEFAULT_REPO.owner,
        repo: c.repo || DEFAULT_REPO.repo,
        path: c.path || DEFAULT_REPO.path,
        branch: c.branch || '',
        gistId: c.gistId || '',
        apiBase: c.apiBase || API_FALLBACK
      };
    }
    var cfg = loadCfg();

    function loadDevice() {
      var raw = store && store.getItem ? store.getItem(DEV_KEY) : null;
      var d = raw ? safeJson(raw) : null;
      if (d && d.id) return d;
      var id = 'dev-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
      var name = '기기';
      try {
        var ua = (typeof navigator !== 'undefined' && navigator.userAgent) || '';
        if (/Android/i.test(ua)) name = '안드로이드폰';
        else if (/iPhone|iPad/i.test(ua)) name = '아이폰';
        else if (/Windows/i.test(ua)) name = 'PC(윈도우)';
        else if (/Mac OS X/i.test(ua)) name = '맥';
        else if (/Linux/i.test(ua)) name = 'PC(리눅스)';
      } catch (e) {}
      d = { id: id, name: name };
      try { store.setItem(DEV_KEY, JSON.stringify(d)); } catch (e) {}
      return d;
    }

    function apiUrl(p) { return String(cfg.apiBase || API_FALLBACK).replace(/\/+$/, '') + p; }
    function headers(extra) {
      var h = {
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28'
      };
      if (cfg.token) h['Authorization'] = 'Bearer ' + cfg.token;
      if (extra) for (var k in extra) h[k] = extra[k];
      return h;
    }
    function req(path, opts) {
      if (!fetchFn) return Promise.reject(new Error('fetch를 사용할 수 없습니다.'));
      opts = opts || {};
      var url = /^https?:/.test(path) ? path : apiUrl(path);
      var init = { method: opts.method || 'GET', headers: headers(opts.headers) };
      if (opts.body !== undefined) {
        init.body = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
        init.headers['Content-Type'] = 'application/json';
      }
      return fetchFn(url, init).then(function (res) {
        try {
          var d = res.headers && res.headers.get ? res.headers.get('Date') : null;
          if (d) { var t = Date.parse(d); if (!isNaN(t)) state.serverOffsetMs = t - Date.now(); }
        } catch (e) {}
        return res.text().then(function (text) {
          var json = text ? safeJson(text) : null;
          return { status: res.status, ok: res.ok, json: json, text: text, headers: res.headers };
        });
      });
    }
    function ghError(r, fallback) {
      var m = (r && r.json && (r.json.message || '')) || '';
      if (r && r.status === 401) return '토큰이 올바르지 않거나 만료되었습니다. GitHub에서 새 토큰을 발급해 다시 넣어주세요.';
      if (r && r.status === 403) {
        var rem = null;
        try { rem = r.headers.get('X-RateLimit-Remaining'); } catch (e) {}
        if (rem === '0') return 'GitHub API 호출 한도를 넘었습니다. 1시간 뒤 자동으로 풀립니다.';
        if (/Resource not accessible by integration/i.test(m)) return '이 토큰에 해당 저장소 접근 권한이 없습니다. 토큰 권한(Contents: Read and write)을 확인해 주세요.';
        return 'GitHub가 요청을 거부했습니다(403). 토큰 권한을 확인해 주세요. ' + m;
      }
      if (r && r.status === 404) return fallback || '저장소나 파일을 찾을 수 없습니다. 이름·권한을 확인해 주세요.';
      if (r && r.status === 409) return '다른 기기가 먼저 저장했습니다(충돌).';
      if (r && r.status === 422) return '저장 요청이 거부되었습니다(422). ' + m;
      return (fallback || 'GitHub 통신 오류') + ' (' + (r ? r.status : '?') + ')' + (m ? ': ' + m : '');
    }

    /* ---------------- payload ---------------- */
    function buildPayload(data, rev, savedAt) {
      return {
        app: APP_TAG,
        v: PAYLOAD_VERSION,
        rev: rev,
        savedAt: isoOrNull(savedAt) || new Date().toISOString(),
        deviceId: device.id,
        deviceName: device.name,
        data: data
      };
    }
    function parsePayload(text) {
      var obj = safeJson(text);
      if (!obj || typeof obj !== 'object') return null;
      // 봉투 없이 보드 데이터만 들어있는 파일도 허용(구버전 백업 형식)
      if (obj.app !== APP_TAG && obj.data === undefined) {
        if (Array.isArray(obj.cards) || Array.isArray(obj.columns)) {
          return { app: APP_TAG, v: 1, rev: obj._syncRev || 0, savedAt: isoOrNull(obj.savedAt) || null, deviceId: '', deviceName: '', data: obj };
        }
        return null;
      }
      if (!obj.data || typeof obj.data !== 'object') return null;
      var rev = typeof obj.rev === 'number' && obj.rev >= 0 ? obj.rev : (obj.data._syncRev || 0);
      return {
        app: APP_TAG,
        v: obj.v || 1,
        rev: rev,
        savedAt: isoOrNull(obj.savedAt) || null,
        deviceId: obj.deviceId || '',
        deviceName: obj.deviceName || '',
        data: obj.data
      };
    }

    /* ---------------- repo mode ---------------- */
    function repoPath() {
      return '/repos/' + encodeURIComponent(cfg.owner) + '/' + encodeURIComponent(cfg.repo)
        + '/contents/' + String(cfg.path).split('/').map(encodeURIComponent).join('/');
    }
    function repoGet(conditional) {
      var q = cfg.branch ? '?ref=' + encodeURIComponent(cfg.branch) : '';
      var h = {};
      if (conditional && state.etag) h['If-None-Match'] = state.etag;
      return req(repoPath() + q, { headers: h }).then(function (r) {
        if (r.status === 304) return { notModified: true };
        if (r.status === 404) { state.sha = null; return { missing: true }; }
        if (!r.ok) throw new Error(ghError(r));
        var j = r.json || {};
        state.sha = j.sha || null;
        try { state.etag = r.headers.get('ETag') || state.etag; } catch (e) {}
        var text = '';
        if (j.content && j.encoding === 'base64') text = b64decodeUtf8(j.content);
        return { text: text, sha: j.sha || null, size: j.size || 0 };
      });
    }
    function repoPut(text, sha, message) {
      var body = { message: message, content: b64encodeUtf8(text) };
      if (sha) body.sha = sha;
      if (cfg.branch) body.branch = cfg.branch;
      return req(repoPath(), { method: 'PUT', body: body }).then(function (r) {
        if (!r.ok) {
          var err = new Error(ghError(r));
          err.status = r.status;
          throw err;
        }
        if (r.json && r.json.content && r.json.content.sha) state.sha = r.json.content.sha;
        try { state.etag = r.headers.get('ETag') || null; } catch (e) {}
        return { sha: state.sha, commit: (r.json && r.json.commit && r.json.commit.sha) || null };
      });
    }

    /* ---------------- gist mode ---------------- */
    function gistGet(conditional) {
      if (!cfg.gistId) return Promise.resolve({ missing: true });
      var h = {};
      if (conditional && state.etag) h['If-None-Match'] = state.etag;
      return req('/gists/' + encodeURIComponent(cfg.gistId), { headers: h }).then(function (r) {
        if (r.status === 304) return { notModified: true };
        if (r.status === 404) return { missing: true };
        if (!r.ok) throw new Error(ghError(r, 'Gist를 찾을 수 없습니다. 토큰의 gist 권한을 확인해 주세요.'));
        var j = r.json || {};
        try { state.etag = r.headers.get('ETag') || state.etag; } catch (e) {}
        var f = (j.files || {})[GIST_FILE] || null;
        if (!f) return { missing: true };
        if (f.truncated) {
          var e = new Error('데이터가 1MB를 넘어 Gist 모드로는 읽을 수 없습니다. 비공개 저장소 모드를 사용해 주세요.');
          e.fatal = true;
          throw e;
        }
        return { text: f.content || '', size: f.size || 0 };
      });
    }
    function gistWrite(text, message) {
      var files = {};
      files[GIST_FILE] = { content: text };
      if (!cfg.gistId) {
        return req('/gists', {
          method: 'POST',
          body: {
            description: '원스텝 워크플로우 보드 자동 동기화 (' + message + ')',
            public: false,
            files: files
          }
        }).then(function (r) {
          if (!r.ok) throw new Error(ghError(r, 'Gist를 만들지 못했습니다. 토큰에 gist 권한이 있는지 확인해 주세요.'));
          cfg.gistId = r.json.id;
          persistCfg();
          return { gistId: cfg.gistId };
        });
      }
      return req('/gists/' + encodeURIComponent(cfg.gistId), {
        method: 'PATCH',
        body: { files: files, description: '원스텝 워크플로우 보드 자동 동기화 (' + message + ')' }
      }).then(function (r) {
        if (!r.ok) throw new Error(ghError(r, 'Gist 저장에 실패했습니다.'));
        return { gistId: cfg.gistId };
      });
    }

    /* ---------------- public API ---------------- */
    function getConfig() {
      var c = {};
      for (var k in cfg) c[k] = cfg[k];
      return c;
    }
    function persistCfg() {
      try { store.setItem(CFG_KEY, JSON.stringify(cfg)); } catch (e) {}
    }
    function configure(patch) {
      patch = patch || {};
      for (var k in patch) if (patch[k] !== undefined) cfg[k] = patch[k];
      cfg.mode = cfg.mode === 'repo' || cfg.mode === 'gist' ? cfg.mode : 'off';
      cfg.apiBase = String(cfg.apiBase || API_FALLBACK).replace(/\/+$/, '');
      if (cfg.path) cfg.path = String(cfg.path).replace(/^\/+/, '');
      persistCfg();
      state.sha = null; state.etag = null; state.remoteRev = null;
      return getConfig();
    }
    function isReady() {
      if (cfg.mode === 'off' || !cfg.token) return false;
      if (cfg.mode === 'repo') return !!(cfg.owner && cfg.repo && cfg.path);
      return true; // gist는 첫 저장 때 자동 생성
    }
    function forget() {
      cfg = loadCfg();
      cfg.mode = 'off'; cfg.token = '';
      persistCfg();
      state.sha = null; state.etag = null; state.remoteRev = null;
    }

    function test() {
      if (!cfg.token) return Promise.reject(new Error('토큰을 먼저 입력해 주세요.'));
      return req('/user').then(function (r) {
        if (!r.ok) throw new Error(ghError(r));
        var info = { ok: true, login: (r.json && r.json.login) || '', mode: cfg.mode };
        if (cfg.mode === 'repo') {
          return req('/repos/' + encodeURIComponent(cfg.owner) + '/' + encodeURIComponent(cfg.repo)).then(function (rr) {
            if (rr.status === 404) { info.repoFound = false; info.repoPrivate = null; }
            else if (!rr.ok) { info.repoFound = false; info.repoError = ghError(rr); }
            else {
              info.repoFound = true;
              info.repoPrivate = !!rr.json.private;
              try { info.canPush = !!(rr.json.permissions && rr.json.permissions.push); } catch (e) {}
            }
            return info;
          });
        }
        if (cfg.mode === 'gist' && cfg.gistId) {
          return gistGet(false).then(function (g) {
            info.gistFound = !g.missing && !g.notModified;
            return info;
          }).catch(function () { info.gistFound = false; return info; });
        }
        return info;
      });
    }

    /* --- pull: 원격 리비전이 이 기기 내용보다 앞서면 {action:'apply'} --- */
    function pull(opts2) {
      opts2 = opts2 || {};
      if (!isReady()) return Promise.resolve({ ok: false, action: 'none', reason: 'not-configured' });
      if (state.busy) return Promise.resolve({ ok: false, action: 'none', reason: 'busy' });
      state.busy = true;
      var getter = cfg.mode === 'repo' ? repoGet : gistGet;
      return getter(!opts2.force).then(function (g) {
        state.lastPullAt = new Date().toISOString();
        if (g.notModified) { state.lastError = null; return { ok: true, action: 'none', reason: 'not-modified' }; }
        if (g.missing) { state.lastError = null; state.remoteRev = null; return { ok: true, action: 'none', reason: 'remote-empty' }; }
        var payload = parsePayload(g.text);
        if (!payload) {
          state.lastError = '원격 파일 형식이 올바르지 않습니다.';
          return { ok: false, action: 'none', reason: 'bad-payload' };
        }
        var remoteRev = payload.rev || 0;
        var localRev = Number(opts2.localRev) || 0;
        state.remoteRev = remoteRev;
        state.lastError = null;
        if (opts2.force || remoteRev > localRev) {
          return {
            ok: true,
            action: 'apply',
            reason: opts2.force ? 'force' : (localRev ? 'remote-newer' : 'local-empty'),
            payload: payload,
            rev: remoteRev,
            savedAt: payload.savedAt,
            deviceName: payload.deviceName,
            sameDevice: !!(payload.deviceId && payload.deviceId === device.id)
          };
        }
        return { ok: true, action: 'none', reason: remoteRev === localRev ? 'same-rev' : 'local-newer', rev: remoteRev };
      }).catch(function (e) {
        state.lastError = e.message || String(e);
        return { ok: false, action: 'none', reason: 'error', error: state.lastError, fatal: !!e.fatal };
      }).then(function (out) {
        state.busy = false;
        return out;
      });
    }

    /* --- push: 이 기기 내용을 원격에 저장 (리비전 +1) --- */
    function push(data, opts3) {
      opts3 = opts3 || {};
      if (!isReady()) return Promise.resolve({ ok: false, reason: 'not-configured' });
      if (state.busy) return Promise.resolve({ ok: false, reason: 'busy' });
      state.busy = true;
      var message = '보드 동기화 ' + device.name + ' ' + new Date().toLocaleString('ko-KR');
      var attempt = 0;

      function makeRev(baseRev) {
        var rev = (Number(baseRev) || 0) + 1;
        return rev;
      }
      function textFor(rev) {
        var savedAt = isoOrNull(opts3.savedAt) || new Date().toISOString();
        return JSON.stringify(buildPayload(data, rev, savedAt), null, 1);
      }

      function doRepo() {
        attempt++;
        var needPre = !state.sha || state.remoteRev === null || attempt > 1 || opts3.force;
        var pre = needPre
          ? repoGet(false).then(function (g) {
              if (g.missing) return { missing: true, sha: null, payload: null };
              state.sha = g.sha;
              return { missing: false, sha: g.sha, payload: g.text ? parsePayload(g.text) : null };
            })
          : Promise.resolve({ missing: false, sha: state.sha, payload: null });

        return pre.then(function (info) {
          if (info.payload) state.remoteRev = info.payload.rev || 0;
          var baseRev = info.payload ? (info.payload.rev || 0) : (state.remoteRev || 0);
          var rev = makeRev(baseRev);
          if (info.payload && !opts3.force && (info.payload.rev || 0) > (Number(opts3.localRev) || 0) && (info.payload.deviceId || '') !== device.id) {
            // 서버가 이 기기가 아는 것보다 앞서 있음 → 덮어쓰지 않고 알려줌
            return { ok: false, reason: 'conflict', conflict: true, remoteRev: info.payload.rev, remoteDevice: info.payload.deviceName };
          }
          return repoPut(textFor(rev), info.sha || state.sha || null, message).then(function (out) {
            state.remoteRev = rev;
            return { ok: true, reason: 'pushed', rev: rev, sha: out.sha, mode: 'repo' };
          }).catch(function (e) {
            if ((e.status === 409 || e.status === 422) && attempt < 3) {
              state.sha = null; state.remoteRev = null;
              return doRepo();
            }
            throw e;
          });
        });
      }

      function doGist() {
        var pre = (cfg.gistId && (!opts3.force || state.remoteRev === null))
          ? gistGet(false).catch(function () { return {}; })
          : Promise.resolve({});
        return pre.then(function (g) {
          var rp = g && g.text ? parsePayload(g.text) : null;
          if (rp) state.remoteRev = rp.rev || 0;
          var rev = makeRev(rp ? rp.rev : (state.remoteRev || 0));
          if (rp && !opts3.force && (rp.rev || 0) > (Number(opts3.localRev) || 0) && (rp.deviceId || '') !== device.id) {
            return { ok: false, reason: 'conflict', conflict: true, remoteRev: rp.rev, remoteDevice: rp.deviceName };
          }
          return gistWrite(textFor(rev), message).then(function () {
            state.remoteRev = rev;
            return { ok: true, reason: 'pushed', rev: rev, gistId: cfg.gistId, mode: 'gist' };
          });
        });
      }

      return (cfg.mode === 'repo' ? doRepo() : doGist()).then(function (out) {
        if (out.ok) {
          state.lastError = null;
          state.lastPushAt = new Date().toISOString();
        } else if (out.conflict) {
          state.lastError = '다른 기기(' + (out.remoteDevice || '알 수 없음') + ')가 먼저 저장했습니다.';
        }
        return out;
      }).catch(function (e) {
        state.lastError = e.message || String(e);
        return { ok: false, reason: 'error', error: state.lastError };
      }).then(function (out) {
        state.busy = false;
        return out;
      });
    }

    function info() {
      return {
        configured: isReady(),
        mode: cfg.mode,
        target: cfg.mode === 'repo' ? (cfg.owner + '/' + cfg.repo + '/' + cfg.path + (cfg.branch ? '@' + cfg.branch : ''))
              : cfg.mode === 'gist' ? ('비밀 Gist ' + (cfg.gistId || '(첫 저장 때 자동 생성)')) : '—',
        device: device,
        remoteRev: state.remoteRev,
        lastPushAt: state.lastPushAt,
        lastPullAt: state.lastPullAt,
        lastError: state.lastError,
        serverOffsetMs: state.serverOffsetMs,
        busy: state.busy
      };
    }

    return {
      getConfig: getConfig,
      configure: configure,
      isReady: isReady,
      forget: forget,
      test: test,
      pull: pull,
      push: push,
      info: info,
      parsePayload: parsePayload,
      buildPayload: buildPayload,
      _state: state,
      _defaultRepo: DEFAULT_REPO,
      _gistFile: GIST_FILE
    };
  }

  return {
    create: createSync,
    APP_TAG: APP_TAG,
    b64encodeUtf8: b64encodeUtf8,
    b64decodeUtf8: b64decodeUtf8
  };
});
