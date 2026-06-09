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

function getBasecampActivity() {
  const token = PropertiesService.getScriptProperties().getProperty('BASECAMP_ACCESS_TOKEN');
  if (!token) throw new Error('AUTH_EXPIRED: BASECAMP_ACCESS_TOKEN not set.');

  const headers = {
    'Authorization': 'Bearer ' + token,
    'User-Agent':    CONFIG.BASECAMP_UA,
  };

  const since = new Date();
  since.setDate(since.getDate() - CONFIG.DAYS_BACK);

  // --- Paginate through ALL projects, keep only active ones updated recently ---
  let projectsUrl = 'https://3.basecampapi.com/' + CONFIG.ACCOUNT_ID + '/projects.json';
  const activeProjects = [];

  while (projectsUrl) {
    const projResp = UrlFetchApp.fetch(projectsUrl, { headers, muteHttpExceptions: true });
    const code = projResp.getResponseCode();
    if (code === 401 || code === 403) throw new Error('AUTH_EXPIRED: Basecamp token rejected (HTTP ' + code + ').');
    if (code !== 200) throw new Error('Projects fetch failed (HTTP ' + code + '): ' + projResp.getContentText());

    const batch = JSON.parse(projResp.getContentText());
    batch.forEach(p => {
      if (p.status === 'active' && new Date(p.updated_at) >= since) {
        activeProjects.push(p);
      }
    });

    projectsUrl = getNextPageUrl(projResp);
    Utilities.sleep(300);
  }

  Logger.log('Projects updated in window: ' + activeProjects.length);

  const allEvents = [];

  for (const project of activeProjects) {
    if (!project.dock) continue;

    // --- Messages ---
    const msgTool = project.dock.find(t => t.name === 'message_board');
    if (msgTool) {
      try {
        Utilities.sleep(400);
        const msgResp = UrlFetchApp.fetch(
          msgTool.url.replace('.json', '/messages.json') + '?per_page=10',
          { headers, muteHttpExceptions: true }
        );
        if (msgResp.getResponseCode() === 200) {
          const messages = JSON.parse(msgResp.getContentText());
          for (const m of messages) {
            if (new Date(m.updated_at) < since) break;
            allEvents.push({
              project:    project.name,
              created_at: m.updated_at,
              creator:    m.creator && m.creator.name ? m.creator.name : 'Unknown',
              action:     'posted message',
              title:      m.subject || '',
              type:       'Message',
            });
          }
        }
      } catch(e) { Logger.log('Message error on ' + project.name + ': ' + e); }
    }

    // --- Todos (completed and active, updated recently) ---
    const todoTool = project.dock.find(t => t.name === 'todoset');
    if (todoTool) {
      try {
        Utilities.sleep(400);
        const tsResp = UrlFetchApp.fetch(todoTool.url, { headers, muteHttpExceptions: true });
        if (tsResp.getResponseCode() === 200) {
          const todoset = JSON.parse(tsResp.getContentText());
          const todolistsUrl = todoset.todolists_url;
          if (todolistsUrl) {
            Utilities.sleep(400);
            const tlResp = UrlFetchApp.fetch(todolistsUrl + '?per_page=10', { headers, muteHttpExceptions: true });
            if (tlResp.getResponseCode() === 200) {
              const todolists = JSON.parse(tlResp.getContentText());
              for (const tl of todolists) {
                // Fetch active todos
                const activeTodosUrl = tl.url.replace('.json', '/todos.json') + '?per_page=20';
                Utilities.sleep(300);
                const activeTodosResp = UrlFetchApp.fetch(activeTodosUrl, { headers, muteHttpExceptions: true });
                if (activeTodosResp.getResponseCode() === 200) {
                  const todos = JSON.parse(activeTodosResp.getContentText());
                  for (const t of todos) {
                    if (new Date(t.updated_at) < since) continue;
                    allEvents.push({
                      project:    project.name,
                      created_at: t.updated_at,
                      creator:    t.creator && t.creator.name ? t.creator.name : 'Unknown',
                      action:     'updated todo',
                      title:      t.content || '',
                      type:       'Todo',
                    });
                  }
                }
                // Fetch completed todos
                const completedTodosUrl = tl.url.replace('.json', '/todos.json') + '?completion_status=completed&per_page=20';
                Utilities.sleep(300);
                const completedTodosResp = UrlFetchApp.fetch(completedTodosUrl, { headers, muteHttpExceptions: true });
                if (completedTodosResp.getResponseCode() === 200) {
                  const completed = JSON.parse(completedTodosResp.getContentText());
                  for (const t of completed) {
                    if (new Date(t.updated_at) < since) continue;
                    allEvents.push({
                      project:    project.name,
                      created_at: t.updated_at,
                      creator:    t.creator && t.creator.name ? t.creator.name : 'Unknown',
                      action: t.completed === true ? 'completed todo' : 'updated todo',
                      title:      t.content || '',
                      type:       'Todo',
                    });
                  }
                }
              }
            }
          }
        }
      } catch(e) { Logger.log('Todo error on ' + project.name + ': ' + e); }
    }
  }

  allEvents.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  Logger.log('Events in window: ' + allEvents.length);
  return allEvents;
}

function getNextPageUrl(response) {
  const link  = response.getHeaders()['Link'] || response.getHeaders()['link'] || '';
  const match = link.match(/<([^>]+)>;\s*rel="next"/);
  return match ? match[1] : null;
}