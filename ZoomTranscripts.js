// ============================================================
// ZoomTranscripts.gs — Zoom Meeting Summariser
// Part of the UNK Weekly MD Briefing project
// Detects Huddle/KPI recordings, summarises with Claude,
// writes to Meeting Summaries doc and posts to Basecamp.
// ============================================================

const ZOOM_CONFIG = {
  START_HOUR:      8,
  END_HOUR:        19,
  MEETINGS_DOC_ID: '1UP4wlpXL1cBnb0f32ZF4hbCKQcHlw2BasgJqooia0JU',
  ACCOUNT_ID:      '5492807',
  BC_PROJECT_ID:   '30309377',
  BC_TASK_ID:      '9814008160',
  BASECAMP_UA:     'UNK Zoom Summariser (roger.elliott@unk.com)',
};

// Basecamp person lookup for @mention tagging.
// To find SGIDs: run logBasecampPeople() from the editor.
const BC_PEOPLE = {
  'roger':    { sgid: 'BAh7BkkiC19yYWlscwY6BkVUewdJIglkYXRhBjsAVEkiKWdpZDovL2JjMy9QZXJzb24vNDE3OTMwODg_ZXhwaXJlc19pbgY7AFRJIghwdXIGOwBUSSIPYXR0YWNoYWJsZQY7AFQ=--9c67cc905e918c265c9c6d04372e2f7805bf35d6', name: 'Roger Elliott' },
  'mark':     { sgid: 'BAh7BkkiC19yYWlscwY6BkVUewdJIglkYXRhBjsAVEkiKWdpZDovL2JjMy9QZXJzb24vNDIwNzE2NDI_ZXhwaXJlc19pbgY7AFRJIghwdXIGOwBUSSIPYXR0YWNoYWJsZQY7AFQ=--06bffa4b07bd12257fa5c744d93224186b220c12', name: 'Mark Tyrrell' },
  'lyndsay':  { sgid: 'BAh7BkkiC19yYWlscwY6BkVUewdJIglkYXRhBjsAVEkiKWdpZDovL2JjMy9QZXJzb24vNDIwNzIwNjQ_ZXhwaXJlc19pbgY7AFRJIghwdXIGOwBUSSIPYXR0YWNoYWJsZQY7AFQ=--0d3ed12d2326d4722839bc27dcc5435455aabd98', name: 'Lyndsay Elliott' },
  'ruairidh': { sgid: 'BAh7BkkiC19yYWlscwY6BkVUewdJIglkYXRhBjsAVEkiKWdpZDovL2JjMy9QZXJzb24vNDE3OTIzODc_ZXhwaXJlc19pbgY7AFRJIghwdXIGOwBUSSIPYXR0YWNoYWJsZQY7AFQ=--034bf5ee144f1a966977b7ccb6aa312236dde84d', name: 'Ruairidh Galbraith' },
  'paul':     { sgid: 'BAh7BkkiC19yYWlscwY6BkVUewdJIglkYXRhBjsAVEkiKWdpZDovL2JjMy9QZXJzb24vNDE3OTI1MDU_ZXhwaXJlc19pbgY7AFRJIghwdXIGOwBUSSIPYXR0YWNoYWJsZQY7AFQ=--ca3d08944c0ec72723baf47164d3dffd034089de', name: 'Paul Galbraith' },
};


// ============================================================
// WORKING DAY CHECK
// ============================================================

function isWorkingDay() {
  const day = new Date().getDay();
  return day >= 1 && day <= 4; // Mon–Thu
}


// ============================================================
// RETRY WRAPPER
// ============================================================

function fetchWithRetry(url, options, retries) {
  retries = retries || 3;
  for (var i = 0; i < retries; i++) {
    try {
      const response = UrlFetchApp.fetch(url, options);
      const code = response.getResponseCode();
      if (code === 200 || code === 201) return response;
      Logger.log('Attempt ' + (i + 1) + ' failed (' + code + ') — ' + (i < retries - 1 ? 'retrying...' : 'giving up.'));
    } catch(e) {
      Logger.log('Attempt ' + (i + 1) + ' threw: ' + e + ' — ' + (i < retries - 1 ? 'retrying...' : 'giving up.'));
    }
    if (i < retries - 1) Utilities.sleep(2000);
  }
  return null;
}


// ============================================================
// MAIN — called by the time-driven trigger
// ============================================================

function processZoomTranscripts() {
  if (!isWorkingDay()) {
    Logger.log('Not a working day — skipping.');
    return;
  }

  const hour = new Date().getHours();
  if (hour < ZOOM_CONFIG.START_HOUR || hour >= ZOOM_CONFIG.END_HOUR) {
    Logger.log('Outside working hours — skipping.');
    return;
  }

  const props  = PropertiesService.getScriptProperties();
  const apiKey = props.getProperty('CLAUDE_API_KEY');
  if (!apiKey) throw new Error('CLAUDE_API_KEY not set.');

  const zoomToken = getZoomAccessToken();
  const users     = getZoomUsers(zoomToken);
  Logger.log('Zoom users found: ' + users.length);

  let processedIds = [];
  try {
    const stored = props.getProperty('ZOOM_PROCESSED_IDS');
    if (stored) processedIds = JSON.parse(stored);
  } catch(e) { processedIds = []; }

  let newProcessed = false;

  for (const user of users) {
    const recordings = getRecentRecordings(zoomToken, user.id);
    Logger.log('Recordings for ' + user.email + ': ' + recordings.length);

    for (const meeting of recordings) {

      const topic = (meeting.topic || '').toLowerCase();
      if (topic.indexOf('huddle') === -1 && topic.indexOf('kpi') === -1) {
        Logger.log('Skipping (not Huddle or KPI): ' + meeting.topic);
        continue;
      }

      if ((meeting.duration || 0) < 2) {
        Logger.log('Skipping (too short, ' + meeting.duration + ' min): ' + meeting.topic);
        continue;
      }

      if (processedIds.includes(meeting.uuid)) {
        Logger.log('Already processed: ' + meeting.topic);
        continue;
      }

      const transcript = getTranscript(zoomToken, meeting);
      if (!transcript) {
        Logger.log('No transcript for: ' + meeting.topic);
        continue;
      }

      Logger.log('Summarising: ' + meeting.topic);
      const summary   = summariseWithClaude(apiKey, transcript, meeting.topic);
      const attendees = getAttendees(zoomToken, meeting.id);

      prependToMeetingsDoc(summary, meeting.topic, meeting.start_time);
      postSummaryToBasecamp(summary, meeting.topic, meeting.start_time, attendees);

      processedIds.push(meeting.uuid);
      newProcessed = true;
      Utilities.sleep(1000);
    }
  }

  if (newProcessed) {
    props.setProperty('ZOOM_PROCESSED_IDS', JSON.stringify(processedIds.slice(-100)));
  }

  Logger.log('Zoom processing complete.');
}


// ============================================================
// TEST — bypasses day/time checks, processes last 25 hours
// ============================================================

function testZoomToBasecamp() {
  Logger.log('=== TEST RUN — day/time checks bypassed ===');

  const props  = PropertiesService.getScriptProperties();
  const apiKey = props.getProperty('CLAUDE_API_KEY');
  if (!apiKey) throw new Error('CLAUDE_API_KEY not set.');

  const zoomToken = getZoomAccessToken();
  const users     = getZoomUsers(zoomToken);
  Logger.log('Zoom users found: ' + users.length);

  let processedIds = [];
  try {
    const stored = props.getProperty('ZOOM_PROCESSED_IDS');
    if (stored) processedIds = JSON.parse(stored);
  } catch(e) { processedIds = []; }

  let newProcessed = false;

  for (const user of users) {
    const recordings = getRecentRecordings(zoomToken, user.id);
    Logger.log('Recordings for ' + user.email + ': ' + recordings.length);

    for (const meeting of recordings) {

      const topic = (meeting.topic || '').toLowerCase();
      if (topic.indexOf('huddle') === -1 && topic.indexOf('kpi') === -1) {
        Logger.log('Skipping (not Huddle or KPI): ' + meeting.topic);
        continue;
      }

      if ((meeting.duration || 0) < 2) {
        Logger.log('Skipping (too short): ' + meeting.topic);
        continue;
      }

      if (processedIds.includes(meeting.uuid)) {
        Logger.log('Already processed: ' + meeting.topic);
        continue;
      }

      const transcript = getTranscript(zoomToken, meeting);
      if (!transcript) {
        Logger.log('No transcript for: ' + meeting.topic);
        continue;
      }

      Logger.log('Summarising: ' + meeting.topic);
      const summary   = summariseWithClaude(apiKey, transcript, meeting.topic);
      const attendees = getAttendees(zoomToken, meeting.id);

      Logger.log('Summary preview: ' + summary.substring(0, 200));
      Logger.log('Attendees: ' + attendees.join(', '));

      prependToMeetingsDoc(summary, meeting.topic, meeting.start_time);
      postSummaryToBasecamp(summary, meeting.topic, meeting.start_time, attendees);

      processedIds.push(meeting.uuid);
      newProcessed = true;
    }
  }

  if (newProcessed) {
    props.setProperty('ZOOM_PROCESSED_IDS', JSON.stringify(processedIds.slice(-100)));
  }

  Logger.log('=== Test complete ===');
}


// ============================================================
// ZOOM AUTH — Server-to-Server OAuth
// ============================================================

function getZoomAccessToken() {
  const props        = PropertiesService.getScriptProperties();
  const accountId    = props.getProperty('ZOOM_ACCOUNT_ID');
  const clientId     = props.getProperty('ZOOM_CLIENT_ID');
  const clientSecret = props.getProperty('ZOOM_CLIENT_SECRET');

  if (!accountId || !clientId || !clientSecret) {
    throw new Error('Zoom credentials missing. Check ZOOM_ACCOUNT_ID, ZOOM_CLIENT_ID, ZOOM_CLIENT_SECRET.');
  }

  const credentials = Utilities.base64Encode(clientId + ':' + clientSecret);
  const response = UrlFetchApp.fetch(
    'https://zoom.us/oauth/token?grant_type=account_credentials&account_id=' + accountId,
    {
      method: 'POST',
      muteHttpExceptions: true,
      headers: {
        'Authorization': 'Basic ' + credentials,
        'Content-Type':  'application/x-www-form-urlencoded',
      },
    }
  );

  if (response.getResponseCode() !== 200) {
    throw new Error('Zoom auth failed (' + response.getResponseCode() + '): ' + response.getContentText());
  }

  const data = JSON.parse(response.getContentText());
  if (!data.access_token) throw new Error('No access token in Zoom response.');
  return data.access_token;
}


// ============================================================
// GET ZOOM USERS
// ============================================================

function getZoomUsers(token) {
  Utilities.sleep(500);
  const response = fetchWithRetry(
    'https://api.zoom.us/v2/users?status=active&page_size=50',
    {
      muteHttpExceptions: true,
      headers: { 'Authorization': 'Bearer ' + token },
    }
  );

  if (!response) throw new Error('getZoomUsers failed after retries.');
  return JSON.parse(response.getContentText()).users || [];
}


// ============================================================
// GET RECENT RECORDINGS (last 25 hours)
// ============================================================

function getRecentRecordings(token, userId) {
  Utilities.sleep(500);
  const from = new Date(Date.now() - 25 * 60 * 60 * 1000);
  const to   = new Date();

  const fmt = function(d) {
    return Utilities.formatDate(d, 'UTC', 'yyyy-MM-dd');
  };

  const url = 'https://api.zoom.us/v2/users/' + userId +
    '/recordings?from=' + fmt(from) + '&to=' + fmt(to) + '&page_size=10';

  const response = fetchWithRetry(url, {
    muteHttpExceptions: true,
    headers: { 'Authorization': 'Bearer ' + token },
  });

  if (!response) {
    Logger.log('getRecentRecordings failed after retries for ' + userId);
    return [];
  }

  return JSON.parse(response.getContentText()).meetings || [];
}


// ============================================================
// GET TRANSCRIPT (VTT file, stripped to clean text)
// ============================================================

function getTranscript(token, meeting) {
  const files   = meeting.recording_files || [];
  const vttFile = files.find(function(f) {
    return f.file_type === 'TRANSCRIPT' || f.file_extension === 'VTT';
  });

  if (!vttFile || !vttFile.download_url) return null;

  const url      = vttFile.download_url + '?access_token=' + token;
  const response = fetchWithRetry(url, { muteHttpExceptions: true });

  if (!response) {
    Logger.log('Transcript download failed after retries.');
    return null;
  }

  const vtt  = response.getContentText();
  const text = vtt
    .split('\n')
    .filter(function(line) {
      return line.trim() !== '' &&
             line.trim() !== 'WEBVTT' &&
             !/^\d+$/.test(line.trim()) &&
             !/^\d{2}:\d{2}:\d{2}/.test(line.trim()) &&
             !/^<v /.test(line.trim());
    })
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();

  return text.length > 0 ? text : null;
}


// ============================================================
// GET ATTENDEES
// ============================================================

function getAttendees(token, meetingId) {
  Utilities.sleep(500);
  const url = 'https://api.zoom.us/v2/report/meetings/' + meetingId + '/participants?page_size=50';

  const response = fetchWithRetry(url, {
    muteHttpExceptions: true,
    headers: { 'Authorization': 'Bearer ' + token },
  });

  if (!response) {
    Logger.log('getAttendees failed after retries.');
    return [];
  }

  const participants = JSON.parse(response.getContentText()).participants || [];

  const seen  = {};
  const names = [];
  for (const p of participants) {
    const firstName = (p.name || '').split(' ')[0];
    if (firstName && !seen[firstName]) {
      seen[firstName] = true;
      names.push(firstName);
    }
  }
  return names;
}


// ============================================================
// SUMMARISE WITH CLAUDE
// ============================================================

function summariseWithClaude(apiKey, transcript, topic) {
  const prompt =
    'You are summarising a team meeting transcript for a small digital business called Uncommon Knowledge Ltd.\n\n' +
    'Meeting: ' + topic + '\n\n' +
    'Produce a structured summary with these three sections:\n\n' +
    '**Decisions**\n' +
    'Bullet points of what was agreed or decided. If nothing was decided, write "None noted."\n\n' +
    '**Tasks**\n' +
    'Grouped by owner. Format: Owner: task description. If no tasks were assigned, write "None noted."\n\n' +
    '**Strategic Note**\n' +
    'One or two sentences only, and only if a genuine strategic shift or significant business decision occurred. ' +
    'If nothing strategic happened, write "None."\n\n' +
    'Preserve all proper nouns exactly as spoken. Be concise and factual.\n\n' +
    'TRANSCRIPT:\n' + transcript.substring(0, 12000);

  const resp = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
    method: 'post',
    muteHttpExceptions: true,
    headers: {
      'x-api-key':         apiKey,
      'anthropic-version': '2023-06-01',
      'content-type':      'application/json',
    },
    payload: JSON.stringify({
      model:      'claude-sonnet-4-6',
      max_tokens: 1000,
      messages:   [{ role: 'user', content: prompt }],
    }),
  });

  if (resp.getResponseCode() !== 200) {
    throw new Error('Claude API failed (' + resp.getResponseCode() + '): ' + resp.getContentText());
  }

  let summary = JSON.parse(resp.getContentText()).content[0].text;

  // Correct known transcript mishearings
  summary = summary.replace(/\bOpen Social\b/g, 'Oban Social');
  summary = summary.replace(/\bClod\b/g, 'Claude');

  return summary;
}


// ============================================================
// BUILD ATTENDEE MENTIONS for Basecamp @tagging
// ============================================================

function buildAttendeeMentions(attendees) {
  const mentions  = [];
  const unmatched = [];

  for (const attendee of attendees) {
    const firstName = (typeof attendee === 'string' ? attendee : attendee.name).split(' ')[0].toLowerCase();
    const person    = BC_PEOPLE[firstName];

    if (person && person.sgid !== 'FILL_IN') {
      mentions.push(
        '<bc-attachment sgid="' + person.sgid + '" content-type="application/vnd.basecamp.mention">' +
        '<figure>@' + person.name + '</figure>' +
        '</bc-attachment>'
      );
    } else {
      unmatched.push(typeof attendee === 'string' ? attendee : attendee.name);
    }
  }

  return { mentions, unmatched };
}


// ============================================================
// WRITE TO MEETING SUMMARIES GOOGLE DOC
// ============================================================

function prependToMeetingsDoc(summary, topic, startTime) {
  try {
    const doc  = DocumentApp.openById(ZOOM_CONFIG.MEETINGS_DOC_ID);
    const body = doc.getBody();

    const dateStr  = Utilities.formatDate(new Date(startTime), 'Europe/London', 'dd MMMM yyyy \'at\' HH:mm');
    const heading  = '=== ' + topic + ' — ' + dateStr + ' ===';
    const newEntry = heading + '\n\n' + summary + '\n\n';

    const existing = body.getText().trim();
    body.setText(existing.length > 0 ? newEntry + existing : newEntry);

    Logger.log('Meeting Summaries doc updated: ' + heading);
  } catch(e) {
    Logger.log('Could not write to Meeting Summaries doc: ' + e);
  }
}


// ============================================================
// POST TO BASECAMP AS COMMENT ON TASK
// ============================================================

function postSummaryToBasecamp(summary, topic, startTime, attendees) {
  Utilities.sleep(2000);
  const token = PropertiesService.getScriptProperties().getProperty('BASECAMP_ACCESS_TOKEN');
  if (!token) {
    Logger.log('No Basecamp token — skipping post.');
    return;
  }

  const { mentions, unmatched } = buildAttendeeMentions(attendees);

  const dateStr = Utilities.formatDate(new Date(startTime), 'Europe/London', 'dd MMMM yyyy');
  const timeStr = Utilities.formatDate(new Date(startTime), 'Europe/London', 'HH:mm');

  const summaryHtml = summary
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .split('\n\n')
    .map(function(para) { return '<p>' + para.replace(/\n/g, '<br>') + '</p>'; })
    .join('\n');

  let attendeeLine = '';
  if (mentions.length > 0 || unmatched.length > 0) {
    attendeeLine = '<p><strong>Attendees:</strong> ';
    if (mentions.length > 0) attendeeLine += mentions.join(' ');
    if (unmatched.length > 0) {
      if (mentions.length > 0) attendeeLine += ' ';
      attendeeLine += unmatched.join(', ');
    }
    attendeeLine += '</p>';
  }

  const content =
    '<p><strong>' + topic + '</strong> — ' + dateStr + ' at ' + timeStr + '</p>\n' +
    attendeeLine + '\n' +
    summaryHtml;

  const url = 'https://3.basecampapi.com/' + ZOOM_CONFIG.ACCOUNT_ID +
              '/buckets/' + ZOOM_CONFIG.BC_PROJECT_ID +
              '/recordings/' + ZOOM_CONFIG.BC_TASK_ID +
              '/comments.json';

  const resp = fetchWithRetry(url, {
    method: 'post',
    muteHttpExceptions: true,
    headers: {
      'Authorization': 'Bearer ' + token,
      'User-Agent':    ZOOM_CONFIG.BASECAMP_UA,
      'Content-Type':  'application/json',
    },
    payload: JSON.stringify({ content }),
  });

  if (!resp) {
    Logger.log('Basecamp post failed after retries: ' + topic);
    return;
  }

  const code = resp.getResponseCode();
  if (code === 201) {
    Logger.log('Basecamp comment posted: ' + topic);
    if (unmatched.length > 0) Logger.log('Unmatched attendees: ' + unmatched.join(', '));
  } else {
    Logger.log('Basecamp post failed (' + code + '): ' + resp.getContentText());
  }
}


// ============================================================
// HELPER — log Basecamp people to find SGIDs for BC_PEOPLE
// ============================================================

function logBasecampPeople() {
  const token = PropertiesService.getScriptProperties().getProperty('BASECAMP_ACCESS_TOKEN');
  const url   = 'https://3.basecampapi.com/' + ZOOM_CONFIG.ACCOUNT_ID + '/people.json';

  const response = fetchWithRetry(url, {
    muteHttpExceptions: true,
    headers: {
      'Authorization': 'Bearer ' + token,
      'User-Agent':    ZOOM_CONFIG.BASECAMP_UA,
    },
  });

  if (!response) {
    Logger.log('Could not fetch Basecamp people.');
    return;
  }

  const people = JSON.parse(response.getContentText());
  for (const p of people) {
    Logger.log(p.name + ' | sgid: ' + p.attachable_sgid);
  }
}


// ============================================================
// TRIGGER SETUP
// ============================================================

function createZoomTrigger() {
  ScriptApp.getProjectTriggers()
    .filter(function(t) { return t.getHandlerFunction() === 'processZoomTranscripts'; })
    .forEach(function(t) { ScriptApp.deleteTrigger(t); });

  ScriptApp.newTrigger('processZoomTranscripts')
    .timeBased()
    .everyHours(2)
    .create();

  Logger.log('Trigger created: processZoomTranscripts every 2 hours.');
}