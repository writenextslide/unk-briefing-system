// ============================================================
// CONFIG — constants, doc IDs, trigger setup
// ============================================================

const CONFIG = {
  RECIPIENT:        'roger.elliott@unk.com,mark.tyrrell@unk.com,lyndsay.elliott@unk.com,paul.galbraith@unk.com',
  TEST_RECIPIENT:   'roger.elliott@unk.com',   // test runs email only this address
  ACCOUNT_ID:       '5492807',
  HISTORY_WEEKS:    3,
  DAYS_BACK:        7,
  CLAUDE_MODEL:     'claude-sonnet-4-6',
  BASECAMP_UA:      'UNK Briefing Script (roger.elliott@unk.com)',
  KPI_TEAM_NAMES:   ['Paul', 'Ruairidh', 'Mark', 'Lyndsay', 'Roger'],
  // Private Basecamp projects — never read, never reported.
  // Matched by name, ignoring upper/lower case. Add more names here if needed.
  EXCLUDED_PROJECTS: ['Elliott Family'],
};

// Doc IDs live in Script Properties:
// COMPASS_DOC_ID, COMPASS_LOG_ID, KPI_DOC_ID,
// PAID_TRAFFIC_DOC_ID, MEETINGS_DOC_ID, CORRECTIONS_DOC_ID, HISTORY_DOC_ID

function storeDocIds() {
  const props = PropertiesService.getScriptProperties();
  props.setProperty('COMPASS_DOC_ID',        '1Z0T3GH5UOcarxfOO9BST3aNq-kmLSrFEFykfPX7QTxQ');
  props.setProperty('COMPASS_LOG_ID',        '1H6qiriUsDEhD_l9lWE08-XiYQdSXfGGx8YzV_8btpTs');
  props.setProperty('KPI_DOC_ID',            '1NvrGI4jP4bwg5haJax1gsx1i-7GZ-TIFchwJB1A_XhQ');
  props.setProperty('PAID_TRAFFIC_DOC_ID',   '1C45HoWjbudpSYjFoOE2xVl3nbX2fYK55HfN4st2eanQ');
  props.setProperty('MEETINGS_DOC_ID',       '1UP4wlpXL1cBnb0f32ZF4hbCKQcHlw2BasgJqooia0JU');
  props.setProperty('CORRECTIONS_DOC_ID',    '1C_nLxCXJP5kG9PqQYV3KPeNtgBhVEgC46d6AFgrk9cE');
  props.setProperty('HISTORY_DOC_ID',        '1C-iPZSDXebRlwBFMl2Mj-c_WFcODXISMnwV75X0AuY0');
  Logger.log('Doc IDs stored.');
}

function createTrigger() {
  ScriptApp.getProjectTriggers().forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('runWeeklyBriefing')
    .timeBased()
    .onWeekDay(ScriptApp.WeekDay.MONDAY)
    .atHour(7)
    .create();
  Logger.log('Trigger created: runWeeklyBriefing every Monday at 7am.');
}