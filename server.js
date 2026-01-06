const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// ===================
// CACHE
// ===================
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

// ===================
// FPL API
// ===================
async function fetchFPL(endpoint) {
  const cached = getCache(endpoint);
  if (cached) return cached;
  
  const res = await fetch(`https://fantasy.premierleague.com/api${endpoint}`, {
    headers: { 'User-Agent': 'Mozilla/5.0' }
  });
  if (!res.ok) throw new Error(`FPL API error: ${res.status}`);
  const data = await res.json();
  setCache(endpoint, data);
  return data;
}

// Data stores
let teamsById = new Map();
let teamStats = new Map();
let fixturesData = [];

async function loadData() {
  if (getCache('loaded')) return;
  
  const bootstrap = await fetchFPL('/bootstrap-static/');
  const fixtures = await fetchFPL('/fixtures/');
  
  teamsById = new Map(bootstrap.teams.map(t => [t.id, t]));
  fixturesData = fixtures;
  
  // Calculate team stats
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
  return team?.code ? `https://resources.premierleague.com/premierleague/badges/50/t${team.code}.png` : '';
}

function getCSProb(teamId, oppId, isHome) {
  const team = teamStats.get(teamId);
  const opp = teamStats.get(oppId);
  if (!team || !opp) return 25;
  let prob = team.csRate * 100;
  if (opp.goalsPerGame > 2) prob *= 0.6;
  else if (opp.goalsPerGame > 1.5) prob *= 0.75;
  else if (opp.goalsPerGame < 0.8) prob *= 1.2;
  return Math.round(Math.max(5, Math.min(55, prob)));
}

// ===================
// API ROUTES
// ===================
app.get('/api/bootstrap', async (req, res) => {
  try {
    const data = await fetchFPL('/bootstrap-static/');
    await loadData();
    const currentGW = data.events.find(e => e.is_current)?.id || 1;
    
    res.json({
      players: data.elements.map(p => ({
        id: p.id, webName: p.web_name, teamId: p.team, position: p.element_type,
        cost: p.now_cost, form: p.form, totalPoints: p.total_points, status: p.status,
        news: p.news, chanceOfPlaying: p.chance_of_playing_next_round, photoCode: p.code,
        goals: p.goals_scored, assists: p.assists, cleanSheets: p.clean_sheets,
        xG: p.expected_goals, xA: p.expected_assists,
      })),
      teams: data.teams.map(t => ({ id: t.id, name: t.name, shortName: t.short_name, badge: getBadge(t) })),
      currentGameweek: currentGW,
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
    const currentGW = bootstrap.events.find(e => e.is_current)?.id || 1;
    
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
      if (!f.event || f.event < currentGW || f.event >= currentGW + weeks) continue;
      const home = teamsById.get(f.team_h);
      const away = teamsById.get(f.team_a);
      fixtures.push({ teamId: f.team_h, gw: f.event, opp: away?.short_name, oppBadge: getBadge(away), isHome: true, fdr: f.team_h_difficulty, cs: getCSProb(f.team_h, f.team_a, true) });
      fixtures.push({ teamId: f.team_a, gw: f.event, opp: home?.short_name, oppBadge: getBadge(home), isHome: false, fdr: f.team_a_difficulty, cs: getCSProb(f.team_a, f.team_h, false) });
    }
    
    res.json({ teams, fixtures, currentGW });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed' });
  }
});

// ===================
// FRONTEND (embedded)
// ===================
const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>FPL Transfer Recommender</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    * { font-family: 'Inter', sans-serif; }
    .fdr-1 { background: #10b981; color: white; }
    .fdr-2 { background: #34d399; color: white; }
    .fdr-3 { background: #fbbf24; color: #1f2937; }
    .fdr-4 { background: #f97316; color: white; }
    .fdr-5 { background: #ef4444; color: white; }
    .hover-card { position: fixed; z-index: 50; background: white; border-radius: 12px; box-shadow: 0 25px 50px -12px rgba(0,0,0,0.25); padding: 16px; min-width: 280px; pointer-events: none; }
  </style>
</head>
<body class="bg-gray-50 min-h-screen">
  <div id="app"></div>
  <script>
    const app = document.getElementById('app');
    let currentTab = 'fixtures';
    let bootstrap = null;
    let fixtureData = null;
    let squad = [];
    let bank = 1000;
    let hoverTeam = null;
    let hoverPos = { x: 0, y: 0 };

    async function loadBootstrap() {
      const res = await fetch('/api/bootstrap');
      bootstrap = await res.json();
      render();
    }

    async function loadFixtures() {
      const res = await fetch('/api/fixtures?weeks=6');
      fixtureData = await res.json();
      render();
    }

    function render() {
      app.innerHTML = \`
        <header class="bg-gradient-to-r from-emerald-700 to-emerald-900 text-white py-4 px-6 shadow-lg">
          <div class="max-w-7xl mx-auto flex items-center justify-between">
            <div>
              <h1 class="text-2xl font-bold">⚽ FPL Transfer Recommender</h1>
              <p class="text-emerald-200 text-sm">GW \${bootstrap?.currentGameweek || '-'}</p>
            </div>
            <nav class="flex gap-2">
              <button onclick="setTab('squad')" class="px-4 py-2 rounded-lg \${currentTab === 'squad' ? 'bg-white text-emerald-800' : 'text-white hover:bg-white/10'}">Squad</button>
              <button onclick="setTab('fixtures')" class="px-4 py-2 rounded-lg \${currentTab === 'fixtures' ? 'bg-white text-emerald-800' : 'text-white hover:bg-white/10'}">Fixtures</button>
            </nav>
          </div>
        </header>
        <main class="max-w-7xl mx-auto p-6">
          \${currentTab === 'fixtures' ? renderFixtures() : renderSquad()}
        </main>
        \${renderHoverCard()}
      \`;
    }

    function setTab(tab) {
      currentTab = tab;
      if (tab === 'fixtures' && !fixtureData) loadFixtures();
      else render();
    }

    function renderFixtures() {
      if (!fixtureData) return '<div class="text-center py-12"><div class="animate-spin w-8 h-8 border-4 border-emerald-500 border-t-transparent rounded-full mx-auto"></div><p class="mt-4 text-gray-500">Loading fixtures...</p></div>';
      
      const { teams, fixtures, currentGW } = fixtureData;
      const gws = [...new Set(fixtures.map(f => f.gw))].sort((a, b) => a - b);
      
      // Sort by avg FDR
      const sorted = teams.map(t => {
        const tf = fixtures.filter(f => f.teamId === t.id);
        const avg = tf.length ? tf.reduce((s, f) => s + f.fdr, 0) / tf.length : 3;
        return { ...t, avgFdr: avg };
      }).sort((a, b) => a.avgFdr - b.avgFdr);

      return \`
        <div class="bg-white rounded-xl shadow-sm border overflow-hidden">
          <div class="p-4 border-b bg-gray-50">
            <h2 class="text-lg font-bold text-gray-800">Fixture Difficulty Tracker</h2>
            <p class="text-sm text-gray-500">Hover over teams to see key players</p>
          </div>
          <div class="overflow-x-auto">
            <table class="w-full">
              <thead>
                <tr class="bg-gray-100">
                  <th class="text-left py-3 px-4 font-semibold text-gray-700 sticky left-0 bg-gray-100 min-w-[180px]">Team</th>
                  <th class="text-center py-3 px-3 font-semibold text-gray-700 w-20">Avg</th>
                  \${gws.map(gw => \`<th class="text-center py-3 px-2 font-semibold text-gray-700 w-16">GW\${gw}</th>\`).join('')}
                </tr>
              </thead>
              <tbody>
                \${sorted.map((team, idx) => {
                  const tf = fixtures.filter(f => f.teamId === team.id);
                  return \`
                    <tr class="border-t hover:bg-gray-50 \${idx < 5 ? 'bg-emerald-50/50' : idx >= sorted.length - 5 ? 'bg-red-50/50' : ''}"
                        onmouseenter="showHover(\${team.id}, event)" 
                        onmousemove="moveHover(event)" 
                        onmouseleave="hideHover()">
                      <td class="py-3 px-4 sticky left-0 bg-white border-r">
                        <div class="flex items-center gap-3">
                          <img src="\${team.badge}" class="w-8 h-8" onerror="this.style.display='none'">
                          <div>
                            <p class="font-semibold text-gray-800">\${team.name}</p>
                            <p class="text-xs text-gray-500">\${Math.round((team.stats.momentum || 0.5) * 100)}% form</p>
                          </div>
                        </div>
                      </td>
                      <td class="py-3 px-3 text-center">
                        <span class="text-lg font-bold \${team.avgFdr <= 2.5 ? 'text-emerald-600' : team.avgFdr >= 3.5 ? 'text-red-600' : 'text-gray-700'}">\${team.avgFdr.toFixed(2)}</span>
                      </td>
                      \${gws.map(gw => {
                        const fix = tf.find(f => f.gw === gw);
                        if (!fix) return '<td class="py-3 px-2 text-center">-</td>';
                        return \`<td class="py-3 px-2 text-center">
                          <div class="fdr-\${fix.fdr} rounded-lg p-1.5 text-center mx-auto w-14" title="CS: \${fix.cs}%">
                            <p class="font-bold text-sm">\${fix.opp}</p>
                            <p class="text-xs opacity-80">\${fix.isHome ? 'H' : 'A'}</p>
                          </div>
                        </td>\`;
                      }).join('')}
                    </tr>
                  \`;
                }).join('')}
              </tbody>
            </table>
          </div>
        </div>
        <div class="mt-4 flex gap-3 flex-wrap">
          \${[1,2,3,4,5].map(d => \`<div class="flex items-center gap-2"><div class="fdr-\${d} w-8 h-8 rounded flex items-center justify-center font-bold">\${d}</div><span class="text-sm text-gray-600">\${['Very Easy','Easy','Medium','Hard','Very Hard'][d-1]}</span></div>\`).join('')}
        </div>
      \`;
    }

    function renderSquad() {
      if (!bootstrap) return '<div class="text-center py-12">Loading...</div>';
      
      const posMap = { 1: 'GK', 2: 'DEF', 3: 'MID', 4: 'FWD' };
      const teamMap = new Map(bootstrap.teams.map(t => [t.id, t]));
      
      return \`
        <div class="grid lg:grid-cols-2 gap-6">
          <div class="bg-white rounded-xl shadow-sm border p-6">
            <h3 class="font-bold text-gray-800 mb-4">Search Players</h3>
            <input type="text" id="search" placeholder="Search..." class="w-full px-4 py-2 border rounded-lg mb-4" oninput="render()">
            <div class="max-h-96 overflow-y-auto space-y-2">
              \${bootstrap.players
                .filter(p => {
                  const s = document.getElementById('search')?.value?.toLowerCase() || '';
                  return p.webName.toLowerCase().includes(s) || teamMap.get(p.teamId)?.name.toLowerCase().includes(s);
                })
                .sort((a, b) => b.totalPoints - a.totalPoints)
                .slice(0, 30)
                .map(p => {
                  const team = teamMap.get(p.teamId);
                  const inSquad = squad.some(s => s.id === p.id);
                  return \`
                    <div class="flex items-center justify-between p-3 rounded-lg border \${inSquad ? 'bg-gray-100 opacity-50' : 'hover:border-emerald-300 cursor-pointer'}" onclick="\${inSquad ? '' : \`addPlayer(\${p.id})\`}">
                      <div class="flex items-center gap-3">
                        <span class="text-xs font-medium px-2 py-1 rounded bg-emerald-100 text-emerald-700">\${posMap[p.position]}</span>
                        <div>
                          <p class="font-medium text-gray-800">\${p.webName}</p>
                          <p class="text-sm text-gray-500">\${team?.shortName || ''}</p>
                        </div>
                      </div>
                      <div class="text-right">
                        <p class="font-medium">£\${(p.cost / 10).toFixed(1)}m</p>
                        <p class="text-sm text-gray-500">\${p.totalPoints} pts</p>
                      </div>
                    </div>
                  \`;
                }).join('')}
            </div>
          </div>
          <div class="bg-white rounded-xl shadow-sm border p-6">
            <div class="flex justify-between items-center mb-4">
              <h3 class="font-bold text-gray-800">Your Squad (\${squad.length}/15)</h3>
              <p class="text-emerald-600 font-bold">Bank: £\${(bank / 10).toFixed(1)}m</p>
            </div>
            \${squad.length === 0 ? '<p class="text-gray-400 text-center py-8">Click players to add</p>' : \`
              <div class="space-y-2">
                \${squad.map(p => {
                  const team = teamMap.get(p.teamId);
                  return \`
                    <div class="flex items-center justify-between p-2 bg-gray-50 rounded-lg">
                      <span>\${p.webName} <span class="text-gray-400">(\${team?.shortName})</span></span>
                      <button onclick="removePlayer(\${p.id})" class="text-red-500 hover:text-red-700">✕</button>
                    </div>
                  \`;
                }).join('')}
              </div>
            \`}
          </div>
        </div>
      \`;
    }

    function renderHoverCard() {
      if (!hoverTeam || !fixtureData) return '';
      const team = fixtureData.teams.find(t => t.id === hoverTeam);
      if (!team) return '';
      
      return \`
        <div class="hover-card" style="top: \${Math.min(hoverPos.y, window.innerHeight - 300)}px; left: \${Math.min(hoverPos.x + 20, window.innerWidth - 320)}px">
          <div class="flex items-center gap-3 mb-3">
            <img src="\${team.badge}" class="w-10 h-10">
            <div>
              <p class="font-bold text-gray-800">\${team.name}</p>
              <p class="text-sm text-gray-500">\${Math.round((team.stats.momentum || 0.5) * 100)}% momentum</p>
            </div>
          </div>
          <div class="grid grid-cols-3 gap-2 mb-3">
            <div class="bg-gray-50 rounded p-2 text-center">
              <p class="font-bold text-gray-800">\${Math.round((team.stats.csRate || 0) * 100)}%</p>
              <p class="text-xs text-gray-500">CS Rate</p>
            </div>
            <div class="bg-gray-50 rounded p-2 text-center">
              <p class="font-bold text-gray-800">\${(team.stats.goalsPerGame || 0).toFixed(1)}</p>
              <p class="text-xs text-gray-500">Goals/G</p>
            </div>
            <div class="bg-gray-50 rounded p-2 text-center">
              <p class="font-bold text-gray-800">\${(team.stats.concededPerGame || 0).toFixed(1)}</p>
              <p class="text-xs text-gray-500">Conc/G</p>
            </div>
          </div>
          <p class="text-xs font-semibold text-gray-500 mb-2">⭐ TOP PLAYERS</p>
          \${team.topPlayers?.map(p => \`<div class="flex justify-between text-sm py-1"><span>\${p.name} <span class="text-gray-400">(\${p.pos})</span></span><span class="font-medium">\${p.points} pts</span></div>\`).join('') || ''}
        </div>
      \`;
    }

    function showHover(teamId, e) { hoverTeam = teamId; hoverPos = { x: e.clientX, y: e.clientY }; render(); }
    function moveHover(e) { hoverPos = { x: e.clientX, y: e.clientY }; render(); }
    function hideHover() { hoverTeam = null; render(); }

    function addPlayer(id) {
      const p = bootstrap.players.find(x => x.id === id);
      if (!p || squad.length >= 15 || p.cost > bank) return;
      squad.push(p);
      bank -= p.cost;
      render();
    }

    function removePlayer(id) {
      const idx = squad.findIndex(p => p.id === id);
      if (idx >= 0) {
        bank += squad[idx].cost;
        squad.splice(idx, 1);
        render();
      }
    }

    // Init
    loadBootstrap();
    loadFixtures();
  </script>
</body>
</html>`;

app.get('/', (req, res) => res.send(HTML));

app.listen(PORT, () => console.log(\`🚀 FPL Recommender running on http://localhost:\${PORT}\`));
