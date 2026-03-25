// api/index.js
// Vercel 서버리스 함수
// 환경변수 (Vercel 대시보드에서 설정):
//   GITHUB_TOKEN   : GitHub Personal Access Token
//   ADMIN_PASSWORD : 관리자 페이지 비밀번호
//   GITHUB_REPO    : redchupa/jeil-studyroom (데이터 저장 레포)

const REPO       = process.env.GITHUB_REPO    || 'redchupa/jeil-studyroom';
const TOKEN      = process.env.GITHUB_TOKEN;
const ADMIN_PASS = process.env.ADMIN_PASSWORD;

const GH_API = `https://api.github.com/repos/${REPO}/contents`;

// ── GitHub 파일 읽기 ─────────────────────────────────────
async function ghGet(path) {
  const res = await fetch(`${GH_API}/${path}`, {
    headers: {
      Authorization: `token ${TOKEN}`,
      Accept       : 'application/vnd.github.v3+json',
    },
  });
  if (!res.ok) throw new Error(`GitHub GET 실패: ${res.status}`);
  const json = await res.json();
  const content = Buffer.from(json.content.replace(/\n/g, ''), 'base64').toString('utf-8');
  return { data: JSON.parse(content), sha: json.sha };
}

// ── GitHub 파일 쓰기 ─────────────────────────────────────
async function ghPut(path, data, sha, message) {
  const content = Buffer.from(JSON.stringify(data, null, 2)).toString('base64');
  const body = { message, content };
  if (sha) body.sha = sha;
  const res = await fetch(`${GH_API}/${path}`, {
    method : 'PUT',
    headers: {
      Authorization : `token ${TOKEN}`,
      Accept        : 'application/vnd.github.v3+json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const e = await res.json();
    throw new Error(e.message || `GitHub PUT 실패: ${res.status}`);
  }
  const json = await res.json();
  return json.content.sha;
}

// ── 날짜/시간 유틸 ───────────────────────────────────────
function todayKST() {
  const now = new Date(Date.now() + 9 * 60 * 60 * 1000);
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  const d = String(now.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function timeKST() {
  const now = new Date(Date.now() + 9 * 60 * 60 * 1000);
  return `${String(now.getUTCHours()).padStart(2,'0')}:${String(now.getUTCMinutes()).padStart(2,'0')}`;
}

// ── 코드 생성 ────────────────────────────────────────────
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function genCode() {
  return Array.from({ length: 4 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join('');
}

function genExitCode() {
  return String(Math.floor(1000 + Math.random() * 9000));
}

// 8자리 정기권 코드 (혼동하기 쉬운 O, 0, I, 1 제외)
function genFixedCode() {
  return Array.from({ length: 8 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join('');
}

// ── 일일 초기화 ──────────────────────────────────────────
function resetIfNewDay(seats) {
  const today = todayKST();
  if (seats.date !== today) return { date: today, seats: [] };
  return seats;
}

// ── 분기 계산 (3/6/9/12월 1일 초기화) ───────────────────
// 분기: 3~5월 → "YYYY-03", 6~8월 → "YYYY-06", 9~11월 → "YYYY-09", 12~2월 → "YYYY-12"
function getCurrentPeriod() {
  const now   = new Date(Date.now() + 9 * 60 * 60 * 1000);
  const month = now.getUTCMonth() + 1; // 1~12
  const year  = now.getUTCFullYear();
  let pm, py  = year;
  if      (month >= 3 && month <= 5)  pm = 3;
  else if (month >= 6 && month <= 8)  pm = 6;
  else if (month >= 9 && month <= 11) pm = 9;
  else { pm = 12; if (month <= 2) py = year - 1; } // 1~2월은 전년도 12월 분기
  return `${py}-${String(pm).padStart(2, '0')}`;
}

function resetIfNewPeriod(data) {
  const period = getCurrentPeriod();
  if (data.period !== period) return { period, seats: [] };
  return data;
}

// ════════════════════════════════════════════════════════
//  브루트포스 방어 (입장코드 / 퇴실코드 / 관리자 로그인 공용)
// ════════════════════════════════════════════════════════
const MAX_ATTEMPTS = 5;
const LOCK_MS      = 1 * 60 * 1000;

async function getAttempts() {
  try { return await ghGet('attempts.json'); }
  catch (_) { return { data: {}, sha: null }; }
}

async function checkLock(ip) {
  const { data, sha } = await getAttempts();
  const now   = Date.now();
  const entry = data[ip];
  if (entry?.lockedUntil && now < entry.lockedUntil) {
    const remaining = Math.ceil((entry.lockedUntil - now) / 60000);
    return { locked: true, remaining, data, sha };
  }
  if (entry?.lockedUntil && now >= entry.lockedUntil) {
    delete data[ip];
    try { await ghPut('attempts.json', data, sha, `unlock ${ip}`); } catch(_) {}
  }
  return { locked: false, data, sha };
}

async function recordFail(ip, data, sha) {
  if (!data[ip]) data[ip] = { count: 0, lockedUntil: null };
  data[ip].count += 1;
  if (data[ip].count >= MAX_ATTEMPTS) {
    data[ip].lockedUntil = Date.now() + LOCK_MS;
    data[ip].count       = 0;
  }
  try { await ghPut('attempts.json', data, sha, `fail ${ip}`); } catch(_) {}
}

async function clearFail(ip, data, sha) {
  if (data[ip]) {
    delete data[ip];
    try { await ghPut('attempts.json', data, sha, `login ok ${ip}`); } catch(_) {}
  }
}

// ════════════════════════════════════════════════════════
//  Vercel 핸들러
// ════════════════════════════════════════════════════════
export default async function handler(req, res) {

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const ok  = (d)        => res.status(200).json(d);
  const err = (m, c=400) => res.status(c).json({ error: m });

  if (!TOKEN) return err('서버 환경변수(GITHUB_TOKEN)가 설정되지 않았습니다.', 500);

  const action = req.query.action;
  let body = {};
  try {
    if (typeof req.body === 'string') body = JSON.parse(req.body);
    else if (req.body) body = req.body;
  } catch (_) {}

  // ── IP 추출 헬퍼 ─────────────────────────────────────
  const getIP = () =>
    (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
    || req.headers['x-real-ip']
    || 'unknown';

  try {

    // ════════════════════════════════════════════════════
    //  1회권 — 공개 액션
    // ════════════════════════════════════════════════════

    // 1-1. 좌석 현황 조회 (이용자용 — exitCode·memo 미포함)
    if (action === 'getSeats') {
      const { data, sha } = await ghGet('seats.json');
      const fresh = resetIfNewDay(data);
      if (fresh.date !== data.date) await ghPut('seats.json', fresh, sha, `auto-reset ${fresh.date}`);
      return ok({ ...fresh, seats: fresh.seats.map(({ name, time }) => ({ name, time })) });
    }

    // 1-2. 좌석 현황 조회 (관리자용 — memo 포함)
    if (action === 'adminGetSeats') {
      if (body.adminPassword !== ADMIN_PASS) return err('관리자 인증 실패', 401);
      const { data, sha } = await ghGet('seats.json');
      const fresh = resetIfNewDay(data);
      if (fresh.date !== data.date) await ghPut('seats.json', fresh, sha, `auto-reset ${fresh.date}`);
      return ok({ ...fresh, seats: fresh.seats.map(({ name, time, memo }) => ({ name, time, memo: memo || '' })) });
    }

    // 1-3. 명부 등록
    if (action === 'register') {
      const { name, code } = body;
      if (!name || !code) return err('이름과 코드를 모두 입력하세요.');
      const { data: codeData, sha: codeSha } = await ghGet('codes.json');
      const codeEntry = codeData.codes.find(c => c.code === code.toUpperCase());
      if (!codeEntry) return err('유효하지 않은 코드입니다. 관리사무소에서 발급받은 코드를 입력하세요.');
      const { data: seatData, sha: seatSha } = await ghGet('seats.json');
      const fresh = resetIfNewDay(seatData);
      if (fresh.seats.length >= 5) return err('오늘 정원(5명)이 마감되었습니다.');
      const exitCode = genExitCode();
      fresh.seats.push({ name, time: timeKST(), exitCode, memo: codeEntry.memo || '' });
      await ghPut('seats.json', fresh, seatSha, `register ${name} ${fresh.date}`);
      codeData.codes = codeData.codes.filter(c => c.code !== code.toUpperCase());
      await ghPut('codes.json', codeData, codeSha, `use code ${code}`);
      return ok({ success: true, exitCode, seats: { ...fresh, seats: fresh.seats.map(({ name, time }) => ({ name, time })) } });
    }

    // 1-4. 명부 삭제 (퇴실)
    if (action === 'deleteEntry') {
      const { name, time, exitCode } = body;
      if (!name || !time || !exitCode) return err('삭제 정보가 부족합니다.');
      const { data, sha } = await ghGet('seats.json');
      const target = data.seats.find(s => s.name === name && s.time === time);
      if (!target) return err('해당 항목을 찾을 수 없습니다.');
      if (target.exitCode !== exitCode) return err('퇴실코드가 일치하지 않습니다.');
      data.seats = data.seats.filter(s => !(s.name === name && s.time === time));
      await ghPut('seats.json', data, sha, `exit ${name} ${data.date}`);
      return ok({ success: true, seats: { ...data, seats: data.seats.map(({ name, time }) => ({ name, time })) } });
    }

    // 1-5. 관리자 로그인 (브루트포스 방어)
    if (action === 'adminLogin') {
      if (!ADMIN_PASS) return err('서버에 ADMIN_PASSWORD가 설정되지 않았습니다.', 500);
      const ip = getIP();
      const { locked, remaining, data: attData, sha: attSha } = await checkLock(ip);
      if (locked) return err(`로그인 시도가 너무 많습니다. ${remaining}분 후에 다시 시도해 주세요.`, 429);
      if (body.password !== ADMIN_PASS) {
        await recordFail(ip, attData, attSha);
        const count = attData[ip]?.count || 0;
        const left  = MAX_ATTEMPTS - count;
        if (left <= 0) return err(`비밀번호 ${MAX_ATTEMPTS}회 오류. ${LOCK_MS/60000}분간 잠금됩니다.`, 401);
        return err(`비밀번호가 틀렸습니다. (${left}회 남음)`, 401);
      }
      await clearFail(ip, attData, attSha);
      return ok({ success: true });
    }

    // ════════════════════════════════════════════════════
    //  정기권(분기) — 공개 액션
    // ════════════════════════════════════════════════════

    // 2-1. 정기 좌석 현황 조회 (이용자용 — memo 미포함)
    if (action === 'getFixedSeats') {
      const { data, sha } = await ghGet('fixed_seats.json');
      const fresh = resetIfNewPeriod(data);
      if (fresh.period !== data.period) await ghPut('fixed_seats.json', fresh, sha, `auto-reset ${fresh.period}`);
      return ok({ ...fresh, seats: fresh.seats.map(({ name, time }) => ({ name, time })) });
    }

    // 2-2. 정기 좌석 등록 (8자리 코드 + 브루트포스 방어)
    if (action === 'registerFixed') {
      const { name, code } = body;
      if (!name || !code) return err('이름과 코드를 모두 입력하세요.');

      const ip = getIP();
      const { locked, remaining, data: attData, sha: attSha } = await checkLock(ip);
      if (locked) return err(`시도 횟수 초과. ${remaining}분 후 다시 시도해 주세요.`, 429);

      const cleanCode = code.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
      if (cleanCode.length !== 8) return err('코드는 8자리입니다. 관리사무소에서 발급받은 코드를 확인하세요.');

      const { data: codeData, sha: codeSha } = await ghGet('fixed_codes.json');
      const codeEntry = codeData.codes.find(c => c.code === cleanCode);
      if (!codeEntry) {
        await recordFail(ip, attData, attSha);
        return err('유효하지 않은 코드입니다. 관리사무소에서 발급받은 코드를 입력하세요.');
      }

      const { data: seatData, sha: seatSha } = await ghGet('fixed_seats.json');
      const fresh = resetIfNewPeriod(seatData);
      if (fresh.seats.length >= 29) return err('이번 분기 정원(29명)이 마감되었습니다.');

      await clearFail(ip, attData, attSha);
      fresh.seats.push({ name, time: todayKST() + ' ' + timeKST(), memo: codeEntry.memo || '' });
      await ghPut('fixed_seats.json', fresh, seatSha, `fixed register ${name} ${fresh.period}`);

      codeData.codes = codeData.codes.filter(c => c.code !== cleanCode);
      await ghPut('fixed_codes.json', codeData, codeSha, `use fixed code ${cleanCode}`);

      return ok({ success: true, seats: { ...fresh, seats: fresh.seats.map(({ name, time }) => ({ name, time })) } });
    }

    // ════════════════════════════════════════════════════
    //  이하 관리자 인증 필요
    // ════════════════════════════════════════════════════
    const { adminPassword } = body;
    if (adminPassword !== ADMIN_PASS) return err('관리자 인증 실패', 401);

    // ── 1회권 관리자 액션 ─────────────────────────────────

    // 코드 목록 조회
    if (action === 'getCodes') {
      const { data } = await ghGet('codes.json');
      return ok(data);
    }

    // 코드 생성
    if (action === 'createCode') {
      const { memo } = body;
      const { data, sha } = await ghGet('codes.json');
      let code;
      const existing = data.codes.map(c => c.code);
      for (let i = 0; i < 10; i++) { code = genCode(); if (!existing.includes(code)) break; }
      data.codes.push({ code, memo: memo || '', created: todayKST() + ' ' + timeKST() });
      await ghPut('codes.json', data, sha, `create code ${code}`);
      return ok({ success: true, code, codes: data });
    }

    // 코드 삭제
    if (action === 'deleteCode') {
      const { code } = body;
      if (!code) return err('삭제할 코드를 지정하세요.');
      const { data, sha } = await ghGet('codes.json');
      data.codes = data.codes.filter(c => c.code !== code);
      await ghPut('codes.json', data, sha, `delete code ${code}`);
      return ok({ success: true, codes: data });
    }

    // 좌석 강제 초기화
    if (action === 'resetSeats') {
      const { data, sha } = await ghGet('seats.json');
      const reset = { date: todayKST(), seats: [] };
      await ghPut('seats.json', reset, sha, `admin reset ${reset.date}`);
      return ok({ success: true });
    }

    // 강제 퇴실
    if (action === 'adminDeleteEntry') {
      const { name, time } = body;
      if (!name || !time) return err('삭제 정보가 부족합니다.');
      const { data, sha } = await ghGet('seats.json');
      const before = data.seats.length;
      data.seats = data.seats.filter(s => !(s.name === name && s.time === time));
      if (data.seats.length === before) return err('해당 항목을 찾을 수 없습니다.');
      await ghPut('seats.json', data, sha, `admin exit ${name} ${data.date}`);
      return ok({ success: true, seats: data });
    }

    // ── 정기권 관리자 액션 ────────────────────────────────

    // 정기 좌석 현황 조회 (관리자용 — memo 포함)
    if (action === 'adminGetFixedSeats') {
      const { data, sha } = await ghGet('fixed_seats.json');
      const fresh = resetIfNewPeriod(data);
      if (fresh.period !== data.period) await ghPut('fixed_seats.json', fresh, sha, `auto-reset ${fresh.period}`);
      return ok({ ...fresh, seats: fresh.seats.map(({ name, time, memo }) => ({ name, time, memo: memo || '' })) });
    }

    // 정기 좌석 삭제 (관리자 강제)
    if (action === 'adminDeleteFixed') {
      const { name, time } = body;
      if (!name || !time) return err('삭제 정보가 부족합니다.');
      const { data, sha } = await ghGet('fixed_seats.json');
      const before = data.seats.length;
      data.seats = data.seats.filter(s => !(s.name === name && s.time === time));
      if (data.seats.length === before) return err('해당 항목을 찾을 수 없습니다.');
      await ghPut('fixed_seats.json', data, sha, `admin delete fixed ${name}`);
      return ok({ success: true, seats: data });
    }

    // 정기 좌석 전체 초기화
    if (action === 'resetFixedSeats') {
      const { data, sha } = await ghGet('fixed_seats.json');
      const reset = { period: getCurrentPeriod(), seats: [] };
      await ghPut('fixed_seats.json', reset, sha, `admin reset fixed ${reset.period}`);
      return ok({ success: true });
    }

    // 정기 코드 목록 조회
    if (action === 'getFixedCodes') {
      const { data } = await ghGet('fixed_codes.json');
      return ok(data);
    }

    // 정기 코드 생성 (8자리)
    if (action === 'createFixedCode') {
      const { memo } = body;
      const { data, sha } = await ghGet('fixed_codes.json');
      let code;
      const existing = data.codes.map(c => c.code);
      for (let i = 0; i < 20; i++) { code = genFixedCode(); if (!existing.includes(code)) break; }
      data.codes.push({ code, memo: memo || '', created: todayKST() + ' ' + timeKST() });
      await ghPut('fixed_codes.json', data, sha, `create fixed code ${code}`);
      return ok({ success: true, code, codes: data });
    }

    // 정기 코드 삭제
    if (action === 'deleteFixedCode') {
      const { code } = body;
      if (!code) return err('삭제할 코드를 지정하세요.');
      const { data, sha } = await ghGet('fixed_codes.json');
      data.codes = data.codes.filter(c => c.code !== code);
      await ghPut('fixed_codes.json', data, sha, `delete fixed code ${code}`);
      return ok({ success: true, codes: data });
    }

    return err('알 수 없는 action입니다.');

  } catch (e) {
    console.error(e);
    return err(e.message || '서버 오류', 500);
  }
}
