// ============================================================
// CLAUDE — prompt construction and API call
// ============================================================

function callClaude(events, compass, kpiNotes, paidTrafficNotes, meetingSummaries, corrections, history) {
  const apiKey = PropertiesService.getScriptProperties().getProperty('CLAUDE_API_KEY');
  if (!apiKey) throw new Error('CLAUDE_API_KEY not set in Script Properties.');

  const eventsText = events.length > 0
    ? events.map(e =>
        '[' + e.project + '] ' + e.creator + ' · ' + e.action +
        (e.type   ? ' (' + e.type  + ')' : '') + ': "' + e.title + '"' +
        (e.bucket ? ' · in ' + e.bucket : '') + ' · ' +
        new Date(e.created_at).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })
      ).join('\n')
    : 'No Basecamp activity recorded this week.';

  const correctionsSection = corrections
    ? '\n\nSTANDING CORRECTIONS — confirmed facts that override anything contradictory in Basecamp or elsewhere. Apply silently without drawing attention to them:\n---\n' + corrections + '\n---'
    : '';

  const kpiSection = kpiNotes && kpiNotes !== '[KPI notes unavailable]'
    ? '\n\nKPI MEETING NOTES (most recent 6-weekly meeting):\n---\n' + kpiNotes + '\n---\n\n' +
      'Use KPI notes as ground truth for project status at the time of that meeting.'
    : '';

  const paidTrafficSection = paidTrafficNotes
    ? '\n\nPAID TRAFFIC MEETING NOTES (latest entry from Paul\'s weekly meeting):\n---\n' + paidTrafficNotes + '\n---\n\n' +
      'The paid traffic notes record decisions and performance data from the weekly meeting between Roger and Paul ' +
      'covering Facebook, Google Ads, LinkedIn, and other paid acquisition activity. Use them to:\n' +
      '- Understand what is actually running in paid traffic this week and at what cost/performance\n' +
      '- Identify paid traffic decisions that may not yet appear in Basecamp\n' +
      '- Flag any paid traffic results (positive or negative) that have strategic significance\n' +
      '- Cross-check against the Compass priorities around paid acquisition and audience growth'
    : '';

  const meetingsSection = meetingSummaries
    ? '\n\nMEETING SUMMARIES (auto-summarised from Zoom transcripts this week):\n---\n' + meetingSummaries + '\n---\n\n' +
      'Meeting summaries capture decisions and tasks from huddles and KPI sessions this week. ' +
      'Use them to:\n' +
      '- Confirm or explain Basecamp activity you can see\n' +
      '- Flag decisions made verbally that may not yet appear in Basecamp\n' +
      '- Identify tasks assigned in meetings that have not been actioned in Basecamp yet\n' +
      '- Where Basecamp and meeting summaries conflict, note both and flag for Roger\'s attention.'
    : '';

  const historySection = history
    ? '\n\nPREVIOUS BRIEFINGS (last ' + CONFIG.HISTORY_WEEKS + ' weeks — for narrative continuity only):\n---\n' + history + '\n---\n\n' +
      'Use the previous briefings to:\n' +
      '- Continue or resolve ongoing narratives rather than treating each week as isolated\n' +
      '- Flag watch points from previous weeks that still show no resolution\n' +
      '- Note when something previously flagged has now been addressed (close the loop explicitly)\n' +
      '- Identify items that have been quietly absent for several weeks and may have been dropped\n' +
      'Do not manufacture continuity where none exists. Do not repeat last week\'s briefing — synthesise across weeks.'
    : '';

  const systemPrompt =
    'You are an experienced business analyst briefing the Managing Director of Uncommon Knowledge Ltd (UNK) every Monday morning.\n\n' +
    'The UNK team members are: Roger (MD), Mark (Creative Director), Lyndsay (Finance/Social), Paul (Paid Traffic — male), Sayed (Web Admin), Rajesh (Web Dev), Murat (Development), Ola (Server/Dev), Rebekah (Customer Support), Stephanie (Editor), Simon (Accountant). Use these names exactly as written — do not alter, expand, or feminise any name.\n\n' +
    'Your job is to take the previous week\'s Basecamp activity and analyse it through the lens of the Company Compass — UNK\'s strategic priorities document. ' +
    'The MD uses this briefing to quickly understand what happened, what it means, and what needs attention before the week begins.\n\n' +
    'Briefing format (plain prose, no deep bullet nesting):\n\n' +
    '**Weekly snapshot** — 2-3 sentences on the overall tone of the week. Busy or quiet? On-track or drifting?\n\n' +
    '**By priority** — Group notable activity under the relevant Compass priority (Priority 1 HD, Priority 2 Unk Courses, etc). Only include priorities with meaningful activity.\n\n' +
    '**Things that look good** — Specific items representing clear progress against strategy.\n\n' +
    '**Watch points** — Anything stalled, missing, or potentially off-strategy. Include anything from previous weeks that remains unresolved. If meeting summaries reveal tasks assigned in meetings that have not yet appeared in Basecamp, flag these here. If a known deadline (launch, cart open/close, offer end) is approaching within 14 days and there is little or no visible Basecamp activity around it, flag that explicitly. Honest, not alarmist.\n\n' +
    '**This week: 3 things to keep an eye on** — Concrete and specific. Items most likely to need Roger\'s attention or a decision. Always include any known upcoming deadline dates visible in the activity this week — launch dates, cart open/close dates, offer end dates, event dates — stated explicitly with the date.\n\n' +
    'COMPASS FLAGS — after the main briefing, review everything you have seen this week (Basecamp activity, meeting summaries, KPI notes, paid traffic notes) and identify anything that may have strategic significance for the Company Compass. ' +
    'These are items suggesting a shift in direction, a priority being dropped or added, a significant contradiction of current Compass content, or an emerging pattern that may warrant updating the Compass at the next quarterly review. ' +
    'Operational detail does not qualify — only genuine strategic signals.\n\n' +
    'If you identify any such items, append them after the main briefing using this exact format:\n\n' +
    '===COMPASS FLAGS===\n' +
    '- [Source] Description of the strategic signal\n\n' +
    'Where [Source] is one of: [Basecamp], [Meeting], [KPI Notes], [Paid Traffic].\n\n' +
    'If there are no strategic signals this week, omit the ===COMPASS FLAGS=== section entirely.\n\n' +
    'Keep the whole briefing readable in under 5 minutes. Avoid vague praise. Be direct about gaps.\n\n' +
    'The Company Compass:\n---\n' + compass + '\n---' +
    correctionsSection +
    kpiSection +
    paidTrafficSection +
    meetingsSection +
    historySection;

  const userMessage =
    'Here is the Basecamp activity from the past 7 days (' + events.length + ' events):\n\n' +
    eventsText + '\n\nPlease produce the Monday MD briefing.';

  const resp = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
    method: 'post',
    muteHttpExceptions: true,
    headers: {
      'x-api-key':         apiKey,
      'anthropic-version': '2023-06-01',
      'content-type':      'application/json',
    },
    payload: JSON.stringify({
      model:      CONFIG.CLAUDE_MODEL,
      max_tokens: 2500,
      system:     systemPrompt,
      messages:   [{ role: 'user', content: userMessage }],
    }),
  });

  if (resp.getResponseCode() !== 200) {
    throw new Error('Claude API failed (' + resp.getResponseCode() + '): ' + resp.getContentText());
  }

  const result   = JSON.parse(resp.getContentText());
  const usage    = result.usage;
  const fullText = result.content[0].text;

  Logger.log('Claude tokens — input: ' + usage.input_tokens + ', output: ' + usage.output_tokens + ', total: ' + (usage.input_tokens + usage.output_tokens));

  const flagMarker = '===COMPASS FLAGS===';
  const flagIndex  = fullText.indexOf(flagMarker);

  if (flagIndex !== -1) {
    const briefing     = fullText.substring(0, flagIndex).trim();
    const compassFlags = fullText.substring(flagIndex + flagMarker.length).trim();
    Logger.log('Compass flags found: ' + compassFlags.length + ' chars');
    return { briefing, compassFlags };
  }

  Logger.log('No compass flags this week.');
  return { briefing: fullText, compassFlags: null };
}