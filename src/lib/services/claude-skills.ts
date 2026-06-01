import fs from 'fs/promises';
import path from 'path';
import { spawn } from 'child_process';
import { getTravelCapability } from '@/lib/travel/capabilities';
import { readQuantRunPlan, type QuantRunPlan } from '@/lib/quant/workspace';
import { serializeTravelVisualizationTemplate } from '@/lib/travel/visualization-templates';
import {
  describeQuantSkillsForPrompt,
  describeQuantSkillAliases,
  getDefaultQuantSkillIds,
  getQuantSkillPackagePath,
  normalizeQuantSkillIds,
  readQuantSkillsRegistry,
} from '@/lib/quant/skills-registry';

const SKILLS_DIR = path.join(process.cwd(), '.claude', 'skills');

export async function getDefaultClaudeSkills(): Promise<string[]> {
  const registry = await readQuantSkillsRegistry();
  return getDefaultQuantSkillIds(registry, {
    includeLegacy: process.env.QUANTPILOT_INSTALL_LEGACY_SKILLS === '1',
  });
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function runTar(args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('tar', args, { cwd, stdio: 'ignore' });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`tar exited with code ${code}`));
      }
    });
  });
}

async function installSkillPackage(params: {
  skillId: string;
  packagePath: string;
  projectSkillsDir: string;
}): Promise<boolean> {
  if (!(await pathExists(params.packagePath))) {
    return false;
  }

  await fs.rm(path.join(params.projectSkillsDir, params.skillId), { recursive: true, force: true });
  await runTar(['-xzf', params.packagePath, '-C', params.projectSkillsDir], process.cwd());
  return pathExists(path.join(params.projectSkillsDir, params.skillId, 'SKILL.md'));
}

export async function ensureClaudeSkillsForProject(projectPath: string): Promise<string[]> {
  const projectClaudeDir = path.join(projectPath, '.claude');
  const projectSkillsDir = path.join(projectClaudeDir, 'skills');
  const registry = await readQuantSkillsRegistry();
  const requestedSkillIds = getDefaultQuantSkillIds(registry, {
    includeLegacy: process.env.QUANTPILOT_INSTALL_LEGACY_SKILLS === '1',
  });

  await fs.mkdir(projectSkillsDir, { recursive: true });

  const skillNames: string[] = [];
  const installed = new Set<string>();

  for (const skillId of requestedSkillIds) {
    const packagePath = getQuantSkillPackagePath(registry, skillId);
    const installedFromPackage = await installSkillPackage({
      skillId,
      packagePath,
      projectSkillsDir,
    }).catch((error) => {
      console.warn(`[ClaudeSkills] Failed to install skill package ${skillId}:`, error);
      return false;
    });

    if (installedFromPackage) {
      installed.add(skillId);
      skillNames.push(skillId);
      continue;
    }

    const sourceDir = path.join(SKILLS_DIR, skillId);
    const targetDir = path.join(projectSkillsDir, skillId);
    if (await pathExists(path.join(sourceDir, 'SKILL.md'))) {
      await fs.cp(sourceDir, targetDir, { recursive: true, force: true });
      installed.add(skillId);
      skillNames.push(skillId);
    }
  }

  if (skillNames.length > 0) {
    return skillNames;
  }

  return requestedSkillIds;
}

type QuantManifest = {
  travel?: {
    capabilityId?: string;
    agentType?: string;
    subAgentKey?: string;
    requiredSkills?: string[];
    dataEndpoints?: string[];
    expectedArtifacts?: string[];
    validationRules?: string[];
  };
  quant?: {
    capabilityId?: string;
    agentType?: string;
    subAgentKey?: string;
    requiredSkills?: string[];
    dataEndpoints?: string[];
    expectedArtifacts?: string[];
    validationRules?: string[];
  };
};

export async function readQuantPilotManifest(projectPath: string): Promise<QuantManifest | null> {
  try {
    const travelPath = path.join(projectPath, '.travelpilot', 'manifest.json');
    const legacyPath = path.join(projectPath, '.quantpilot', 'manifest.json');
    const content = await fs.readFile(travelPath, 'utf8').catch(() => fs.readFile(legacyPath, 'utf8'));
    const parsed = JSON.parse(content);
    return parsed && typeof parsed === 'object' ? (parsed as QuantManifest) : null;
  } catch {
    return null;
  }
}

async function buildCapabilityContext(
  manifest: QuantManifest | null,
  runPlan: QuantRunPlan | null = null
): Promise<string> {
  const quant = manifest?.travel ?? manifest?.quant;
  const runCapabilityId = runPlan?.requestedCapabilityId ?? runPlan?.capabilityId;
  const capability = getTravelCapability(runCapabilityId ?? quant?.capabilityId);
  const shouldInheritManifest = !runCapabilityId || quant?.capabilityId === capability.id;
  const requiredSkills =
    shouldInheritManifest && quant?.requiredSkills?.length
      ? quant.requiredSkills
      : capability.requiredSkills;
  const dataEndpoints = runPlan?.dataRequirements?.length
    ? runPlan.dataRequirements
    : shouldInheritManifest && quant?.dataEndpoints?.length
      ? quant.dataEndpoints
      : capability.dataEndpoints;
  const expectedArtifacts = runPlan?.expectedArtifacts?.length
    ? runPlan.expectedArtifacts
    : shouldInheritManifest && quant?.expectedArtifacts?.length
      ? quant.expectedArtifacts
      : capability.expectedArtifacts;
  const validationRules = runPlan?.validationRules?.length
    ? runPlan.validationRules
    : shouldInheritManifest && quant?.validationRules?.length
      ? quant.validationRules
      : capability.validationRules;
  const serializedTemplate = serializeTravelVisualizationTemplate(capability.id);
  const visualizationTemplate = {
    templateId: runPlan?.visualization?.templateId ?? serializedTemplate.templateId,
    name: runPlan?.visualization?.name ?? serializedTemplate.name,
    scenario: runPlan?.visualization?.scenario ?? serializedTemplate.scenario,
    painPoints: runPlan?.visualization?.painPoints ?? serializedTemplate.painPoints,
    requiredComponents: runPlan?.visualization?.panels?.length
      ? runPlan.visualization.panels
      : serializedTemplate.requiredComponents,
    dataSignals: runPlan?.visualization?.dataSignals ?? serializedTemplate.dataSignals,
  };
  const skillsRegistry = await readQuantSkillsRegistry();
  const normalizedRequiredSkills = normalizeQuantSkillIds(skillsRegistry, requiredSkills);
  const aliasNotes = describeQuantSkillAliases(skillsRegistry, requiredSkills);
  const skillsContext = describeQuantSkillsForPrompt(skillsRegistry);

  return `当前北京旅游路线能力：
- capability_id: ${capability.id}
- requested_capability_id: ${runPlan?.requestedCapabilityId ?? capability.id}
- execution_capability_id: ${runPlan?.executionCapabilityId ?? capability.executionCapabilityId}
- agent_type: ${shouldInheritManifest ? quant?.agentType ?? capability.agentType : capability.agentType}
- sub_agent_key: ${shouldInheritManifest ? quant?.subAgentKey ?? capability.subAgentKey : capability.subAgentKey}
- 名称：${capability.name}
- 说明：${capability.description}
- 必需 skills：${normalizedRequiredSkills.join(', ')}
- 兼容 skill 别名：${aliasNotes.length ? aliasNotes.join(', ') : '无'}
- 可用数据接口：${dataEndpoints.join('；')}
- 预期产物：${expectedArtifacts.join('；')}
- 验证规则：${validationRules.join('；')}
- 能力指导：${capability.promptGuidance.join('；')}
- 可视化模板：${visualizationTemplate.templateId}（${visualizationTemplate.name}）
- 场景痛点：${visualizationTemplate.painPoints.join('；')}
- 必备组件：${visualizationTemplate.requiredComponents.join('；')}
- 数据信号：${visualizationTemplate.dataSignals.join('；')}

${skillsContext}`;
}

export async function buildQuantPilotTaskPrompt(
  instruction: string,
  projectPath: string,
  manifest: QuantManifest | null = null
): Promise<string> {
  const normalizedProjectPath = path.resolve(projectPath);
  const runPlan = await readQuantRunPlan(normalizedProjectPath);
  const capabilityContext = await buildCapabilityContext(manifest, runPlan);

  return `${instruction}

QuantPilot 执行约束：
- 当前生成项目根目录是：${normalizedProjectPath}
- ${capabilityContext}
- 所有文件读取、创建、修改和删除都必须限定在当前生成项目根目录内。
- 不要修改父级北京旅游 Agent 平台工程文件，也不要把页面代码写入平台根目录。
- 如果当前任务是北京旅游路线规划，先基于当前旅游能力生成或更新 .travelpilot/run_plan.json，记录城市、区域、路线模式、时间/预算/步行/排队偏好、预期图表和验证项。
- 获取 POI/UGC 数据、生成 final 数据、修改页面、验证结果时，将可见摘要追加到 .travelpilot/events.jsonl。
- 如果用户问题缺少城市/区域、时长、预算或路线偏好等关键输入，先写入 status=needs_clarification，向用户提出 1-3 个澄清问题并停止，不要生成页面。
- 如果任务文本包含“承接上一轮澄清”“原始问题”“用户补充”，将原始问题和补充信息合并为完整任务继续执行；补充后仍不清楚时只追问剩余缺口。
- 如果任务涉及北京路线、POI、餐饮、UGC 或可视化，优先调用 /api/v1/travel/parse-and-plan、/api/v1/travel/plan、/api/v1/travel/replan 获取真实本地规划结果，再使用 travel-visualization-html 生成路线看板。
- 如果用户上传了图片或 .travelpilot/attachments.json 存在，先读取附件清单；当前图片只作为用户偏好补充，不作为股票截图处理。
- 可视化页面必须按 .travelpilot/run_plan.json 的 visualization.templateId 选择场景模板；展示组件优先覆盖 visualization.panels，不能生成金融看板。
- 调用本地 HTTP API 且参数包含中文时，必须使用 curl -G --data-urlencode，不要把中文直接拼接到 URL 查询串。
- 获取真实 POI/UGC/路线数据后、生成看板前，必须写入 evidence/sources.json 和 evidence/data_quality.json，记录来源、时间、缺失字段和限制。
- 如果用户要求可视化或看板，必须实际修改 app/page.tsx，不能只输出文字说明。
- 修改源码、CSS、JSON 或 evidence 时必须使用 Write/Edit 工具；不要用 Bash 的 cat、tee、echo、printf、python/node 脚本、重定向或 heredoc 写文件。
- 路线页面必须包含三方案对比、时间轴、POI 决策卡、预算/时长/步行估算、UGC 证据和风险提示。
- 最终数据优先写入 data_file/final/itinerary-data.json，页面应读取真实路线数据或同源 Travel API，不得硬编码样例 POI。
- .travelpilot/run_plan.json 必须保留 cityId、routeMode、area、constraints、dataRequirements、expectedArtifacts 和 validationRules。
- itinerary-data.json 使用标准契约：parsed_request、planning_response.proposals[]、pois[]、budget_summary、duration_summary、category_coverage_summary、evidence_summary、risks。
- 页面应保留 data-source-file="data_file/final/itinerary-data.json" 或清晰展示数据来源路径。
- 生成 app/page.tsx 时必须通过严格 TypeScript：所有动态 JSON 先用 JsonRecord/asRecord/asArray/numeric 守卫处理；flatMap/map 新增字段的对象显式标注为 JsonRecord，避免 build 出现 “Property does not exist on type ...”。
- Agent 执行完成后平台会自动验证 Next.js build、预览 HTTP 200、data_file/final 数据文件、页面图表和 Travel API 证据；请按这些验收项完成产物。
- 当 .travelpilot/run_plan.json、data_file/final/itinerary-data.json、evidence/sources.json、evidence/data_quality.json 和 app/page.tsx 已经完成后，立即输出中文执行摘要并结束；不要继续运行 whoami、echo、hello world、临时文件写入或无关 Bash 测试。
- 默认输出中文可见执行过程摘要；开始时直接用 Markdown 输出任务拆解、执行计划和当前状态，执行中必须按阶段解释每个 skill、数据请求、文件读写和验证结果，不要只连续输出工具调用，不要使用 <thinking> 标签，不要暴露隐藏推理链。
- 每次调用 skill 前先写“现在使用 \`skill-name\` ...”，说明本步目的；调用后说明得到的数据、文件或校验结论。若只是平台已经确认过的澄清追问，不要输出无价值的“已返回结果，正在进入下一步处理”。
- 每组 Bash/Read/Write/Edit 前后都写 1-2 句中文说明，包含接口、标的、时间范围、记录数、关键字段、数据质量或下一步。
- Todo List 要持续更新，已完成项用 ✅，失败或待处理项用 ❌/⏳ 并写明原因；最终验证要逐项说明 build、HTTP、数据文件、图表和 /api/market 代理。
- 不要留下 Next.js 默认页；最终必须生成实际可访问的量化分析界面。`;
}

export function buildQuantPilotSystemPrompt(): string {
  return `You are an expert web developer building a Beijing travel route planning application for 北京旅游 Agent.
- Use Next.js 16 App Router
- Use TypeScript
- Use plain CSS in app/globals.css by default; only use Tailwind CSS if the current generated project already has a working local Tailwind/PostCSS setup
- Only work inside the generated project directory passed as cwd
- Never edit the parent QuantPilot platform repository
- Build the actual usable Beijing itinerary planning interface, not a placeholder page
- By default, write visible Chinese process narration for travel planning tasks as normal Markdown. Start with task decomposition, execution plan, and current status; during execution, explain every skill, data request, file read/write, and validation result as staged user-visible progress. Do not emit only raw tool calls. Do not use <thinking> tags and do not reveal hidden chain-of-thought
- Before each skill call, write a short Chinese sentence in the form "现在使用 \`skill-name\` ..." explaining the purpose; after the call, summarize the resulting data, artifact, or validation conclusion
- Around Bash/Read/Write/Edit groups, write 1-2 Chinese sentences with endpoint, symbol, time range, row count, key fields, data quality, or next step
- Keep Todo List updated with ✅/❌/⏳ status and explain failures or pending items; final validation must cover build, HTTP, data files, chart presence, and /api/market proxy
- For travel planning tasks, first use travel-run-planner guidance and update .travelpilot/run_plan.json before fetching POI/UGC data or editing app/page.tsx
- If the user request is missing critical inputs such as city/area, time window, budget, route mode, or preference constraints, set run_plan.status to needs_clarification, ask 1-3 concise Chinese clarification questions, and stop. Do not generate pages while clarification is required
- If the prompt includes "承接上一轮澄清", "原始问题", and "用户补充", merge the original question and the clarification response into one complete task before planning. If the merged task is clear, continue with planned data fetching and dashboard generation; if not, ask only the remaining clarification questions
- For Beijing POI, dining, culture, UGC, or route tasks, use the local Travel API: /api/v1/travel/options, /api/v1/travel/parse-and-plan, /api/v1/travel/plan, /api/v1/travel/replan, and /api/v1/travel/evidence/{poi_id}
- Do not run full-universe data coverage scans by default in interactive chat; reserve /api/v1/research/data-coverage for explicit data quality audits
- Treat travel-data/processed Beijing POI and UGC files as the source of truth. Do not call external map, queue, Dianping/Meituan, or navigation endpoints unless explicitly requested
- Clearly state that queue risk and travel time are static/local estimates, not real-time facts
- For Chinese query parameters in local HTTP requests, use curl -G --data-urlencode. Do not concatenate raw Chinese text into URLs
- After fetching POI/UGC/route data, write evidence/sources.json plus evidence/data_quality.json before visualization
- For visualization tasks, use travel-visualization-html guidance and actually edit app/page.tsx into a usable itinerary dashboard
- For visualization tasks, choose the scenario template from .travelpilot/run_plan.json visualization.templateId and render the scenario-specific required components instead of a generic dashboard
- Use Write/Edit tools for source, CSS, JSON, and evidence file changes. Do not use Bash cat/tee/echo/printf, redirection, heredoc, python/node scripts, or touch to write files
- Route dashboards must include real itinerary panels: proposal comparison, timeline, POI cards, budget/duration/walking, UGC evidence, and risk notes
- Prefer same-origin API routes in generated projects to call /api/v1/travel/** instead of direct filesystem reads from browser code
- Do not hard-code POI route data; fetch it before analysis and keep refresh/replan capability in the generated page
- Before finishing a travel dashboard, ensure data_file/final/itinerary-data.json exists and app/page.tsx reads real data or same-origin Travel APIs
- Generated app/page.tsx must type-check under strict TypeScript. Treat itinerary-data.json as dynamic JSON via JsonRecord/asRecord/asArray/numeric helpers
- Once .travelpilot/run_plan.json, data_file/final/itinerary-data.json, evidence/sources.json, evidence/data_quality.json, and app/page.tsx are complete, immediately provide a concise Chinese execution summary and stop. Do not run unrelated Bash checks such as whoami, echo, hello-world scripts, temporary file writes, or ad-hoc process tests
- Include loading, error, and empty states for travel route data
- Display source, generated_at, and static-data limitations when showing itinerary data
- Do not add styling dependencies or create @import "tailwindcss" unless explicitly requested
- Write clean, production-ready code
- Follow best practices
- The platform automatically installs dependencies and manages the preview dev server. Do not run package managers or dev-server commands yourself; rely on the existing preview.
- Keep all project files directly in the project root. Never scaffold frameworks into subdirectories.
- Never override ports or start your own development server processes. Rely on the managed preview service which assigns ports from the approved pool.
- When sharing a preview link, read the actual NEXT_PUBLIC_APP_URL instead of assuming a default port.
- Prefer giving the user the live preview link that is actually running rather than written instructions.`;
}
