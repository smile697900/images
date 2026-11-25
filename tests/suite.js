/* 동기화 엔진 자동 테스트 — 두 기기(A=PC, B=폰)가 같은 GitHub 저장소로 주고받는 상황을 재현
   브라우저(run.html)에서도, Node(tests/node-run.mjs)에서도 실행됩니다. */
(function (global) {
  'use strict';
  var pass = 0, fail = 0, lines = [];

  function log(s) { lines.push(s); if (global.console && !global.__QUIET_TEST__) console.log(s); }
  function ok(cond, name, detail) {
    if (cond) { pass++; log('  ✅ ' + name); }
    else { fail++; log('  ❌ ' + name + (detail !== undefined ? '  → ' + JSON.stringify(detail) : '')); }
  }
  function eq(a, b, name) { ok(JSON.stringify(a) === JSON.stringify(b), name, { got: a, want: b }); }
  function board(cards, savedAt, rev) {
    return { columns: [{ id: 'col-1', title: '접수' }], cards: cards, archive: [], savedAt: savedAt, _syncRev: rev || 0, company: { name: '원스텝서울', account: '123-456-789' } };
  }
  function makeDevice(gh, tag, cfgOverride) {
    var storage = memoryStorage();
    var sync = OnestepSync.create({ storage: storage, fetch: gh.fetch });
    sync.configure(Object.assign({
      mode: 'repo', token: 'tok_' + tag, owner: 'smile697900', repo: 'onestep-workflow-data',
      path: 'board.json', branch: '', apiBase: 'https://api.github.com'
    }, cfgOverride || {}));
    return { tag: tag, storage: storage, sync: sync, rev: 0 };
  }
  // 기기 어댑터처럼 localRev를 들고 다니며 주고받기
  async function push(dev, b) { var r = await dev.sync.push(b, { savedAt: b.savedAt, localRev: dev.rev }); if (r.ok) dev.rev = r.rev; return r; }
  async function pull(dev, force) { var r = await dev.sync.pull({ localRev: dev.rev, force: !!force }); if (r.action === 'apply') dev.rev = r.rev; return r; }

  async function run() {
    var gh = makeMockGitHub();
    var A = makeDevice(gh, 'A');   // PC
    var B = makeDevice(gh, 'B');   // 폰

    log('[1] 토큰/저장소 확인');
    var info = await A.sync.test();
    ok(info.ok && info.login === 'smile697900', '토큰 사용자 확인');
    ok(info.repoFound === true && info.repoPrivate === true, '비공개 저장소 접근 확인');
    var bad = OnestepSync.create({ storage: memoryStorage(), fetch: gh.fetch });
    bad.configure({ mode: 'repo', token: 'wrong', owner: 'a', repo: 'b', path: 'board.json' });
    var errMsg = '';
    try { await bad.test(); } catch (e) { errMsg = e.message; }
    ok(/토큰이 올바르지/.test(errMsg), '잘못된 토큰은 한국어 오류로 안내', errMsg);

    log('[2] PC → 폰 : 처음 올리기 / 처음 받기');
    var p1 = await push(A, board([{ id: 'c1', clientName: '김철수', quote: 2390000 }], '2026-11-26T01:00:10.000Z'));
    ok(p1.ok && p1.reason === 'pushed' && p1.rev === 1, 'PC가 board.json 생성·업로드(rev 1)', p1);
    ok(!!gh.rawFile('board.json'), '저장소에 board.json 실제 생성됨');
    var stored = JSON.parse(gh.rawFile('board.json').content);
    ok(stored.app === 'onestep-workflow-board' && stored.v === 1, '파일에 앱 식별자/버전 기록', stored.app);
    eq(stored.data.cards[0].clientName, '김철수', '한글 고객명 그대로 저장(base64 왕복)');
    var b1 = await pull(B);
    ok(b1.action === 'apply' && b1.reason === 'local-empty', '빈 폰이 기록을 내려받음', b1.reason);
    eq(b1.payload.data.cards[0].quote, 2390000, '폰이 받은 견적 금액 일치');
    eq(b1.payload.data.company.account, '123-456-789', '계좌번호도 함께 동기화');
    ok(!!b1.deviceName, '어느 기기가 올렸는지 표시', b1.deviceName);

    log('[3] 폰 → PC : 반대 방향');
    var p2 = await push(B, board([{ id: 'c1', clientName: '김철수', quote: 2390000 }, { id: 'c2', clientName: '이영희', quote: 1200000 }], '2026-11-26T02:00:00.000Z'));
    ok(p2.ok && p2.rev === 2, '폰이 수정 내용을 업로드(rev 2)', p2);
    var b2 = await pull(A);
    ok(b2.action === 'apply' && b2.reason === 'remote-newer', 'PC가 폰의 최신 내용을 받음', b2.reason);
    eq(b2.payload.data.cards.length, 2, '카드 2건 반영');

    log('[4] 불필요한 재다운로드 방지(같은 리비전은 다시 받지 않음)');
    var b3 = await pull(A);
    ok(b3.action === 'none' && (b3.reason === 'same-rev' || b3.reason === 'not-modified'), '같은 기록은 다시 받지 않음(내용 변경 없음)', b3.reason);
    var before = gh.calls.filter(function (c) { return c.method === 'GET' && /contents/.test(c.path); }).length;
    await pull(A);
    var after = gh.calls.filter(function (c) { return c.method === 'GET' && /contents/.test(c.path); }).length;
    ok(after - before === 1, '확인 1회당 요청 1회', after - before);

    log('[5] 두 기기가 동시에 수정 → 덮어쓰기 방지(충돌 감지)');
    await push(B, board([{ id: 'b1', clientName: 'B최신' }], '2026-11-26T03:00:00.000Z'));
    var conflict = await push(A, board([{ id: 'a1', clientName: 'A옛날' }], '2026-11-26T02:30:00.000Z'));
    ok(conflict.ok === false && conflict.conflict === true, '뒤처진 기기가 최신 기록을 덮어쓰지 않음', conflict);
    eq(JSON.parse(gh.rawFile('board.json').content).data.cards[0].clientName, 'B최신', '서버 내용은 최신(B) 그대로 유지');
    var forced = await A.sync.push(board([{ id: 'a2', clientName: 'A강제' }], '2026-11-26T03:10:00.000Z'), { savedAt: '2026-11-26T03:10:00.000Z', localRev: A.rev, force: true });
    ok(forced.ok, '사용자가 [지금 올리기]를 누르면 강제 반영', forced);
    eq(JSON.parse(gh.rawFile('board.json').content).data.cards[0].clientName, 'A강제', '강제 반영 확인');
    A.rev = forced.rev;

    log('[6] 기기 시계가 크게 어긋나도 최신 판단이 맞음(리비전 기준)');
    var gh6 = makeMockGitHub();
    var D = makeDevice(gh6, 'D'), E = makeDevice(gh6, 'E');
    await push(D, board([{ id: 'd1', clientName: '시계빠름' }], '2030-01-01T00:00:00.000Z'));   // D 시계가 4년 앞
    await pull(E);
    var p6 = await push(D, board([{ id: 'd2', clientName: '시계느림' }], '2020-01-01T00:00:00.000Z')); // 같은 기기지만 시계가 뒤로
    ok(p6.ok && p6.rev === 2, '시계가 2020년으로 가도 rev 2로 기록', p6);
    var e6 = await pull(E);
    ok(e6.action === 'apply' && e6.payload.data.cards[0].clientName === '시계느림', 'savedAt이 더 과거여도 최신이면 반영', { action: e6.action, savedAt: e6.savedAt });
    ok(E.sync.info().serverOffsetMs !== 0, '서버 시각 차이는 참고값으로만 측정', Math.round(E.sync.info().serverOffsetMs / 1000) + 's');

    log('[7] Gist(비밀) 모드');
    var G1 = OnestepSync.create({ storage: memoryStorage(), fetch: gh.fetch });
    G1.configure({ mode: 'gist', token: 'tok_g' });
    var g1 = await G1.push(board([{ id: 'g1', clientName: 'Gist고객' }], '2026-11-26T04:00:00.000Z'), { savedAt: '2026-11-26T04:00:00.000Z', localRev: 0 });
    ok(g1.ok && g1.gistId, '첫 저장 때 비밀 Gist 자동 생성', g1);
    var G2 = OnestepSync.create({ storage: memoryStorage(), fetch: gh.fetch });
    G2.configure({ mode: 'gist', token: 'tok_g', gistId: g1.gistId });
    var g2 = await G2.pull({ localRev: 0, force: false });
    ok(g2.action === 'apply' && g2.payload.data.cards[0].clientName === 'Gist고객', '다른 기기가 Gist 기록을 받음', g2.reason);

    log('[8] 1MB 초과 데이터(Gist 한계)는 명확히 거부');
    var ghBig = makeMockGitHub({ gistTruncateBytes: 100 });
    var s1 = OnestepSync.create({ storage: memoryStorage(), fetch: ghBig.fetch });
    s1.configure({ mode: 'gist', token: 'tok' });
    var pBig = await s1.push(board([{ id: 'x', notes: new Array(400).join('x') }], '2026-11-26T05:00:00.000Z'), { savedAt: '2026-11-26T05:00:00.000Z', localRev: 0 });
    var s2 = OnestepSync.create({ storage: memoryStorage(), fetch: ghBig.fetch });
    s2.configure({ mode: 'gist', token: 'tok', gistId: pBig.gistId });
    var gotBig = await s2.pull({ localRev: 0, force: false });
    ok(gotBig.ok === false && /1MB/.test(gotBig.error || ''), '큰 데이터는 저장소 모드를 안내', gotBig.error);

    log('[9] 저장소/권한 오류 안내');
    var ghMiss = makeMockGitHub({ repoMissing: true });
    var s3 = OnestepSync.create({ storage: memoryStorage(), fetch: ghMiss.fetch });
    s3.configure({ mode: 'repo', token: 'tok', owner: 'u', repo: 'nope', path: 'board.json' });
    var t3 = await s3.test();
    ok(t3.repoFound === false, '없는 저장소를 정확히 알려줌');
    var pr3 = await s3.push(board([{ id: 'z' }], '2026-11-26T06:00:00.000Z'), { savedAt: '2026-11-26T06:00:00.000Z', localRev: 0 });
    ok(pr3.ok === false && /찾을 수 없습니다/.test(pr3.error || ''), '업로드 실패 사유를 한국어로 안내', pr3.error);

    log('[10] 설정 저장/복원, 연결 해제');
    var st = memoryStorage();
    var s4 = OnestepSync.create({ storage: st, fetch: gh.fetch });
    s4.configure({ mode: 'repo', token: 'secret_token', owner: 'o', repo: 'r', path: 'board.json' });
    var re = OnestepSync.create({ storage: st, fetch: gh.fetch });
    eq(re.getConfig().token, 'secret_token', '새로 열어도 설정이 기기에 남아 있음');
    re.forget();
    ok(re.isReady() === false && re.getConfig().token === '', '연결 해제 시 토큰 삭제');

    log('[11] 원격 파일이 봉투 없이 보드 데이터만 있어도 읽기');
    gh.files.set('plain.json', {
      content: JSON.stringify({ columns: [{ id: 'c', title: 't' }], cards: [{ id: 'p1' }], archive: [], savedAt: '2026-11-26T07:00:00.000Z' }),
      sha: 'plain000000000000000000000000000000000001'
    });
    var s5 = OnestepSync.create({ storage: memoryStorage(), fetch: gh.fetch });
    s5.configure({ mode: 'repo', token: 'tok', owner: 'o', repo: 'r', path: 'plain.json' });
    var out11 = await s5.pull({ localRev: 0, force: true });
    ok(out11.action === 'apply' && out11.payload.data.cards.length === 1, '구버전 백업 형식도 호환', out11.reason);

    log('[12] 큰 보드(사진 포함 3MB)도 왕복 손실 없이 전송');
    var bigCards = [];
    for (var i = 0; i < 30; i++) bigCards.push({ id: 'big' + i, clientName: '고객' + i, images: ['data:image/jpeg;base64,' + new Array(70000).join('A')] });
    var gh2 = makeMockGitHub();
    var F = makeDevice(gh2, 'F'), H = makeDevice(gh2, 'H');
    var pBig2 = await push(F, board(bigCards, '2026-11-26T08:00:00.000Z'));
    ok(pBig2.ok, '3MB급 보드 업로드', pBig2.reason || pBig2.error);
    var pullH = await pull(H);
    ok(pullH.action === 'apply' && pullH.payload.data.cards.length === 30, '폰이 30건 모두 수신', pullH.action);
    ok(pullH.payload.data.cards[29].images[0].length > 60000, '사진 데이터 손실 없음', pullH.payload.data.cards[29].images[0].length);

    var out = lines.join('\n');
    var box = document.getElementById('result');
    if (box) box.textContent = out + '\n\n──────────────────────────────\n통과 ' + pass + ' · 실패 ' + fail;
    var summary = document.getElementById('summary');
    if (summary) {
      summary.textContent = fail === 0 ? ('✅ 전체 통과 ' + pass + '건') : ('❌ 실패 ' + fail + '건 / 통과 ' + pass + '건');
      summary.style.color = fail === 0 ? '#22c55e' : '#ef4444';
    }
    global.__TEST_RESULT__ = { pass: pass, fail: fail, lines: lines };
    return global.__TEST_RESULT__;
  }

  global.runSyncTests = run;
})(typeof self !== 'undefined' ? self : this);
