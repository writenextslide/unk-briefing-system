// ============================================================
// Compass.gs — Compass-related functions
// Part of the UNK Weekly MD Briefing system
// ============================================================


// ============================================================
// FETCH COMPANY COMPASS
// ============================================================

function getCompanyCompass() {
  try {
    const docId = PropertiesService.getScriptProperties().getProperty('COMPASS_DOC_ID');
    const doc   = DocumentApp.openById(docId);
    const text  = doc.getBody().getText();
    return text.length > 8000 ? text.substring(0, 8000) + '\n[...Compass truncated]' : text;
  } catch (e) {
    Logger.log('Could not read Compass doc: ' + e);
    return '[Company Compass unavailable]';
  }
}


// ============================================================
// APPEND TO COMPASS INTELLIGENCE LOG
// Adds a dated entry for any strategic flags identified
// by Claude this week. Source is recorded per flag.
// ============================================================

function appendToCompassLog(flagsText) {
  try {
    const docId   = PropertiesService.getScriptProperties().getProperty('COMPASS_LOG_ID');
    const doc     = DocumentApp.openById(docId);
    const body    = doc.getBody();
    const dateStr = Utilities.formatDate(new Date(), 'Europe/London', 'dd MMMM yyyy');
    const heading = '=== WEEK OF ' + dateStr + ' ===';
    const newEntry = heading + '\n\n' + flagsText.trim() + '\n\n';

    const existingText = body.getText().trim();
    if (existingText.length === 0) {
      body.setText(newEntry);
    } else {
      body.setText(newEntry + '\n\n' + existingText);
    }

    Logger.log('Compass Intelligence Log updated (' + dateStr + ')');

  } catch (e) {
    Logger.log('Could not write to Compass Intelligence Log: ' + e);
  }
}