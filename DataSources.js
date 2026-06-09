// ============================================================
// DATA SOURCES — Compass, KPI notes, Paid Traffic notes,
//                Meeting summaries, Corrections, History
// ============================================================

function getCompanyCompass() {
  const docId = PropertiesService.getScriptProperties().getProperty('COMPASS_DOC_ID');
  const doc   = DocumentApp.openById(docId);
  return doc.getBody().getText();
}

function getKpiNotes() {
  try {
    const docId = PropertiesService.getScriptProperties().getProperty('KPI_DOC_ID');
    const doc   = DocumentApp.openById(docId);
    const text  = doc.getBody().getText();

    if (!text || text.trim().length === 0) {
      Logger.log('KPI doc appears empty.');
      return '[KPI notes unavailable]';
    }

    const teamNames     = ['Paul', 'Ruairidh', 'Mark', 'Lyndsay', 'Roger', 'Rebekah'];
    const namePattern   = teamNames.join('|');
    const headerPattern = new RegExp(
      '^(' + namePattern + ')\\s+(\\d{1,2}(?:st|nd|rd|th)\\s+(?:January|February|March|April|May|June|July|August|September|October|November|December)(?:\\s+\\d{4})?)\\s*$',
      'gm'
    );

    const headers = [];
    let match;
    while ((match = headerPattern.exec(text)) !== null) {
      headers.push({ name: match[1], date: match[2].trim(), index: match.index });
    }

    if (headers.length === 0) {
      Logger.log('No team headers found in KPI doc. Returning first 5000 chars.');
      return text.substring(0, 5000);
    }

    const currentDate     = headers[0].date;
    const previousMeeting = headers.find(h => h.date !== currentDate);

    let recentBlock;
    if (previousMeeting) {
      const cutoff = text.lastIndexOf('\n', previousMeeting.index);
      recentBlock  = text.substring(0, cutoff).trim();
    } else {
      recentBlock = text.trim();
    }

    if (recentBlock.length > 6000) {
      recentBlock = recentBlock.substring(0, 6000) + '\n[...KPI notes truncated]';
    }

    Logger.log('KPI notes extracted (' + currentDate + '): ' + recentBlock.length + ' chars');
    return recentBlock;

  } catch (e) {
    Logger.log('Could not read KPI doc: ' + e);
    return '[KPI notes unavailable]';
  }
}

function getPaidTrafficNotes() {
  try {
    const props        = PropertiesService.getScriptProperties();
    const docId        = props.getProperty('PAID_TRAFFIC_DOC_ID');
    const lastSeenDate = props.getProperty('PAID_TRAFFIC_LAST_DATE') || '';

    const doc  = DocumentApp.openById(docId);
    const text = doc.getBody().getText();

    if (!text || text.trim().length === 0) {
      Logger.log('Paid traffic doc appears empty.');
      return null;
    }

    const headerPattern = /^(\d{1,2})\/(\d{2})\/(\d{2,4})\s*$/gm;
    const entries = [];
    let m;

    while ((m = headerPattern.exec(text)) !== null) {
      const day   = parseInt(m[1], 10);
      const month = parseInt(m[2], 10) - 1;
      let   year  = parseInt(m[3], 10);
      if (year < 100) year += 2000;

      const date    = new Date(year, month, day);
      const dateKey = Utilities.formatDate(date, 'Europe/London', 'yyyy-MM-dd');

      entries.push({ dateKey, index: m.index, dateObj: date });
    }

    if (entries.length === 0) {
      Logger.log('No date headers found in paid traffic doc.');
      return null;
    }

    entries.sort((a, b) => b.dateObj - a.dateObj);

    const newEntry = entries.find(e => e.dateKey > lastSeenDate);

    if (!newEntry) {
      Logger.log('Paid traffic doc: no new entries since last seen (' + lastSeenDate + ').');
      return null;
    }

    const nextOlder = entries.find(e => e.index < newEntry.index);
    const blockEnd  = nextOlder ? nextOlder.index : text.length;
    let block       = text.substring(newEntry.index, blockEnd).trim();

    if (block.length > 4000) {
      block = block.substring(0, 4000) + '\n[...Paid traffic notes truncated]';
    }

    props.setProperty('PAID_TRAFFIC_LAST_DATE', newEntry.dateKey);

    Logger.log('Paid traffic notes extracted (' + newEntry.dateKey + '): ' + block.length + ' chars');
    return block;

  } catch (e) {
    Logger.log('Could not read paid traffic doc: ' + e);
    return null;
  }
}

function getMeetingSummaries() {
  try {
    const docId = PropertiesService.getScriptProperties().getProperty('MEETINGS_DOC_ID');
    const doc   = DocumentApp.openById(docId);
    const text  = doc.getBody().getText().trim();

    if (!text || text.length === 0) {
      Logger.log('Meeting summaries doc is empty.');
      return null;
    }

    const separator = /={3}\s*.+?—\s*\d{1,2}\s+\w+\s+\d{4}.+?={3}/g;
    const headings  = [];
    let m;
    while ((m = separator.exec(text)) !== null) {
      headings.push({ heading: m[0], index: m.index });
    }

    if (headings.length === 0) {
      Logger.log('No meeting headings found. Returning raw text (first 4000 chars).');
      return text.substring(0, 4000);
    }

    const cutoffDate   = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const recentBlocks = [];

    for (let i = 0; i < headings.length; i++) {
      const start = headings[i].index;
      const end   = headings[i + 1] ? headings[i + 1].index : text.length;
      const block = text.substring(start, end).trim();

      const dateMatch = headings[i].heading.match(/(\d{1,2}\s+\w+\s+\d{4})/);
      if (dateMatch) {
        const blockDate = new Date(dateMatch[1]);
        if (blockDate >= cutoffDate) {
          recentBlocks.push(block);
        }
      }
    }

    if (recentBlocks.length === 0) {
      Logger.log('No meeting summaries in the last 7 days.');
      return null;
    }

    let summaries = recentBlocks.join('\n\n');
    if (summaries.length > 5000) {
      summaries = summaries.substring(0, 5000) + '\n[...Meeting summaries truncated]';
    }

    Logger.log('Meeting summaries loaded: ' + recentBlocks.length + ' meeting(s), ' + summaries.length + ' chars');
    return summaries;

  } catch (e) {
    Logger.log('Could not read meeting summaries doc: ' + e);
    return null;
  }
}

function getStandingCorrections() {
  try {
    const docId = PropertiesService.getScriptProperties().getProperty('CORRECTIONS_DOC_ID');
    const doc   = DocumentApp.openById(docId);
    const text  = doc.getBody().getText().trim();

    if (!text || text.length === 0) {
      Logger.log('Standing corrections doc is empty.');
      return null;
    }

    Logger.log('Standing corrections loaded: ' + text.length + ' chars');
    return text;

  } catch (e) {
    Logger.log('Could not read corrections doc: ' + e);
    return null;
  }
}

function getBriefingHistory() {
  try {
    const docId = PropertiesService.getScriptProperties().getProperty('HISTORY_DOC_ID');
    const doc   = DocumentApp.openById(docId);
    const text  = doc.getBody().getText().trim();

    if (!text || text.length === 0) {
      Logger.log('Briefing history doc is empty — first run.');
      return null;
    }

    const separator = /={3}\s*BRIEFING:\s*[\d]+ \w+ \d{4}\s*={3}/g;
    const headings  = [];
    let m;
    while ((m = separator.exec(text)) !== null) {
      headings.push({ heading: m[0], index: m.index });
    }

    if (headings.length === 0) {
      Logger.log('No briefing headings found in history doc.');
      return null;
    }

    const recentHeadings = headings.slice(0, CONFIG.HISTORY_WEEKS);
    const blocks = recentHeadings.map((h, i) => {
      const start = h.index;
      const end   = recentHeadings[i + 1] ? recentHeadings[i + 1].index : text.length;
      return text.substring(start, end).trim();
    });

    let history = blocks.join('\n\n');
    if (history.length > 6000) {
      history = history.substring(0, 6000) + '\n[...History truncated]';
    }

    Logger.log('Briefing history loaded: ' + recentHeadings.length + ' briefing(s), ' + history.length + ' chars');
    return history;

  } catch (e) {
    Logger.log('Could not read briefing history: ' + e);
    return null;
  }
}