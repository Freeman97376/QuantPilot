const baseUrl = process.env.TRAVELPILOT_TEST_BASE_URL || 'http://localhost:3000';

async function post(pathname, body) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${pathname} failed: ${response.status} ${text}`);
  return text ? JSON.parse(text) : null;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function dailyRoutes(result) {
  const planning = result.travelItinerary?.planning_response || result.planning_response || {};
  return Array.isArray(planning.daily_itinerary) ? planning.daily_itinerary : [];
}

async function runCase(label, instruction, expectedDays) {
  const projectId = `project-multiday-${label}-${Date.now().toString(36)}`;
  await post('/api/projects', {
    project_id: projectId,
    name: projectId,
    initialPrompt: '',
    travelCapabilityId: 'mixed_food_route',
  });
  const result = await post(`/api/chat/${projectId}/act`, {
    instruction,
    displayInstruction: instruction,
    travelCapabilityId: 'mixed_food_route',
    requestId: `${projectId}-seed`,
  });
  const planning = result.travelItinerary?.planning_response || result.planning_response || {};
  const days = dailyRoutes(result);
  assert(result.status === 'travel_plan_completed', `${label}: should complete planning, got ${result.status}`);
  assert(Number(planning.day_count) === expectedDays, `${label}: expected day_count ${expectedDays}, got ${planning.day_count}`);
  assert(days.length === expectedDays, `${label}: expected ${expectedDays} daily_itinerary items, got ${days.length}`);
  const routeSignatures = days.map((day) => (day.proposal?.ordered_poi_names || []).join(' -> '));
  for (const [index, signature] of routeSignatures.entries()) {
    assert(signature.split(' -> ').filter(Boolean).length >= 3, `${label}: day ${index + 1} should have >=3 POIs: ${signature}`);
  }
  assert(new Set(routeSignatures).size > 1, `${label}: multi-day routes should not all be identical: ${routeSignatures.join(' || ')}`);
  return {
    label,
    day_count: planning.day_count,
    resolved_area: planning.resolved_area,
    routes: routeSignatures,
    elapsed_ms: planning.generation_metrics?.sla?.elapsed_ms ?? planning.generation_metrics?.elapsed_ms,
  };
}

async function main() {
  const rows = [];
  rows.push(await runCase('five-day-summer-palace', '五天玩颐和园，想吃好吃的。', 5));
  rows.push(await runCase('four-day-beihai-hotel', '4天在北海附近慢慢玩，住酒店，想吃点靠谱的，不要太累。', 4));
  console.log('[travel-multiday-itinerary] passed');
  for (const row of rows) {
    console.log(JSON.stringify(row, null, 2));
  }
}

main().catch((error) => {
  console.error('[travel-multiday-itinerary] failed:', error);
  process.exit(1);
});
