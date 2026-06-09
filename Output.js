// ============================================================
// OUTPUT — email, briefing history, compass log
// ============================================================

function sendBriefingEmail(briefingText, eventCount, hasCompassFlags) {
  const props   = PropertiesService.getScriptProperties();
  const dateStr = Utilities.formatDate(new Date(), 'Europe/London', 'dd MMMM yyyy');
  const subject = 'UNK Weekly Briefing — ' + dateStr;

  const compassDocId  = props.getProperty('COMPASS_DOC_ID');
  const correctionsId = props.getProperty('CORRECTIONS_DOC_ID');
  const meetingsId    = props.getProperty('MEETINGS_DOC_ID');
  const historyId     = props.getProperty('HISTORY_DOC_ID');
  const logId         = props.getProperty('COMPASS_LOG_ID');

  const htmlBriefing = briefingText
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g,     '<em>$1</em>')
    .replace(/\n\n/g, '</p><p style="margin:0 0 14px">')
    .replace(/\n/g,   '<br>');

  const compassFlagsBanner = hasCompassFlags
    ? '<div style="margin:0 0 24px;padding:14px 18px;background:#fff8e6;border-left:4px solid #e6a817;border-radius:4px;font-size:14px;color:#7a5c00;">' +
      '⚑ &nbsp;<strong>Compass flags logged this week.</strong> &nbsp;' +
      '<a href="https://docs.google.com/document/d/' + logId + '/edit" style="color:#7a5c00;">View Compass Intelligence Log →</a>' +
      '</div>'
    : '';

  const htmlBody =
    '<!DOCTYPE html><html><head><meta charset="UTF-8"></head>' +
    '<body style="margin:0;padding:0;background:#f5f5f0;font-family:Georgia,serif;">' +
    '<div style="max-width:640px;margin:32px auto;background:#ffffff;border-radius:8px;overflow:hidden;border:1px solid #e0dfd8;">' +

    '<div style="background:#2c2c2a;padding:24px 32px;">' +
    '<div style="font-size:11px;letter-spacing:0.1em;text-transform:uppercase;color:#888;margin-bottom:6px;">Uncommon Knowledge Ltd</div>' +
    '<div style="font-size:22px;font-weight:500;color:#ffffff;">Weekly MD Briefing</div>' +
    '<div style="font-size:13px;color:#aaa;margin-top:4px;">' + dateStr + ' &nbsp;·&nbsp; ' + eventCount + ' Basecamp events reviewed</div>' +
    '</div>' +

    '<div style="padding:28px 32px;font-size:15px;line-height:1.75;color:#2c2c2a;">' +
    compassFlagsBanner +
    '<p style="margin:0 0 14px">' + htmlBriefing + '</p>' +
    '</div>' +

    '<div style="padding:16px 32px;border-top:1px solid #e0dfd8;font-size:12px;color:#aaa;">' +
    '<a href="https://docs.google.com/document/d/' + compassDocId  + '/edit" style="color:#aaa;text-decoration:none;">Company Compass</a>' +
    ' &nbsp;·&nbsp; ' +
    '<a href="https://docs.google.com/document/d/' + correctionsId + '/edit" style="color:#aaa;text-decoration:none;">Standing Corrections</a>' +
    ' &nbsp;·&nbsp; ' +
    '<a href="https://docs.google.com/document/d/' + meetingsId    + '/edit" style="color:#aaa;text-decoration:none;">Meeting Summaries</a>' +
    ' &nbsp;·&nbsp; ' +
    '<a href="https://docs.google.com/document/d/' + historyId     + '/edit" style="color:#aaa;text-decoration:none;">Briefing History</a>' +
    ' &nbsp;·&nbsp; ' +
    '<a href="https://docs.google.com/document/d/' + logId         + '/edit" style="color:#aaa;text-decoration:none;">Compass Log</a>' +
    '</div>' +

    '</div></body></html>';

  GmailApp.sendEmail(CONFIG.RECIPIENT, subject, briefingText, { htmlBody, name: 'UNK Briefing' });
  Logger.log('Email sent to ' + CONFIG.RECIPIENT);
}

function appendToBriefingHistory(briefingText) {
  try {
    const docId   = PropertiesService.getScriptProperties().getProperty('HISTORY_DOC_ID');
    const doc     = DocumentApp.openById(docId);
    const body    = doc.getBody();
    const dateStr = Utilities.formatDate(new Date(), 'Europe/London', 'dd MMMM yyyy');
    const heading = '=== BRIEFING: ' + dateStr + ' ===';
    const newEntry = heading + '\n\n' + briefingText + '\n\n';

    const existingText = body.getText().trim();
    if (existingText.length === 0) {
      body.setText(newEntry);
    } else {
      body.setText(newEntry + existingText);
    }

    Logger.log('Briefing appended to history doc (' + dateStr + ')');

  } catch (e) {
    Logger.log('Could not write to briefing history: ' + e);
  }
}

function appendToCompassLog(compassFlags) {
  try {
    const docId   = PropertiesService.getScriptProperties().getProperty('COMPASS_LOG_ID');
    const doc     = DocumentApp.openById(docId);
    const body    = doc.getBody();
    const dateStr = Utilities.formatDate(new Date(), 'Europe/London', 'dd MMMM yyyy');
    const heading = '=== WEEK OF: ' + dateStr + ' ===';
    const newEntry = heading + '\n\n' + compassFlags + '\n\n';

    const existingText = body.getText().trim();
    if (existingText.length === 0) {
      body.setText(newEntry);
    } else {
      body.setText(newEntry + existingText);
    }

    Logger.log('Compass flags appended to log (' + dateStr + ')');

  } catch (e) {
    Logger.log('Could not write to compass log: ' + e);
  }
}