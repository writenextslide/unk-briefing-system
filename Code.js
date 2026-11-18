// ============================================================
// UNK Weekly MD Briefing — v7
// ============================================================
// Entry points only. All logic lives in separate files:
//   Config.gs       — constants, doc IDs, trigger setup
//   Basecamp.gs     — OAuth and activity fetch
//   DataSources.gs  — Compass, KPI, Paid Traffic, Meetings, History
//   Claude.gs       — prompt construction and API call
//   Output.gs       — email, briefing history, compass log
// ============================================================

function runWeeklyBriefing() {
  try {
    Logger.log('--- UNK Weekly Briefing v7 starting ---');

    const compass          = getCompanyCompass();
    const kpiNotes         = getKpiNotes();
    const paidTrafficNotes = getPaidTrafficNotes();
    const meetingSummaries = getMeetingSummaries();
    const corrections      = getStandingCorrections();
    const history          = getBriefingHistory();
    const events           = getBasecampActivity();
    const { briefing, compassFlags } = callClaude(events, compass, kpiNotes, paidTrafficNotes, meetingSummaries, corrections, history);

    sendBriefingEmail(briefing, events.length, !!compassFlags);
    appendToBriefingHistory(briefing);

    if (compassFlags) {
      appendToCompassLog(compassFlags);
    }

    Logger.log('--- Done ---');

  } catch (err) {
    Logger.log('FATAL ERROR: ' + err.toString());

    const isAuthError = err.toString().indexOf('AUTH_EXPIRED') !== -1;

    const subject = isAuthError
      ? 'UNK Briefing — Basecamp connection needs renewing'
      : 'UNK Briefing Script — ERROR';

    const body = isAuthError
      ? 'The weekly briefing didn\'t run because the Basecamp connection has expired.\n\n' +
        'This is normal — it happens periodically and takes about 2 minutes to fix.\n\n' +
        'TO FIX:\n\n' +
        '1. Go to https://script.google.com and open the UNK Briefing script\n\n' +
        '2. In the function dropdown at the top, select "setupBasecampOAuth" and click Run\n\n' +
        '3. Open the Execution Log (View > Logs). You will see a long URL beginning with https://launchpad.37signals.com\n\n' +
        '4. Copy that URL and paste it into your browser\n\n' +
        '5. Log in to Basecamp when prompted and click Allow\n\n' +
        '6. You should see a green "Basecamp connected successfully!" message\n\n' +
        '7. The briefing will run automatically next Monday as normal\n\n' +
        'If you want this week\'s briefing immediately, select "testRun" in the dropdown and click Run.\n\n' +
        '---\nTechnical detail: ' + err.toString()
      : 'The weekly briefing script failed with an unexpected error.\n\n' +
        'Error:\n' + err.toString() +
        '\n\nCheck the execution log:\nhttps://script.google.com';

    try {
      GmailApp.sendEmail(CONFIG.RECIPIENT, subject, body);
    } catch (e) {
      Logger.log('Could not send error email: ' + e);
    }
  }
}

function testRun() {
  Logger.log('=== TEST RUN — history write disabled ===');

  try {
    const compass          = getCompanyCompass();
    const kpiNotes         = getKpiNotes();
    const paidTrafficNotes = getPaidTrafficNotes();
    const meetingSummaries = getMeetingSummaries();
    const corrections      = getStandingCorrections();
    const history          = getBriefingHistory();
    const events           = getBasecampActivity();
    const { briefing, compassFlags } = callClaude(events, compass, kpiNotes, paidTrafficNotes, meetingSummaries, corrections, history);

    sendBriefingEmail(briefing, events.length, !!compassFlags, CONFIG.TEST_RECIPIENT);

    if (compassFlags) {
      Logger.log('--- Compass flags (not written in test mode) ---');
      Logger.log(compassFlags);
    }

    Logger.log('--- Test complete (history and compass log not written) ---');

  } catch (err) {
    Logger.log('FATAL ERROR: ' + err.toString());
  }
}