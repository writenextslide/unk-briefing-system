// ============================================================
// UNK KPI Draft Notes — v2
// Pulls Basecamp activity since last Tuesday by person
// Uses assignees for attribution, fetches comments for context
// Contractor work rolls up under their manager's section
// Writes to a shared Google Doc every Monday at 5pm
// ============================================================

const KPI_CONFIG = {
  RECIPIENT:      'roger.elliott@unk.com',
  ACCOUNT_ID:     '5492807',
  DRAFT_DOC_ID:   '1hmcOQwrNzpW8Gqyot4bk-y8p5PPU9Mhkr2kUtWNv0mk',
  CLAUDE_MODEL:   'claude-sonnet-4-6',
  BASECAMP_UA:    'UNK KPI Draft Script (roger.elliott@unk.com)',

  // Projects to exclude entirely — partial match, case-insensitive
  EXCLUDE_PROJECTS: ['Elliott'],

  TEAM: [
    { name: 'Paul',     basecampName: 'Paul Galbraith',     email: 'paul.galbraith@unk.com'     },
    { name: 'Mark',     basecampName: 'Mark Tyrrell',       email: 'mark.tyrrell@unk.com'       },
    { name: 'Lyndsay',  basecampName: 'Lyndsay Elliott',    email: 'lyndsay.elliott@unk.com'    },
    { name: 'Roger',    basecampName: 'Roger Elliott',      email: 'roger.elliott@unk.com'      },
  ],

  // Contractors: their work appears under their manager's section,
  // labelled with their own name so Claude can write them up separately.
  CONTRACTORS: [
    { basecampName: 'Rajesh Dey',     managedBy: 'Roger Elliott' },
    { basecampName: 'Sayed Rahman',   managedBy: 'Roger Elliott' },
    { basecampName: 'Ola Lundqvist',  managedBy: 'Roger Elliott' },
    { basecampName: 'Rebekah Hall',   managedBy: 'Roger Elliott' },
  ],
};


// ============================================================
// DATE HELPERS
// ============================================================

function getSinceLastTuesday() {
  const now  = new Date();
  const day  = now.getDay();
  const daysBack = day === 2 ? 7 : (day + 5) % 7;
  const since = new Date(now);
  since.setDate(now.getDate() - daysBack);
  since.setHours(0, 0, 0, 0);
  Logger.log('Fetching activity since: ' + since.toISOString());
  return since;
}


// ============================================================
// FETCH COMMENTS FOR A SINGLE TODO
// ============================================================

function fetchRecentComments(projectId, todoId, headers, since) {
  try {
    Utilities.sleep(150);
    const url = 'https://3.basecampapi.com/' + KPI_CONFIG.ACCOUNT_ID +
                '/buckets/' + projectId + '/recordings/' + todoId + '/comments.json';
    const resp = UrlFetchApp.fetch(url, { headers, muteHttpExceptions: true });
    if (resp.getResponseCode() !== 200) return [];

    const comments = JSON.parse(resp.getContentText());
    return comments
      .filter(c => new Date(c.created_at) >= since)
      .map(c => ({
        author: c.creator && c.creator.name ? c.creator.name : 'Unknown',
        text:   (c.content || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
      }));
  } catch(e) {
    Logger.log('Comment fetch error for todo ' + todoId + ': ' + e);
    return [];
  }
}


// ============================================================
// FETCH BASECAMP ACTIVITY GROUPED BY PERSON
// ============================================================

function getBasecampActivityByPerson() {
  const token = PropertiesService.getScriptProperties().getProperty('BASECAMP_ACCESS_TOKEN');
  if (!token) throw new Error('BASECAMP_ACCESS_TOKEN not set.');

  const headers = {
    'Authorization': 'Bearer ' + token,
    'User-Agent':    KPI_CONFIG.BASECAMP_UA,
  };

  const since = getSinceLastTuesday();

  // Build lookup maps
  const contractorMap = {};
  KPI_CONFIG.CONTRACTORS.forEach(c => { contractorMap[c.basecampName] = c.managedBy; });

  const byPerson = {};
  KPI_CONFIG.TEAM.forEach(m => { byPerson[m.basecampName] = []; });

  let projectsUrl = 'https://3.basecampapi.com/' + KPI_CONFIG.ACCOUNT_ID + '/projects.json';
  const activeProjects = [];

  while (projectsUrl) {
    const projResp = UrlFetchApp.fetch(projectsUrl, { headers, muteHttpExceptions: true });
    if (projResp.getResponseCode() !== 200) throw new Error('Projects fetch failed.');

    const batch = JSON.parse(projResp.getContentText());
    batch.forEach(p => {
      const excluded = KPI_CONFIG.EXCLUDE_PROJECTS.some(ex =>
        p.name && p.name.toLowerCase().includes(ex.toLowerCase())
      );
    if (!excluded && p.status === 'active' && new Date(p.updated_at) >= since) {
        activeProjects.push(p);
      }
    });

    projectsUrl = getKpiNextPageUrl(projResp);
    Utilities.sleep(150);
  }

  Logger.log('Projects to scan: ' + activeProjects.length);

  for (const project of activeProjects) {
    if (!project.dock) continue;

    // --- Completed Todos ---
    const todoTool = project.dock.find(t => t.name === 'todoset');
    if (todoTool) {
      try {
        Utilities.sleep(200);
        const tsResp = UrlFetchApp.fetch(todoTool.url, { headers, muteHttpExceptions: true });
        if (tsResp.getResponseCode() === 200) {
          const todoset = JSON.parse(tsResp.getContentText());
          if (todoset.todolists_url) {
            Utilities.sleep(200);
            const tlResp = UrlFetchApp.fetch(todoset.todolists_url, { headers, muteHttpExceptions: true });
            if (tlResp.getResponseCode() === 200) {
              const todolists = JSON.parse(tlResp.getContentText());
              for (const tl of todolists) {
                if (new Date(tl.updated_at) < since) continue;
                Utilities.sleep(150);

                const completedResp = UrlFetchApp.fetch(
                  tl.todos_url + '?completed=true&per_page=50',
                  { headers, muteHttpExceptions: true }
                );
                if (completedResp.getResponseCode() !== 200) continue;
                const todos = JSON.parse(completedResp.getContentText());

                for (const t of todos) {
                  if (new Date(t.updated_at) < since) continue;

                  // Determine attributed people from assignees
                  let attributedTo = [];
                  if (t.assignees && t.assignees.length > 0) {
                    t.assignees.forEach(a => {
                      if (!a.name) return;
                      if (byPerson.hasOwnProperty(a.name)) {
                        // Direct team member
                        attributedTo.push({ bucket: a.name, workedBy: a.name });
                      } else if (contractorMap.hasOwnProperty(a.name)) {
                        // Contractor — rolls up to manager
                        attributedTo.push({ bucket: contractorMap[a.name], workedBy: a.name });
                      }
                    });
                  }
                  // Fall back to creator if no assignees matched
                  if (attributedTo.length === 0 && t.creator && t.creator.name) {
                    const name = t.creator.name;
                    if (byPerson.hasOwnProperty(name)) {
                      attributedTo.push({ bucket: name, workedBy: name });
                    } else if (contractorMap.hasOwnProperty(name)) {
                      attributedTo.push({ bucket: contractorMap[name], workedBy: name });
                    }
                  }

                  if (attributedTo.length === 0) continue;

                  // Only fetch comments if the todo actually has some — avoids an API call + sleep per todo
                  const comments = (t.comments_count > 0)
                    ? fetchRecentComments(project.id, t.id, headers, since)
                    : [];

                  attributedTo.forEach(attr => {
                    byPerson[attr.bucket].push({
                      project:  project.name,
                      title:    t.content || '',
                      type:     'completed todo',
                      workedBy: attr.workedBy,
                      comments: comments,
                    });
                  });
                }
              }
            }
          }
        }
      } catch(e) { Logger.log('Todo error on ' + project.name + ': ' + e); }
    }

    // --- Messages posted ---
    const msgTool = project.dock.find(t => t.name === 'message_board');
    if (msgTool) {
      try {
        Utilities.sleep(200);
        const msgResp = UrlFetchApp.fetch(
          msgTool.url.replace('.json', '/messages.json') + '?per_page=10',
          { headers, muteHttpExceptions: true }
        );
        if (msgResp.getResponseCode() === 200) {
          const messages = JSON.parse(msgResp.getContentText());
          for (const m of messages) {
            if (new Date(m.created_at) < since) break;
            const name = m.creator && m.creator.name ? m.creator.name : null;
            if (!name) continue;
            if (byPerson.hasOwnProperty(name)) {
              byPerson[name].push({
                project:  project.name,
                title:    m.subject || '',
                type:     'posted message',
                workedBy: name,
                comments: [],
              });
            } else if (contractorMap.hasOwnProperty(name)) {
              byPerson[contractorMap[name]].push({
                project:  project.name,
                title:    m.subject || '',
                type:     'posted message',
                workedBy: name,
                comments: [],
              });
            }
          }
        }
      } catch(e) { Logger.log('Message error on ' + project.name + ': ' + e); }
    }
  }

  KPI_CONFIG.TEAM.forEach(m => {
    Logger.log(m.name + ': ' + byPerson[m.basecampName].length + ' events');
  });

  return byPerson;
}


function getKpiNextPageUrl(response) {
  const link = response.getHeaders()['Link'] || response.getHeaders()['link'] || '';
  const match = link.match(/<([^>]+)>;\s*rel="next"/);
  return match ? match[1] : null;
}


// ============================================================
// DRAFT KPI SECTIONS VIA CLAUDE
// ============================================================

function draftKpiSections(byPerson) {
  const apiKey = PropertiesService.getScriptProperties().getProperty('CLAUDE_API_KEY');
  if (!apiKey) throw new Error('CLAUDE_API_KEY not set in Script Properties.');

  const activitySummary = KPI_CONFIG.TEAM.map(member => {
    const events = byPerson[member.basecampName];
    if (events.length === 0) {
      return member.name + ':\n(No Basecamp activity recorded this week)';
    }

    const lines = events.map(e => {
      // If workedBy differs from the bucket owner, label it clearly
      const workerLabel = e.workedBy !== member.basecampName
        ? ' [CONTRACTOR: ' + e.workedBy + ']'
        : '';
      let entry = '  TASK [' + e.project + ']' + workerLabel + ': ' + e.title;
      if (e.comments && e.comments.length > 0) {
        const commentLines = e.comments.map(c => '    COMMENT by ' + c.author + ': ' + c.text);
        entry += '\n' + commentLines.join('\n');
      } else {
        entry += '\n    (no comments this week)';
      }
      return entry;
    });

    return member.name + ':\n' + lines.join('\n\n');
  }).join('\n\n---\n\n');

  const systemPrompt =
    'You are helping prepare draft KPI meeting notes for Uncommon Knowledge Ltd (UNK), a UK digital content and education business.\n\n' +
    'You will be given completed Basecamp tasks grouped by team member, along with any comments added to those tasks this week.\n\n' +
    'Some tasks are labelled [CONTRACTOR: Name]. These were completed by contractors who report to that team member. ' +
    'Include their work as a sub-section within their manager\'s notes, introduced with the contractor\'s name, e.g. "Rajesh:" followed by bullets.\n\n' +
    'CRITICAL RULES:\n' +
    '- ONLY report work evidenced by actual comments describing what was done, or by the task being completed with clear context.\n' +
    '- NEVER infer or assume what was done from the task title alone.\n' +
    '- If a task has no comments and the title alone does not make it obvious the work is fully done, OMIT it.\n' +
    '- If a comment shows someone was merely nudged, asked a question, or passed work on, do NOT report it as completed work.\n' +
    '- If a comment shows a task was rescheduled or is still in progress, do NOT report it as done.\n' +
    '- Do NOT include routine recurring checks unless the comment describes a specific finding or action.\n\n' +
    'Format rules:\n' +
    '- Each section starts with the person\'s first name and today\'s date on one line, e.g. "Roger [date]"\n' +
    '- List items as short bullet points starting with a dash, one per line\n' +
    '- Contractor sub-sections appear after the manager\'s own bullets, introduced with just the contractor\'s first name and a colon, e.g. "Rajesh:"\n' +
    '- Keep all bullets concise and direct — match real KPI notes style, no fluff\n' +
    '- Do NOT include a "Next" section\n' +
    '- Do NOT add preamble, commentary, or sign-off text\n' +
    '- If a person has no evidenced activity, write their name and date, then: "(No Basecamp activity this week — please add manually)"\n\n' +
    'Produce all four sections one after another, separated by a blank line. Nothing else.';

  const dateStr = Utilities.formatDate(new Date(), 'Europe/London', 'dd MMMM yyyy');

  const userMessage =
    'Today\'s date is ' + dateStr + '.\n\n' +
    'Here is this week\'s Basecamp activity by team member, including task comments:\n\n' +
    activitySummary + '\n\n' +
    'Please produce the draft KPI notes sections, following the critical rules above.';

  const resp = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
    method: 'post',
    muteHttpExceptions: true,
    headers: {
      'x-api-key':         apiKey,
      'anthropic-version': '2023-06-01',
      'content-type':      'application/json',
    },
    payload: JSON.stringify({
      model:      KPI_CONFIG.CLAUDE_MODEL,
      max_tokens: 2000,
      system:     systemPrompt,
      messages:   [{ role: 'user', content: userMessage }],
    }),
  });

  if (resp.getResponseCode() !== 200) {
    throw new Error('Claude API failed (' + resp.getResponseCode() + '): ' + resp.getContentText());
  }

  return JSON.parse(resp.getContentText()).content[0].text;
}


// ============================================================
// WRITE DRAFT TO GOOGLE DOC
// ============================================================

function writeDraftToDoc(draftText) {
  const doc     = DocumentApp.openById(KPI_CONFIG.DRAFT_DOC_ID);
  const body    = doc.getBody();
  const dateStr = Utilities.formatDate(new Date(), 'Europe/London', 'dd MMMM yyyy');

  // Safe clear
  body.appendParagraph('');
  var numChildren = body.getNumChildren();
  for (var i = numChildren - 2; i >= 0; i--) {
    body.removeChild(body.getChild(i));
  }

  const title = body.appendParagraph('UNK KPI Draft Notes — ' + dateStr);
  title.setHeading(DocumentApp.ParagraphHeading.HEADING1);

  body.appendParagraph(
    'This is a draft prepared from Basecamp activity. Please review your section, ' +
    'add anything missing (numbers, context, work outside Basecamp), and remove ' +
    'anything inaccurate before the meeting.'
  );

  body.appendParagraph('');

  const lines = draftText.split('\n');
  for (const line of lines) {
    if (line.trim() === '') {
      body.appendParagraph('');
    } else if (line.trim().startsWith('- ')) {
      body.appendListItem(line.trim().substring(2));
    } else {
      body.appendParagraph(line);
    }
  }

  Logger.log('Draft written to doc: ' + KPI_CONFIG.DRAFT_DOC_ID);
}


// ============================================================
// NOTIFY TEAM BY EMAIL
// ============================================================

function sendNotificationEmail() {
  const docUrl    = 'https://docs.google.com/document/d/' + KPI_CONFIG.DRAFT_DOC_ID + '/edit';
  const allEmails = KPI_CONFIG.TEAM.map(m => m.email).join(',');

  GmailApp.sendEmail(
    allEmails,
    'Your KPI draft notes are ready',
    'Your KPI draft notes are ready to review:\n\n' + docUrl,
    { name: 'UNK Briefing' }
  );

  Logger.log('Notification email sent to ' + allEmails);
}


// ============================================================
// MAIN
// ============================================================

function runKpiDraft() {
  try {

    Logger.log('--- UNK KPI Draft Notes v2 starting ---');
    refreshBasecampToken();

    const byPerson = getBasecampActivityByPerson();
    const draft    = draftKpiSections(byPerson);
    writeDraftToDoc(draft);
    sendNotificationEmail();

    Logger.log('--- Done ---');

  } catch (err) {
    Logger.log('FATAL ERROR: ' + err.toString());
    try {
      GmailApp.sendEmail(
        KPI_CONFIG.RECIPIENT,
        'UNK KPI Draft Script — ERROR',
        'The KPI draft script failed.\n\nError:\n' + err.toString() +
        '\n\nCheck the execution log:\nhttps://script.google.com'
      );
    } catch (e) { Logger.log('Could not send error email: ' + e); }
  }
}

function testKpiDraft() {
  Logger.log('=== TEST RUN ===');
  const docUrl = 'https://docs.google.com/document/d/' + KPI_CONFIG.DRAFT_DOC_ID + '/edit';

  try {
    const byPerson = getBasecampActivityByPerson();
    const draft    = draftKpiSections(byPerson);
    writeDraftToDoc(draft);

    // Test email to Roger only
    GmailApp.sendEmail(
      KPI_CONFIG.RECIPIENT,
      '[TEST] Your KPI draft notes are ready',
      'TEST RUN — this email went to Roger only.\n\nDraft doc:\n' + docUrl,
      { name: 'UNK Briefing' }
    );
    Logger.log('Test notification sent to ' + KPI_CONFIG.RECIPIENT + ' only.');
    Logger.log('--- Done ---');

  } catch (err) {
    Logger.log('FATAL ERROR: ' + err.toString());
    GmailApp.sendEmail(
      KPI_CONFIG.RECIPIENT,
      'UNK KPI Draft Script — ERROR',
      'The KPI draft script failed.\n\nError:\n' + err.toString() +
      '\n\nCheck the execution log:\nhttps://script.google.com'
    );
  }
}

function authorizeBasecamp() {
  const clientId = PropertiesService.getScriptProperties().getProperty('BASECAMP_CLIENT_ID');
  const redirectUri = PropertiesService.getScriptProperties().getProperty('SCRIPT_URL');
  const url = 'https://launchpad.37signals.com/authorization/new' +
    '?type=web_server' +
    '&client_id=' + clientId +
    '&redirect_uri=' + encodeURIComponent(redirectUri);
  Logger.log('Visit this URL to authorise:\n' + url);
}

function doGet(e) {
  const code = e.parameter.code;
  if (!code) return ContentService.createTextOutput('No code found.');

  const props = PropertiesService.getScriptProperties();
  const clientId     = props.getProperty('BASECAMP_CLIENT_ID');
  const clientSecret = props.getProperty('BASECAMP_CLIENT_SECRET');
  const redirectUri = PropertiesService.getScriptProperties().getProperty('SCRIPT_URL');

  const resp = UrlFetchApp.fetch('https://launchpad.37signals.com/authorization/token', {
    method: 'post',
    payload: {
      type:          'web_server',
      client_id:     clientId,
      client_secret: clientSecret,
      redirect_uri:  redirectUri,
      code:          code,
    },
    muteHttpExceptions: true,
  });

  const data = JSON.parse(resp.getContentText());
  if (data.access_token) {
  props.setProperty('BASECAMP_ACCESS_TOKEN', data.access_token);
  if (data.refresh_token) {
    props.setProperty('BASECAMP_REFRESH_TOKEN', data.refresh_token);
  }
  return ContentService.createTextOutput('Success! Token stored. You can close this tab.');
}
}

// ============================================================
// TRIGGER SETUP — run once
// ============================================================

function createKpiTrigger() {
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === 'runKpiDraft') {
      ScriptApp.deleteTrigger(t);
    }
  });

  ScriptApp.newTrigger('runKpiDraft')
    .timeBased()
    .onWeekDay(ScriptApp.WeekDay.MONDAY)
    .atHour(17)
    .create();

  Logger.log('Trigger created: runKpiDraft every Monday at 5pm.');
  Logger.log('Note: Apps Script triggers fire within the hour — expect 5:00-5:30pm.');

}
function refreshBasecampToken() {
  const props = PropertiesService.getScriptProperties();
  const resp = UrlFetchApp.fetch('https://launchpad.37signals.com/authorization/token', {
    method: 'post',
    payload: {
      type:          'refresh',
      client_id:     props.getProperty('BASECAMP_CLIENT_ID'),
      client_secret: props.getProperty('BASECAMP_CLIENT_SECRET'),
      refresh_token: props.getProperty('BASECAMP_REFRESH_TOKEN'),
    },
    muteHttpExceptions: true,
  });
  const data = JSON.parse(resp.getContentText());
  if (data.access_token) {
    props.setProperty('BASECAMP_ACCESS_TOKEN', data.access_token);
    Logger.log('Basecamp token refreshed.');
  } else {
    throw new Error('Token refresh failed: ' + resp.getContentText());
  }
}
