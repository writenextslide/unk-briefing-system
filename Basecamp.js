// ============================================================
// BASECAMP — OAuth setup and activity fetch
// ============================================================

function doGet(e) {
  const code = e && e.parameter && e.parameter.code;

  if (!code) {
    return HtmlService.createHtmlOutput(
      '<h3>No authorisation code received.</h3><p>Please run setupBasecampOAuth() again.</p>'
    );
  }

  try {
    exchangeBasecampCode(code);
    return HtmlService.createHtmlOutput(
      '<h3 style="font-family:sans-serif;color:green">✅ Basecamp connected successfully!</h3>' +
      '<p style="font-family:sans-serif">You can close this tab and return to Google Apps Script.</p>'
    );
  } catch (err) {
    return HtmlService.createHtmlOutput(
      '<h3 style="font-family:sans-serif;color:red">❌ Error: ' + err.toString() + '</h3>'
    );
  }
}

function exchangeBasecampCode(code) {
  const props        = PropertiesService.getScriptProperties();
  const clientId     = props.getProperty('BASECAMP_CLIENT_ID');
  const clientSecret = props.getProperty('BASECAMP_CLIENT_SECRET');
  const redirectUri  = props.getProperty('BASECAMP_REDIRECT_URI');

  const response = UrlFetchApp.fetch('https://launchpad.37signals.com/authorization/token', {
    method: 'POST',
    muteHttpExceptions: true,
    payload: {
      type:          'web_server',
      client_id:     clientId,
      client_secret: clientSecret,
      redirect_uri:  redirectUri,
      code:          code,
    },
  });

  if (response.getResponseCode() !== 200) {
    throw new Error('Token exchange failed (' + response.getResponseCode() + '): ' + response.getContentText());
  }

  const data = JSON.parse(response.getContentText());
  if (!data.access_token) throw new Error('No access token in response: ' + response.getContentText());

  props.setProperty('BASECAMP_ACCESS_TOKEN',  data.access_token);
  props.setProperty('BASECAMP_REFRESH_TOKEN', data.refresh_token || '');
  Logger.log('✅ Basecamp tokens saved successfully.');
}

function refreshBasecampToken() {
  const props        = PropertiesService.getScriptProperties();
  const refreshToken = props.getProperty('BASECAMP_REFRESH_TOKEN');
  const clientId     = props.getProperty('BASECAMP_CLIENT_ID');
  const clientSecret = props.getProperty('BASECAMP_CLIENT_SECRET');
  const redirectUri  = props.getProperty('BASECAMP_REDIRECT_URI');

  if (!refreshToken) {
    Logger.log('ERROR: No refresh token found. Run setupBasecampOAuth() to re-authorise.');
    return;
  }

  const response = UrlFetchApp.fetch('https://launchpad.37signals.com/authorization/token', {
    method: 'POST',
    muteHttpExceptions: true,
    payload: {
      type:          'refresh',
      client_id:     clientId,
      client_secret: clientSecret,
      redirect_uri:  redirectUri,
      refresh_token: refreshToken,
    },
  });

  if (response.getResponseCode() !== 200) {
    Logger.log('ERROR: Token refresh failed (' + response.getResponseCode() + '): ' + response.getContentText());
    return;
  }

  const data = JSON.parse(response.getContentText());
  if (!data.access_token) {
    Logger.log('ERROR: No access token in refresh response.');
    return;
  }

  props.setProperty('BASECAMP_ACCESS_TOKEN', data.access_token);
  if (data.refresh_token) {
    props.setProperty('BASECAMP_REFRESH_TOKEN', data.refresh_token);
  }

  Logger.log('✅ Basecamp token refreshed successfully.');
}

function setupBasecampOAuth() {
  const props       = PropertiesService.getScriptProperties();
  const clientId    = props.getProperty('BASECAMP_CLIENT_ID');
  const redirectUri = props.getProperty('BASECAMP_REDIRECT_URI');

  if (!clientId || !redirectUri) {
    Logger.log('ERROR: Run storeCredentials() first.');
    return;
  }

  const authUrl =
    'https://launchpad.37signals.com/authorization/new' +
    '?type=web_server' +
    '&client_id=' + clientId +
    '&redirect_uri=' + encodeURIComponent(redirectUri);

  Logger.log('=== BASECAMP AUTHORISATION ===');
  Logger.log('Open this URL in your browser:');
  Logger.log('');
  Logger.log(authUrl);
}

// ------------------------------------------------------------
// getBasecampActivity — v8 (concurrent)
//
// Fetches the same data as before, but instead of one slow
// request at a time (with a sleep before every call), it groups
// requests into stages and runs each stage concurrently with
// UrlFetchApp.fetchAll. A hard time budget guarantees the function
// always returns in time for the report to be written and sent —
// if the budget is ever hit, it stops gathering and returns
// whatever it has so far rather than letting the script time out.
// ------------------------------------------------------------
function getBasecampActivity() {
  const token = PropertiesService.getScriptProperties().getProperty('BASECAMP_ACCESS_TOKEN');
  if (!token) throw new Error('AUTH_EXPIRED: BASECAMP_ACCESS_TOKEN not set.');

  const headers = {
    'Authorization': 'Bearer ' + token,
    'User-Agent':    CONFIG.BASECAMP_UA,
  };

  const since = new Date();
  since.setDate(since.getDate() - CONFIG.DAYS_BACK);

  // Hard stop for data gathering. Apps Script kills the whole script
  // at 6 minutes; we cap gathering well below that so there is always
  // time left to call Claude, send the email and write the docs.
  const GATHER_BUDGET_MS = 150 * 1000; // 2.5 minutes
  const startTime = Date.now();
  const timeLeft  = () => GATHER_BUDGET_MS - (Date.now() - startTime);

  // --- Stage A: paginate through ALL projects (inherently sequential) ---
  let projectsUrl = 'https://3.basecampapi.com/' + CONFIG.ACCOUNT_ID + '/projects.json';
  const activeProjects = [];

  while (projectsUrl) {
    const projResp = UrlFetchApp.fetch(projectsUrl, { headers, muteHttpExceptions: true });
    const code = projResp.getResponseCode();
    if (code === 401 || code === 403) throw new Error('AUTH_EXPIRED: Basecamp token rejected (HTTP ' + code + ').');
    if (code !== 200) throw new Error('Projects fetch failed (HTTP ' + code + '): ' + projResp.getContentText());

    const batch = JSON.parse(projResp.getContentText());
    batch.forEach(p => {
      if (isExcludedProject(p)) {
        Logger.log('Skipping private project: ' + p.name);
        return;
      }
      if (p.status === 'active' && new Date(p.updated_at) >= since) {
        activeProjects.push(p);
      }
    });

    projectsUrl = getNextPageUrl(projResp);
    if (projectsUrl) Utilities.sleep(200);
  }

  Logger.log('Projects updated in window: ' + activeProjects.length);

  const allEvents = [];

  // --- Stage B: message board + todoset for every project (concurrent) ---
  const stageB = [];
  activeProjects.forEach(project => {
    if (!project.dock) return;
    const msgTool = project.dock.find(t => t.name === 'message_board');
    if (msgTool) {
      stageB.push({ kind: 'messages', project: project, url: msgTool.url.replace('.json', '/messages.json') + '?per_page=10' });
    }
    const todoTool = project.dock.find(t => t.name === 'todoset');
    if (todoTool) {
      stageB.push({ kind: 'todoset', project: project, url: todoTool.url });
    }
  });

  const todolistJobs = []; // { project, url } for each project's todolists collection
  fetchAllChunked(stageB, headers, timeLeft, (job, resp) => {
    if (resp.getResponseCode() !== 200) return;
    if (job.kind === 'messages') {
      const messages = JSON.parse(resp.getContentText());
      for (const m of messages) {
        if (new Date(m.updated_at) < since) break; // newest first
        allEvents.push({
          project:    job.project.name,
          created_at: m.updated_at,
          creator:    basecampCreator(m),
          action:     'posted message',
          title:      m.subject || '',
          type:       'Message',
        });
      }
    } else { // todoset
      const todoset = JSON.parse(resp.getContentText());
      if (todoset.todolists_url) {
        todolistJobs.push({ project: job.project, url: todoset.todolists_url + '?per_page=10' });
      }
    }
  });

  // --- Stage C: the todolists inside each todoset (concurrent) ---
  const todoFetchJobs = []; // one active + one completed request per todolist
  fetchAllChunked(todolistJobs, headers, timeLeft, (job, resp) => {
    if (resp.getResponseCode() !== 200) return;
    const todolists = JSON.parse(resp.getContentText());
    todolists.forEach(tl => {
      const base = tl.url.replace('.json', '/todos.json');
      todoFetchJobs.push({ kind: 'active',    project: job.project, url: base + '?per_page=20' });
      todoFetchJobs.push({ kind: 'completed', project: job.project, url: base + '?completion_status=completed&per_page=20' });
    });
  });

  // --- Stage D: active + completed todos for every todolist (concurrent) ---
  fetchAllChunked(todoFetchJobs, headers, timeLeft, (job, resp) => {
    if (resp.getResponseCode() !== 200) return;
    const todos = JSON.parse(resp.getContentText());
    for (const t of todos) {
      if (new Date(t.updated_at) < since) continue;
      allEvents.push({
        project:    job.project.name,
        created_at: t.updated_at,
        creator:    basecampCreator(t),
        action:     (job.kind === 'completed' && t.completed === true) ? 'completed todo' : 'updated todo',
        title:      t.content || '',
        type:       'Todo',
      });
    }
  });

  allEvents.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  Logger.log('Events in window: ' + allEvents.length);
  return allEvents;
}

// Small helper — safe creator name off a Basecamp object.
// True if a project is on the private list in Config (CONFIG.EXCLUDED_PROJECTS).
function isExcludedProject(project) {
  const name = String(project.name || '').toLowerCase();
  return (CONFIG.EXCLUDED_PROJECTS || []).some(x => name.indexOf(String(x).toLowerCase()) !== -1);
}

function basecampCreator(obj) {
  return obj.creator && obj.creator.name ? obj.creator.name : 'Unknown';
}

// Runs a list of {url, ...} jobs through UrlFetchApp.fetchAll in
// concurrent chunks. `handle(job, response)` is called for each result.
//
// Rate-limit safety (Basecamp allows 50 requests / 10 seconds per IP,
// adjusted dynamically, returning HTTP 429 with a Retry-After header):
//   - CHUNK/PAUSE_MS keep the sustained rate well under 50 per 10s.
//   - If a 429 is returned anyway, we honour Retry-After and retry ONLY
//     the throttled requests, so no data is silently dropped.
//   - Everything is bounded by the caller's time budget.
function fetchAllChunked(jobs, headers, timeLeft, handle) {
  const CHUNK       = 12;   // requests sent concurrently per batch
  const PAUSE_MS    = 2500; // pause between batches (sustained rate ~24-30 req / 10s)
  const MAX_RETRIES = 4;    // per-batch 429 retry attempts

  for (let i = 0; i < jobs.length; i += CHUNK) {
    if (timeLeft() <= 0) {
      Logger.log('Time budget reached — stopped after ' + i + ' of ' + jobs.length + ' requests.');
      return;
    }

    let pending = jobs.slice(i, i + CHUNK);
    let attempt = 0;

    while (pending.length > 0) {
      const requests = pending.map(j => ({ url: j.url, method: 'get', headers: headers, muteHttpExceptions: true }));

      let responses;
      try {
        responses = UrlFetchApp.fetchAll(requests);
      } catch (e) {
        Logger.log('fetchAll error (skipping batch): ' + e);
        break;
      }

      const throttled = [];
      let retryAfterSec = 0;

      for (let k = 0; k < responses.length; k++) {
        const resp = responses[k];
        const code = resp.getResponseCode();

        if (code === 401 || code === 403) {
          throw new Error('AUTH_EXPIRED: Basecamp token rejected (HTTP ' + code + ').');
        }
        if (code === 429) {
          throttled.push(pending[k]);
          const h  = resp.getHeaders();
          const ra = parseInt(h['Retry-After'] || h['retry-after'] || '0', 10);
          if (ra > retryAfterSec) retryAfterSec = ra;
          continue;
        }
        try {
          handle(pending[k], resp);
        } catch (e) {
          Logger.log('Parse error on ' + pending[k].url + ': ' + e);
        }
      }

      if (throttled.length === 0) break; // whole batch handled

      attempt++;
      if (attempt > MAX_RETRIES || timeLeft() <= 0) {
        Logger.log('Rate limit: gave up on ' + throttled.length + ' request(s) after ' + (attempt - 1) + ' retr(y/ies).');
        break;
      }

      const waitMs = Math.max((retryAfterSec || 5) * 1000, 3000);
      Logger.log('Rate limited (429) on ' + throttled.length + ' request(s) — waiting ' +
                 Math.round(waitMs / 1000) + 's, then retrying just those.');
      Utilities.sleep(waitMs);
      pending = throttled; // retry only the throttled ones
    }

    if (i + CHUNK < jobs.length) Utilities.sleep(PAUSE_MS);
  }
}

function getNextPageUrl(response) {
  const link  = response.getHeaders()['Link'] || response.getHeaders()['link'] || '';
  const match = link.match(/<([^>]+)>;\s*rel="next"/);
  return match ? match[1] : null;
}