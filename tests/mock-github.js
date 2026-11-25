/* Mock GitHub REST API (브라우저에서 그대로 실행) — sync.js 를 실제 GitHub 없이 검증
   지원: /user, /repos/{o}/{r}, /repos/{o}/{r}/contents/{path}(GET/PUT, ETag, sha 충돌),
        /gists (POST/GET/PATCH, 1MB truncate 흉내) */
(function (global) {
  'use strict';

  function utf8ToB64(str) {
    var bytes = new TextEncoder().encode(str), bin = '';
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }
  function b64ToUtf8(b64) {
    var bin = atob(b64), bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }
  function byteLen(str) { return new TextEncoder().encode(str).length; }

  function makeMockGitHub(opts) {
    opts = opts || {};
    var files = new Map();     // path -> {content, sha}
    var gists = new Map();     // id -> {files:{name:{content}}, etag}
    var shaN = 1, gistN = 0;
    var serverNow = opts.serverNow || Date.parse('2026-11-26T01:00:00Z');
    var calls = [];
    var truncateBytes = opts.gistTruncateBytes || null;

    function newSha() { return ('sha' + (shaN++)).padEnd(40, '0'); }
    function dateHdr() { return { 'Date': new Date(serverNow).toUTCString() }; }
    function json(obj, status, extra) {
      return new Response(JSON.stringify(obj), {
        status: status || 200,
        headers: Object.assign({ 'Content-Type': 'application/json' }, dateHdr(), extra || {})
      });
    }
    function mapGistFiles(g) {
      var out = {};
      Object.keys(g.files).forEach(function (name) {
        var size = byteLen(g.files[name].content || '');
        var truncated = truncateBytes ? size > truncateBytes : false;
        out[name] = {
          filename: name, size: size,
          content: truncated ? (g.files[name].content || '').slice(0, 50) : g.files[name].content,
          truncated: truncated
        };
      });
      return out;
    }

    function fetchMock(url, init) {
      init = init || {};
      var u = new URL(url, 'https://api.github.com');
      var method = (init.method || 'GET').toUpperCase();
      var h = init.headers || {};
      var auth = h['Authorization'] || h['authorization'];
      var p = u.pathname;
      calls.push({ method: method, path: p + u.search, hasAuth: !!auth });
      if (!auth || auth === 'Bearer wrong') return Promise.resolve(json({ message: 'Bad credentials' }, 401));

      if (p === '/user' && method === 'GET') return Promise.resolve(json({ login: 'smile697900' }));

      var m = p.match(/^\/repos\/([^/]+)\/([^/]+)$/);
      if (m && method === 'GET') {
        if (opts.repoMissing) return Promise.resolve(json({ message: 'Not Found' }, 404));
        return Promise.resolve(json({ private: opts.repoPrivate !== false, permissions: { push: true, admin: true } }));
      }

      m = p.match(/^\/repos\/([^/]+)\/([^/]+)\/contents\/(.+)$/);
      if (m && opts.repoMissing) return Promise.resolve(json({ message: 'Not Found' }, 404));
      if (m) {
        var path = decodeURIComponent(m[3]);
        var rec = files.get(path);
        if (method === 'GET') {
          if (!rec) return Promise.resolve(json({ message: 'Not Found' }, 404));
          var etag = '"' + rec.sha + '"';
          if (h['If-None-Match'] === etag) {
            return Promise.resolve(new Response(null, { status: 304, headers: Object.assign({ ETag: etag }, dateHdr()) }));
          }
          return Promise.resolve(json({
            name: path, path: path, sha: rec.sha, size: byteLen(rec.content),
            encoding: 'base64', content: utf8ToB64(rec.content)
          }, 200, { ETag: etag }));
        }
        if (method === 'PUT') {
          var body = JSON.parse(init.body);
          if (rec && body.sha !== rec.sha) return Promise.resolve(json({ message: 'sha does not match' }, 409));
          if (!rec && body.sha) return Promise.resolve(json({ message: 'sha does not match' }, 409));
          var content = b64ToUtf8(body.content);
          var sha = newSha();
          files.set(path, { content: content, sha: sha, message: body.message });
          return Promise.resolve(json({ content: { sha: sha }, commit: { sha: newSha() } }, rec ? 200 : 201));
        }
      }

      if (p === '/gists' && method === 'POST') {
        var b = JSON.parse(init.body);
        var id = 'gist' + (++gistN);
        var stored = {};
        Object.keys(b.files || {}).forEach(function (n) { stored[n] = { content: b.files[n].content }; });
        gists.set(id, { files: stored, etag: '"e' + id + '"', public: !!b.public });
        return Promise.resolve(json({ id: id, files: mapGistFiles(gists.get(id)) }, 201));
      }
      m = p.match(/^\/gists\/([^/]+)$/);
      if (m) {
        var g = gists.get(m[1]);
        if (!g) return Promise.resolve(json({ message: 'Not Found' }, 404));
        if (method === 'GET') {
          if (h['If-None-Match'] === g.etag) {
            return Promise.resolve(new Response(null, { status: 304, headers: Object.assign({ ETag: g.etag }, dateHdr()) }));
          }
          return Promise.resolve(json({ id: m[1], files: mapGistFiles(g) }, 200, { ETag: g.etag }));
        }
        if (method === 'PATCH') {
          var pb = JSON.parse(init.body);
          Object.keys(pb.files || {}).forEach(function (n) { g.files[n] = { content: pb.files[n].content }; });
          g.etag = '"e' + m[1] + '-' + (++shaN) + '"';
          return Promise.resolve(json({ id: m[1], files: mapGistFiles(g) }));
        }
      }
      return Promise.resolve(json({ message: 'Not Found' }, 404));
    }

    return {
      fetch: fetchMock,
      files: files,
      gists: gists,
      calls: calls,
      setServerTime: function (iso) { serverNow = Date.parse(iso); },
      rawFile: function (path) { return files.get(path); },
      truncateBytes: truncateBytes
    };
  }

  function memoryStorage(initial) {
    var m = new Map(Object.entries(initial || {}));
    return {
      getItem: function (k) { return m.has(k) ? m.get(k) : null; },
      setItem: function (k, v) { m.set(k, String(v)); },
      removeItem: function (k) { m.delete(k); },
      _dump: function () { var o = {}; m.forEach(function (v, k) { o[k] = v; }); return o; }
    };
  }

  global.makeMockGitHub = makeMockGitHub;
  global.memoryStorage = memoryStorage;
})(typeof self !== 'undefined' ? self : this);
