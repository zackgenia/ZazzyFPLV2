const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// Cache
const cache = new Map();
const CACHE_TTL = 300000;

function getCache(key) {
  const item = cache.get(key);
  if (!item || Date.now() > item.expiry) return null;
  return item.value;
}
function setCache(key, value) {
  cache.set(key, { value, expiry: Date.now() + CACHE_TTL });
}

// FPL API
async function fetchFPL(endpoint) {
  const cached = getCache(endpoint);
  if (cached) return cached;
  
  const res = await fetch('https://fantasy.premierleague.com/api' + endpoint, {
    headers: { 'User-Agent': 'Mozilla/5.0' }
  });
  if (!res.ok) throw new Error('FPL API error: ' + res.status);
  const data = await res.json();
  setCache(endpoint, data);
  return data;
}

let teamsById = new Map();
let teamStats = new Map();
let fixturesData = [];

async function loadData() {
  if (getCache('loaded')) return;
  
  const bootstrap = await fetchFPL('/bootstrap-static/');
  const fixtures = await fetchFPL('/fixtures/');
  
  teamsById = new Map(bootstrap.teams.map(t => [t.id, t]));
  fixturesData = fixtures;
  
  const finished = fixtures.filter(f => f.finished).sort((a, b) => (b.event || 0) - (a.event || 0));
  
  for (const team of bootstrap.teams) {
    const teamGames = finished.filter(f => f.team_h === team.id || f.team_a === team.id).slice(0, 10);
    let cs = 0, scored = 0, conceded = 0, form = 0;
    
    teamGames.forEach((f, i) => {
      const isHome = f.team_h === team.id;
      const gf = isHome ? f.team_h_score : f.team_a_score;
      const ga = isHome ? f.team_a_score : f.team_h_score;
      if (ga === 0) cs++;
      scored += gf || 0;
      conceded += ga || 0;
      const pts = gf > ga ? 3 : gf === ga ? 1 : 0;
      if (i < 5) form += pts * (5 - i);
    });
    
    teamStats.set(team.id, {
      csRate: teamGames.length ? cs / teamGames.length : 0,
      goalsPerGame: teamGames.length ? scored / teamGames.length : 0,
      concededPerGame: teamGames.length ? conceded / teamGames.length : 0,
      momentum: form / 45,
    });
  }
  
  setCache('loaded', true);
}

function getBadge(team) {
  return team && team.code ? 'https://resources.premierleague.com/premierleague/badges/50/t' + team.code + '.png' : '';
}

function getCSProb(teamId, oppId) {
  const team = teamStats.get(teamId);
  const opp = teamStats.get(oppId);
  if (!team || !opp) return 25;
  let prob = team.csRate * 100;
  if (opp.goalsPerGame > 2) prob *= 0.6;
  else if (opp.goalsPerGame > 1.5) prob *= 0.75;
  else if (opp.goalsPerGame < 0.8) prob *= 1.2;
  return Math.round(Math.max(5, Math.min(55, prob)));
}

// API Routes
app.get('/api/bootstrap', async (req, res) => {
  try {
    const data = await fetchFPL('/bootstrap-static/');
    await loadData();
    const currentGW = data.events.find(e => e.is_current);
    
    res.json({
      players: data.elements.map(p => ({
        id: p.id, webName: p.web_name, teamId: p.team, position: p.element_type,
        cost: p.now_cost, form: p.form, totalPoints: p.total_points, status: p.status,
        news: p.news, chanceOfPlaying: p.chance_of_playing_next_round, photoCode: p.code,
        goals: p.goals_scored, assists: p.assists, cleanSheets: p.clean_sheets,
      })),
      teams: data.teams.map(t => ({ id: t.id, name: t.name, shortName: t.short_name, badge: getBadge(t) })),
      currentGameweek: currentGW ? currentGW.id : 1,
    });
  } catch (e) {
    console.error(e);
    res.status(503).json({ error: 'FPL API unavailable' });
  }
});

app.get('/api/fixtures', async (req, res) => {
  try {
    const weeks = parseInt(req.query.weeks) || 6;
    await loadData();
    const bootstrap = await fetchFPL('/bootstrap-static/');
    const currentGW = bootstrap.events.find(e => e.is_current);
    const gwId = currentGW ? currentGW.id : 1;
    
    const teams = Array.from(teamsById.values()).map(t => ({
      id: t.id, name: t.name, shortName: t.short_name, badge: getBadge(t),
      stats: teamStats.get(t.id) || {},
      topPlayers: bootstrap.elements
        .filter(p => p.team === t.id && p.status === 'a')
        .sort((a, b) => b.total_points - a.total_points)
        .slice(0, 3)
        .map(p => ({ name: p.web_name, points: p.total_points, pos: ['', 'GK', 'DEF', 'MID', 'FWD'][p.element_type] })),
    }));
    
    const fixtures = [];
    for (const f of fixturesData) {
      if (!f.event || f.event < gwId || f.event >= gwId + weeks) continue;
      const home = teamsById.get(f.team_h);
      const away = teamsById.get(f.team_a);
      fixtures.push({ teamId: f.team_h, gw: f.event, opp: away ? away.short_name : '?', oppBadge: getBadge(away), isHome: true, fdr: f.team_h_difficulty, cs: getCSProb(f.team_h, f.team_a) });
      fixtures.push({ teamId: f.team_a, gw: f.event, opp: home ? home.short_name : '?', oppBadge: getBadge(home), isHome: false, fdr: f.team_a_difficulty, cs: getCSProb(f.team_a, f.team_h) });
    }
    
    res.json({ teams: teams, fixtures: fixtures, currentGW: gwId });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed' });
  }
});

// Frontend HTML
app.get('/', function(req, res) {
  var html = '<!DOCTYPE html>\n' +
'<html lang="en">\n' +
'<head>\n' +
'<meta charset="UTF-8">\n' +
'<meta name="viewport" content="width=device-width, initial-scale=1.0">\n' +
'<title>FPL Transfer Recommender</title>\n' +
'<script src="https://cdn.tailwindcss.com"></script>\n' +
'<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">\n' +
'<style>\n' +
'* { font-family: Inter, sans-serif; }\n' +
'.fdr-1 { background: #10b981; color: white; }\n' +
'.fdr-2 { background: #34d399; color: white; }\n' +
'.fdr-3 { background: #fbbf24; color: #1f2937; }\n' +
'.fdr-4 { background: #f97316; color: white; }\n' +
'.fdr-5 { background: #ef4444; color: white; }\n' +
'.hover-card { position: fixed; z-index: 50; background: white; border-radius: 12px; box-shadow: 0 25px 50px -12px rgba(0,0,0,0.25); padding: 16px; min-width: 280px; pointer-events: none; }\n' +
'</style>\n' +
'</head>\n' +
'<body class="bg-gray-50 min-h-screen">\n' +
'<div id="app"></div>\n' +
'<script>\n' +
'var app = document.getElementById("app");\n' +
'var currentTab = "fixtures";\n' +
'var bootstrap = null;\n' +
'var fixtureData = null;\n' +
'var squad = [];\n' +
'var bank = 1000;\n' +
'var hoverTeam = null;\n' +
'var hoverPos = { x: 0, y: 0 };\n' +
'\n' +
'async function loadBootstrap() {\n' +
'  var res = await fetch("/api/bootstrap");\n' +
'  bootstrap = await res.json();\n' +
'  render();\n' +
'}\n' +
'\n' +
'async function loadFixtures() {\n' +
'  var res = await fetch("/api/fixtures?weeks=6");\n' +
'  fixtureData = await res.json();\n' +
'  render();\n' +
'}\n' +
'\n' +
'function render() {\n' +
'  var h = "";\n' +
'  h += \'<header class="bg-gradient-to-r from-emerald-700 to-emerald-900 text-white py-4 px-6 shadow-lg">\';\n' +
'  h += \'<div class="max-w-7xl mx-auto flex items-center justify-between">\';\n' +
'  h += \'<div><h1 class="text-2xl font-bold">⚽ FPL Transfer Recommender</h1>\';\n' +
'  h += \'<p class="text-emerald-200 text-sm">GW \' + (bootstrap ? bootstrap.currentGameweek : "-") + \'</p></div>\';\n' +
'  h += \'<nav class="flex gap-2">\';\n' +
'  h += \'<button onclick="setTab(\\\'squad\\\')" class="px-4 py-2 rounded-lg \' + (currentTab === "squad" ? "bg-white text-emerald-800" : "text-white hover:bg-white/10") + \'">Squad</button>\';\n' +
'  h += \'<button onclick="setTab(\\\'fixtures\\\')" class="px-4 py-2 rounded-lg \' + (currentTab === "fixtures" ? "bg-white text-emerald-800" : "text-white hover:bg-white/10") + \'">Fixtures</button>\';\n' +
'  h += \'</nav></div></header>\';\n' +
'  h += \'<main class="max-w-7xl mx-auto p-6">\';\n' +
'  if (currentTab === "fixtures") { h += renderFixtures(); }\n' +
'  else { h += renderSquad(); }\n' +
'  h += \'</main>\';\n' +
'  h += renderHoverCard();\n' +
'  app.innerHTML = h;\n' +
'}\n' +
'\n' +
'function setTab(tab) {\n' +
'  currentTab = tab;\n' +
'  if (tab === "fixtures" && !fixtureData) loadFixtures();\n' +
'  else render();\n' +
'}\n' +
'\n' +
'function renderFixtures() {\n' +
'  if (!fixtureData) return \'<div class="text-center py-12"><div class="animate-spin w-8 h-8 border-4 border-emerald-500 border-t-transparent rounded-full mx-auto"></div><p class="mt-4 text-gray-500">Loading fixtures...</p></div>\';\n' +
'  var teams = fixtureData.teams;\n' +
'  var fixtures = fixtureData.fixtures;\n' +
'  var gwSet = {};\n' +
'  fixtures.forEach(function(f) { gwSet[f.gw] = true; });\n' +
'  var gws = Object.keys(gwSet).map(Number).sort(function(a,b) { return a-b; });\n' +
'  var sorted = teams.map(function(t) {\n' +
'    var tf = fixtures.filter(function(f) { return f.teamId === t.id; });\n' +
'    var avg = tf.length ? tf.reduce(function(s, f) { return s + f.fdr; }, 0) / tf.length : 3;\n' +
'    return { id: t.id, name: t.name, shortName: t.shortName, badge: t.badge, stats: t.stats, topPlayers: t.topPlayers, avgFdr: avg };\n' +
'  }).sort(function(a, b) { return a.avgFdr - b.avgFdr; });\n' +
'  var h = \'<div class="bg-white rounded-xl shadow-sm border overflow-hidden">\';\n' +
'  h += \'<div class="p-4 border-b bg-gray-50"><h2 class="text-lg font-bold text-gray-800">Fixture Difficulty Tracker</h2>\';\n' +
'  h += \'<p class="text-sm text-gray-500">Hover over teams to see key players</p></div>\';\n' +
'  h += \'<div class="overflow-x-auto"><table class="w-full"><thead><tr class="bg-gray-100">\';\n' +
'  h += \'<th class="text-left py-3 px-4 font-semibold text-gray-700 sticky left-0 bg-gray-100 min-w-[180px]">Team</th>\';\n' +
'  h += \'<th class="text-center py-3 px-3 font-semibold text-gray-700 w-20">Avg</th>\';\n' +
'  gws.forEach(function(gw) { h += \'<th class="text-center py-3 px-2 font-semibold text-gray-700 w-16">GW\' + gw + \'</th>\'; });\n' +
'  h += \'</tr></thead><tbody>\';\n' +
'  sorted.forEach(function(team, idx) {\n' +
'    var tf = fixtures.filter(function(f) { return f.teamId === team.id; });\n' +
'    var rowClass = idx < 5 ? "bg-emerald-50/50" : (idx >= sorted.length - 5 ? "bg-red-50/50" : "");\n' +
'    h += \'<tr class="border-t hover:bg-gray-50 \' + rowClass + \'" onmouseenter="showHover(\' + team.id + \', event)" onmousemove="moveHover(event)" onmouseleave="hideHover()">\';\n' +
'    h += \'<td class="py-3 px-4 sticky left-0 bg-white border-r"><div class="flex items-center gap-3">\';\n' +
'    h += \'<img src="\' + team.badge + \'" class="w-8 h-8" onerror="this.style.display=\\\'none\\\'">\';\n' +
'    h += \'<div><p class="font-semibold text-gray-800">\' + team.name + \'</p>\';\n' +
'    h += \'<p class="text-xs text-gray-500">\' + Math.round((team.stats.momentum || 0.5) * 100) + \'% form</p></div></div></td>\';\n' +
'    var avgColor = team.avgFdr <= 2.5 ? "text-emerald-600" : (team.avgFdr >= 3.5 ? "text-red-600" : "text-gray-700");\n' +
'    h += \'<td class="py-3 px-3 text-center"><span class="text-lg font-bold \' + avgColor + \'">\' + team.avgFdr.toFixed(2) + \'</span></td>\';\n' +
'    gws.forEach(function(gw) {\n' +
'      var fix = tf.find(function(f) { return f.gw === gw; });\n' +
'      if (!fix) { h += \'<td class="py-3 px-2 text-center">-</td>\'; return; }\n' +
'      h += \'<td class="py-3 px-2 text-center"><div class="fdr-\' + fix.fdr + \' rounded-lg p-1.5 text-center mx-auto w-14" title="CS: \' + fix.cs + \'%">\';\n' +
'      h += \'<p class="font-bold text-sm">\' + fix.opp + \'</p><p class="text-xs opacity-80">\' + (fix.isHome ? "H" : "A") + \'</p></div></td>\';\n' +
'    });\n' +
'    h += \'</tr>\';\n' +
'  });\n' +
'  h += \'</tbody></table></div></div>\';\n' +
'  h += \'<div class="mt-4 flex gap-3 flex-wrap">\';\n' +
'  var labels = ["Very Easy", "Easy", "Medium", "Hard", "Very Hard"];\n' +
'  [1,2,3,4,5].forEach(function(d) {\n' +
'    h += \'<div class="flex items-center gap-2"><div class="fdr-\' + d + \' w-8 h-8 rounded flex items-center justify-center font-bold">\' + d + \'</div><span class="text-sm text-gray-600">\' + labels[d-1] + \'</span></div>\';\n' +
'  });\n' +
'  h += \'</div>\';\n' +
'  return h;\n' +
'}\n' +
'\n' +
'function renderSquad() {\n' +
'  if (!bootstrap) return \'<div class="text-center py-12">Loading...</div>\';\n' +
'  var posMap = { 1: "GK", 2: "DEF", 3: "MID", 4: "FWD" };\n' +
'  var teamMap = {};\n' +
'  bootstrap.teams.forEach(function(t) { teamMap[t.id] = t; });\n' +
'  var searchVal = "";\n' +
'  var searchEl = document.getElementById("search");\n' +
'  if (searchEl) searchVal = searchEl.value.toLowerCase();\n' +
'  var filtered = bootstrap.players.filter(function(p) {\n' +
'    var team = teamMap[p.teamId];\n' +
'    return p.webName.toLowerCase().indexOf(searchVal) >= 0 || (team && team.name.toLowerCase().indexOf(searchVal) >= 0);\n' +
'  }).sort(function(a,b) { return b.totalPoints - a.totalPoints; }).slice(0, 30);\n' +
'  var h = \'<div class="grid lg:grid-cols-2 gap-6">\';\n' +
'  h += \'<div class="bg-white rounded-xl shadow-sm border p-6"><h3 class="font-bold text-gray-800 mb-4">Search Players</h3>\';\n' +
'  h += \'<input type="text" id="search" placeholder="Search..." class="w-full px-4 py-2 border rounded-lg mb-4" oninput="render()" value="\' + searchVal + \'">\';\n' +
'  h += \'<div class="max-h-96 overflow-y-auto space-y-2">\';\n' +
'  filtered.forEach(function(p) {\n' +
'    var team = teamMap[p.teamId];\n' +
'    var inSquad = squad.some(function(s) { return s.id === p.id; });\n' +
'    var cls = inSquad ? "bg-gray-100 opacity-50" : "hover:border-emerald-300 cursor-pointer";\n' +
'    var onclick = inSquad ? "" : "addPlayer(" + p.id + ")";\n' +
'    h += \'<div class="flex items-center justify-between p-3 rounded-lg border \' + cls + \'" onclick="\' + onclick + \'">\';\n' +
'    h += \'<div class="flex items-center gap-3"><span class="text-xs font-medium px-2 py-1 rounded bg-emerald-100 text-emerald-700">\' + posMap[p.position] + \'</span>\';\n' +
'    h += \'<div><p class="font-medium text-gray-800">\' + p.webName + \'</p><p class="text-sm text-gray-500">\' + (team ? team.shortName : "") + \'</p></div></div>\';\n' +
'    h += \'<div class="text-right"><p class="font-medium">\' + (p.cost / 10).toFixed(1) + \'m</p><p class="text-sm text-gray-500">\' + p.totalPoints + \' pts</p></div></div>\';\n' +
'  });\n' +
'  h += \'</div></div>\';\n' +
'  h += \'<div class="bg-white rounded-xl shadow-sm border p-6">\';\n' +
'  h += \'<div class="flex justify-between items-center mb-4"><h3 class="font-bold text-gray-800">Your Squad (\' + squad.length + \'/15)</h3>\';\n' +
'  h += \'<p class="text-emerald-600 font-bold">Bank: \' + (bank / 10).toFixed(1) + \'m</p></div>\';\n' +
'  if (squad.length === 0) { h += \'<p class="text-gray-400 text-center py-8">Click players to add</p>\'; }\n' +
'  else {\n' +
'    h += \'<div class="space-y-2">\';\n' +
'    squad.forEach(function(p) {\n' +
'      var team = teamMap[p.teamId];\n' +
'      h += \'<div class="flex items-center justify-between p-2 bg-gray-50 rounded-lg">\';\n' +
'      h += \'<span>\' + p.webName + \' <span class="text-gray-400">(\' + (team ? team.shortName : "") + \')</span></span>\';\n' +
'      h += \'<button onclick="removePlayer(\' + p.id + \')" class="text-red-500 hover:text-red-700">x</button></div>\';\n' +
'    });\n' +
'    h += \'</div>\';\n' +
'  }\n' +
'  h += \'</div></div>\';\n' +
'  return h;\n' +
'}\n' +
'\n' +
'function renderHoverCard() {\n' +
'  if (!hoverTeam || !fixtureData) return "";\n' +
'  var team = fixtureData.teams.find(function(t) { return t.id === hoverTeam; });\n' +
'  if (!team) return "";\n' +
'  var top = Math.min(hoverPos.y, window.innerHeight - 300);\n' +
'  var left = Math.min(hoverPos.x + 20, window.innerWidth - 320);\n' +
'  var h = \'<div class="hover-card" style="top:\' + top + \'px;left:\' + left + \'px">\';\n' +
'  h += \'<div class="flex items-center gap-3 mb-3"><img src="\' + team.badge + \'" class="w-10 h-10">\';\n' +
'  h += \'<div><p class="font-bold text-gray-800">\' + team.name + \'</p>\';\n' +
'  h += \'<p class="text-sm text-gray-500">\' + Math.round((team.stats.momentum || 0.5) * 100) + \'% momentum</p></div></div>\';\n' +
'  h += \'<div class="grid grid-cols-3 gap-2 mb-3">\';\n' +
'  h += \'<div class="bg-gray-50 rounded p-2 text-center"><p class="font-bold text-gray-800">\' + Math.round((team.stats.csRate || 0) * 100) + \'%</p><p class="text-xs text-gray-500">CS Rate</p></div>\';\n' +
'  h += \'<div class="bg-gray-50 rounded p-2 text-center"><p class="font-bold text-gray-800">\' + (team.stats.goalsPerGame || 0).toFixed(1) + \'</p><p class="text-xs text-gray-500">Goals/G</p></div>\';\n' +
'  h += \'<div class="bg-gray-50 rounded p-2 text-center"><p class="font-bold text-gray-800">\' + (team.stats.concededPerGame || 0).toFixed(1) + \'</p><p class="text-xs text-gray-500">Conc/G</p></div></div>\';\n' +
'  h += \'<p class="text-xs font-semibold text-gray-500 mb-2">TOP PLAYERS</p>\';\n' +
'  if (team.topPlayers) {\n' +
'    team.topPlayers.forEach(function(p) {\n' +
'      h += \'<div class="flex justify-between text-sm py-1"><span>\' + p.name + \' <span class="text-gray-400">(\' + p.pos + \')</span></span><span class="font-medium">\' + p.points + \' pts</span></div>\';\n' +
'    });\n' +
'  }\n' +
'  h += \'</div>\';\n' +
'  return h;\n' +
'}\n' +
'\n' +
'function showHover(teamId, e) { hoverTeam = teamId; hoverPos = { x: e.clientX, y: e.clientY }; render(); }\n' +
'function moveHover(e) { hoverPos = { x: e.clientX, y: e.clientY }; render(); }\n' +
'function hideHover() { hoverTeam = null; render(); }\n' +
'\n' +
'function addPlayer(id) {\n' +
'  var p = bootstrap.players.find(function(x) { return x.id === id; });\n' +
'  if (!p || squad.length >= 15 || p.cost > bank) return;\n' +
'  squad.push(p);\n' +
'  bank -= p.cost;\n' +
'  render();\n' +
'}\n' +
'\n' +
'function removePlayer(id) {\n' +
'  var idx = squad.findIndex(function(p) { return p.id === id; });\n' +
'  if (idx >= 0) {\n' +
'    bank += squad[idx].cost;\n' +
'    squad.splice(idx, 1);\n' +
'    render();\n' +
'  }\n' +
'}\n' +
'\n' +
'loadBootstrap();\n' +
'loadFixtures();\n' +
'</script>\n' +
'</body>\n' +
'</html>';
  res.send(html);
});

app.listen(PORT, function() {
  console.log('FPL Recommender running on port ' + PORT);
});
