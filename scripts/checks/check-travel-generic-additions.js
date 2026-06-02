const baseUrl = process.env.TRAVELPILOT_TEST_BASE_URL || 'http://localhost:3000';

async function post(path, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`${path} failed: ${response.status} ${await response.text()}`);
  }
  return response.json();
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function proposal(result) {
  return result.travelItinerary?.planning_response?.proposals?.[0] || result.planning_response?.proposals?.[0] || null;
}

function names(result) {
  return proposal(result)?.ordered_poi_names || [];
}

function pois(result) {
  return proposal(result)?.pois || [];
}

function foodPois(result) {
  return pois(result).filter((poi) => poi.poi_type === 'food');
}

function routeDiff(result) {
  return result.travelItinerary?.planning_response?.route_patch_summary || result.planning_response?.route_patch_summary || {};
}

function hasAgent(result, agentKey) {
  return Array.isArray(result.agentTrace) && result.agentTrace.some((entry) => entry.agent_key === agentKey);
}

async function createProject(projectId, capabilityId = 'culture_route') {
  await post('/api/projects', {
    project_id: projectId,
    name: projectId,
    initialPrompt: '',
    travelCapabilityId: capabilityId,
  });
}

async function act(projectId, instruction, capabilityId = 'culture_route', suffix = Date.now().toString(36)) {
  return post(`/api/chat/${projectId}/act`, {
    instruction,
    displayInstruction: instruction,
    travelCapabilityId: capabilityId,
    requestId: `${projectId}-${suffix}`,
  });
}

async function main() {
  const cultureProjectId = `project-generic-additions-culture-${Date.now().toString(36)}`;
  await createProject(cultureProjectId, 'culture_route');
  const seed = await act(cultureProjectId, '故宫附近安排4小时文化路线，少走路，预算100以内，不吃饭', 'culture_route', 'seed');
  assert(seed.status === 'travel_plan_completed', `seed should plan, got ${seed.status}`);
  const before = names(seed);
  assert(before.length >= 3, `seed should have at least 3 stops: ${before.join(' -> ')}`);

  const genericAdd = await act(cultureProjectId, '再加一个顺路的景点，原来的点都保留', 'culture_route', 'generic-add');
  const genericAfter = names(genericAdd);
  const genericAdded = genericAfter.filter((name) => !before.includes(name));
  assert(genericAdd.status === 'travel_replan_completed', `generic add should replan, got ${genericAdd.status}`);
  assert(genericAfter.length === before.length + 1, `generic add should add exactly one stop: ${before.join(' -> ')} => ${genericAfter.join(' -> ')}`);
  for (const original of before) assert(genericAfter.includes(original), `generic add should preserve original stop: ${original}`);
  assert(genericAdded.length === 1, `generic add should expose exactly one added name: ${genericAdded.join(', ')}`);
  assert(!foodPois(genericAdd).some((poi) => genericAdded.includes(poi.name)), `generic scenic add should not add food: ${genericAdded[0]}`);
  assert(routeDiff(genericAdd).added?.includes(genericAdded[0]), 'generic add should write added stop to route_patch_summary');
  assert(hasAgent(genericAdd, 'route_composition_agent'), 'generic add should include route composition agent trace');

  const slashProjectId = `project-generic-additions-slash-${Date.now().toString(36)}`;
  await createProject(slashProjectId, 'culture_route');
  const slashSeed = await act(slashProjectId, '故宫附近安排4小时文化路线，少走路，预算100以内，不吃饭', 'culture_route', 'seed');
  const slashBefore = names(slashSeed);
  assert(slashSeed.status === 'travel_plan_completed', `slash seed should plan, got ${slashSeed.status}`);
  assert(slashBefore.length >= 3, `slash seed should have at least 3 stops: ${slashBefore.join(' -> ')}`);

  const slashAdd = await act(slashProjectId, '/再加一个顺路的景点，原来的点都保留', 'culture_route', 'slash-add');
  const slashAfter = names(slashAdd);
  assert(slashAdd.status === 'travel_replan_completed', `slash add should replan, got ${slashAdd.status}`);
  assert(slashAfter.length === slashBefore.length + 1, `slash add should add exactly one stop: ${slashBefore.join(' -> ')} => ${slashAfter.join(' -> ')}`);
  for (const original of slashBefore) assert(slashAfter.includes(original), `slash add should preserve original stop: ${original}`);

  const addLunchToCulture = await act(cultureProjectId, '再加一个顺路的午餐地点，原来的点都保留', 'culture_route', 'add-lunch');
  const lunchNames = names(addLunchToCulture);
  const lunchStops = foodPois(addLunchToCulture);
  assert(addLunchToCulture.status === 'travel_replan_completed', `add lunch to no-food route should replan, got ${addLunchToCulture.status}`);
  assert(lunchStops.length === 1, `add lunch should insert exactly one food stop: ${lunchNames.join(' -> ')}`);
  assert(lunchStops[0]?.meal_slot === 'lunch', `added food should be lunch: ${JSON.stringify(lunchStops[0])}`);
  for (const original of before) assert(lunchNames.includes(original), `add lunch should preserve original stop: ${original}`);

  const mealProjectId = `project-generic-additions-meal-${Date.now().toString(36)}`;
  await createProject(mealProjectId, 'mixed_food_route');
  const mealSeed = await act(mealProjectId, '前门附近玩4小时，中午吃饭，想吃好但不想排队，预算200以内，少走路', 'mixed_food_route', 'seed');
  assert(mealSeed.status === 'travel_plan_completed', `meal seed should plan, got ${mealSeed.status}`);
  assert(foodPois(mealSeed).length >= 1, 'meal seed should include a food stop');

  const ambiguousLunch = await act(mealProjectId, '再加一个顺路的午餐地点，原来的点都保留', 'mixed_food_route', 'ambiguous-lunch');
  assert(ambiguousLunch.status === 'travel_clarification_required', `existing lunch add should clarify, got ${ambiguousLunch.status}`);
  assert(ambiguousLunch.needsClarification === true, 'existing lunch add should mark needsClarification');
  assert(hasAgent(ambiguousLunch, 'clarification_agent'), 'existing lunch add should include clarification agent trace');

  console.log('[travel-generic-additions] passed');
  console.log(`generic add: ${before.join(' -> ')} => ${genericAfter.join(' -> ')}`);
  console.log(`add lunch: ${lunchNames.join(' -> ')}`);
}

main().catch((error) => {
  console.error('[travel-generic-additions] failed:', error);
  process.exit(1);
});
