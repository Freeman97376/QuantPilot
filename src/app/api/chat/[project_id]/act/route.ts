/**
 * AI Action API Route
 * POST /api/chat/[project_id]/act - Execute AI command
 */

import { NextRequest, NextResponse } from 'next/server';
import {
  getProjectById,
  updateProject,
  updateProjectActivity,
} from '@/lib/services/project';
import { createMessage } from '@/lib/services/message';
import { getDefaultModelForCli, normalizeModelId } from '@/lib/constants/cliModels';
import { streamManager } from '@/lib/services/stream';
import type { ChatActRequest } from '@/types/backend';
import { generateProjectId } from '@/lib/utils';
import { previewManager } from '@/lib/services/preview';
import path from 'path';
import fs from 'fs/promises';
import { randomUUID } from 'crypto';
import { serializeMessage } from '@/lib/serializers/chat';
import {
  upsertUserRequest,
  markUserRequestAsProcessing,
  markUserRequestAsCompleted,
  markUserRequestAsFailed,
  isUserRequestCancelled,
} from '@/lib/services/user-requests';
import { readQuantRunPlan, writeInitialRunPlan } from '@/lib/quant/workspace';
import { prefetchQuantDataForRunPlan } from '@/lib/quant/data-prefetch';
import {
  buildQuantValidationRepairInstruction,
  validateQuantProject,
} from '@/lib/quant/validation';
import { buildClarificationContinuation, buildQuantClarificationMessage } from '@/lib/quant/intent';
import { ensureQuantDashboardTemplate } from '@/lib/utils/scaffold';
import {
  incrementQuantGenerationRepairAttempt,
  startQuantGenerationRun,
  updateQuantGenerationStep,
} from '@/lib/quant/generation-state';
import { finishQuantGenerationQueueItem, runQuantGenerationQueued } from '@/lib/quant/generation-queue';
import {
  parseAndPlanTravel,
  replanTravelRoute,
  type TravelPlanningRequest,
} from '@/lib/travel/planner';

interface RouteContext {
  params: Promise<{ project_id: string }>;
}

type CliRuntime = {
  initializeNextJsProject: (
    projectId: string,
    projectPath: string,
    instruction: string,
    model?: string,
    requestId?: string
  ) => Promise<void>;
  applyChanges: (
    projectId: string,
    projectPath: string,
    instruction: string,
    model?: string,
    sessionId?: string,
    requestId?: string,
    images?: ProcessedImageAttachment[]
  ) => Promise<void>;
};

async function loadCliRuntime(cliPreference: string): Promise<CliRuntime> {
  switch (cliPreference) {
    case 'codex':
      return import('@/lib/services/cli/codex');
    case 'cursor':
      return import('@/lib/services/cli/cursor');
    case 'qwen':
      return import('@/lib/services/cli/qwen');
    case 'glm':
      return import('@/lib/services/cli/glm');
    case 'claude':
    default:
      return import('@/lib/services/cli/claude');
  }
}

function coerceString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

const TRAVEL_CAPABILITY_IDS = new Set([
  'culture_route',
  'mixed_food_route',
  'family_low_queue',
  'budget_route',
  'efficient_route',
  'replan_compare',
]);

function isTravelCapabilityId(value?: string | null): boolean {
  return Boolean(value && TRAVEL_CAPABILITY_IDS.has(value));
}

function resolveTravelCapabilityId(value?: string | null): string {
  return isTravelCapabilityId(value) ? (value as string) : 'mixed_food_route';
}

function normalizeTravelInstructionForIntent(value: string): string {
  return value
    .trim()
    .replace(/^[/／\\]+\s*/, '')
    .replace(/^(travel|route|replan|plan)\s*[:：]\s*/i, '')
    .trim();
}

function isTravelAdjustmentText(value: string): boolean {
  const normalized = normalizeTravelInstructionForIntent(value);
  return /(预算降到|重新规划|保留|不去|别去|不要去|去掉|不要|排除|避开|取消|删除|替换|换一个|换成|改成|调整|仍然|控制在|以内)/.test(normalized);
}

function normalizeTravelName(value: unknown): string {
  return String(value || '')
    .replace(/[（）()]/g, '')
    .replace(/\s+/g, '')
    .trim()
    .toLowerCase();
}

function extractExcludedPlaceName(value: string): string | null {
  const normalized = normalizeTravelInstructionForIntent(value);
  const match = normalized.match(/(?:不去|别去|不要去?|去掉|排除|避开|取消|删除)([^，,。；;]+)/);
  if (!match?.[1]) return null;
  const candidate = match[1]
    .replace(/^(这个|那个|这里|那里|它|他|她)/, '')
    .replace(/^(地方|地点|景点|餐厅|饭店|点位|这个地方|那个地方|这个景点|那个景点)/, '')
    .replace(/^(了|吧|呀|啊|呢)/, '')
    .trim();
  return candidate.length > 0 ? candidate : null;
}

function buildTravelClarification(params: {
  text: string;
  existingItinerary: Record<string, any> | null;
}): { message: string; reason: string } | null {
  const normalizedText = normalizeTravelInstructionForIntent(params.text);
  if (!/(不去|别去|不要|去掉|排除|避开|取消|删除)/.test(normalizedText)) return null;
  const excluded = extractExcludedPlaceName(normalizedText);
  const proposal = Array.isArray(params.existingItinerary?.planning_response?.proposals)
    ? params.existingItinerary?.planning_response?.proposals?.[0]
    : null;
  const currentNames: string[] = Array.isArray(proposal?.ordered_poi_names)
    ? proposal.ordered_poi_names.map(String)
    : [];

  if (!excluded) {
    return {
      reason: 'missing_excluded_place',
      message: [
        '意图澄清 Agent：我识别到你想排除某个地点，但还缺少具体地点名称。',
        '',
        currentNames.length
          ? `当前路线包含：${currentNames.join('、')}`
          : '当前还没有可参考的路线地点。',
        '',
        '请补充一句，例如：',
        '- 不去正阳门箭楼，换一个附近文化点',
        '- 去掉瑞幸咖啡，换成适合午餐的餐厅',
      ].join('\n'),
    };
  }

  return null;
}

const PROJECTS_DIR = process.env.PROJECTS_DIR || './data/projects';
const PROJECTS_DIR_ABSOLUTE = path.isAbsolute(PROJECTS_DIR)
  ? PROJECTS_DIR
  : path.resolve(/*turbopackIgnore: true*/ process.cwd(), PROJECTS_DIR);

function resolveAssetsPath(projectId: string): string {
  return path.join(PROJECTS_DIR_ABSOLUTE, projectId, 'assets');
}

function ensureAbsoluteAssetPath(projectId: string, inputPath: string): string {
  const normalized = path.normalize(inputPath);
  if (path.isAbsolute(normalized)) {
    return normalized;
  }
  const resolvedFromCwd = path.resolve(/*turbopackIgnore: true*/ process.cwd(), normalized);
  if (resolvedFromCwd.startsWith(PROJECTS_DIR_ABSOLUTE)) {
    return resolvedFromCwd;
  }
  const projectBase = path.join(PROJECTS_DIR_ABSOLUTE, projectId);
  return path.resolve(projectBase, normalized);
}

function resolveProjectRoot(projectId: string, repoPath?: string | null): string {
  if (repoPath) {
    return path.isAbsolute(repoPath) ? repoPath : path.resolve(/*turbopackIgnore: true*/ process.cwd(), repoPath);
  }
  return path.join(PROJECTS_DIR_ABSOLUTE, projectId);
}

function buildTravelAssistantMessage(result: Record<string, any>): string {
  const planning = result.planning_response || {};
  const proposals = Array.isArray(planning.proposals) ? planning.proposals.slice(0, 3) : [];
  const lines = [
    '# Beijing travel itinerary generated',
    '',
    `Area: ${planning.resolved_area || result.parsed_request?.area || 'Beijing'}`,
    '',
  ];

  proposals.forEach((proposal: Record<string, any>, index: number) => {
    const names = Array.isArray(proposal.ordered_poi_names)
      ? proposal.ordered_poi_names.join(' -> ')
      : 'No POI candidates';
    const risks = Array.isArray(proposal.risks) && proposal.risks.length > 0
      ? proposal.risks.slice(0, 2).join('; ')
      : 'No hard constraint risk found';
    lines.push(
      `## Option ${index + 1}: ${proposal.display_title || proposal.title || proposal.strategy || 'Route option'}`,
      `- Estimated duration: ${proposal.total_route_duration_min ?? '-'} min`,
      `- Estimated budget: ${proposal.total_budget_estimate ?? '-'} CNY`,
      `- Estimated transfer/walk: ${proposal.total_transfer_minutes ?? '-'} min, ${proposal.total_walking_distance_m ?? '-'} m`,
      `- Route: ${names}`,
      `- Risks: ${risks}`,
      '',
    );
  });

  lines.push(
    'Artifacts written: data_file/final/itinerary-data.json, evidence/sources.json, evidence/data_quality.json, .travelpilot/run_plan.json.',
    'Queue, distance, and transfer time are estimated from local static POI/UGC data, not realtime navigation.',
  );
  return lines.join('\n');
}

async function writeTravelPlanArtifacts(params: {
  projectPath: string;
  requestId: string;
  capabilityId: string;
  instruction: string;
  result: Record<string, any>;
}): Promise<void> {
  const travelDir = path.join(params.projectPath, '.travelpilot');
  const finalDir = path.join(params.projectPath, 'data_file', 'final');
  const evidenceDir = path.join(params.projectPath, 'evidence');
  await fs.mkdir(travelDir, { recursive: true });
  await fs.mkdir(finalDir, { recursive: true });
  await fs.mkdir(evidenceDir, { recursive: true });

  const now = new Date().toISOString();
  const runPlan = {
    schemaVersion: 1,
    product: 'beijing-travel-agent',
    requestId: params.requestId,
    capabilityId: params.capabilityId,
    status: 'completed',
    createdAt: now,
    updatedAt: now,
    instruction: params.instruction,
    artifactPaths: {
      itinerary: 'data_file/final/itinerary-data.json',
      sources: 'evidence/sources.json',
      dataQuality: 'evidence/data_quality.json',
    },
  };

  const planning = params.result.planning_response || {};
  const dataQuality = {
    generatedAt: now,
    dataSource: 'travel-data/processed',
    realtimeData: false,
    limitations: [
      'No realtime map, realtime queue, or external review API is used.',
      'Distance and transfer time are estimated from local static data.',
    ],
    proposalCount: Array.isArray(planning.proposals) ? planning.proposals.length : 0,
    generationMetrics: planning.generation_metrics || null,
  };

  const sources = {
    generatedAt: now,
    dataSource: 'travel-data/processed',
    evidence: planning.evidence || params.result.evidence || [],
    dataFiles: [
      'beijing_planner_entities.json',
      'beijing_mixed_category_pois.json',
      'beijing_culture_pois.json',
      'beijing_poi_feature_aggregates.json',
      'beijing_review_records.json',
    ],
  };

  await fs.writeFile(path.join(travelDir, 'run_plan.json'), `${JSON.stringify(runPlan, null, 2)}\n`, 'utf8');
  await fs.writeFile(path.join(finalDir, 'itinerary-data.json'), `${JSON.stringify(params.result, null, 2)}\n`, 'utf8');
  await fs.writeFile(path.join(evidenceDir, 'sources.json'), `${JSON.stringify(sources, null, 2)}\n`, 'utf8');
  await fs.writeFile(path.join(evidenceDir, 'data_quality.json'), `${JSON.stringify(dataQuality, null, 2)}\n`, 'utf8');
}

async function readExistingTravelItinerary(projectPath: string): Promise<Record<string, any> | null> {
  const itineraryPath = path.join(projectPath, 'data_file', 'final', 'itinerary-data.json');
  try {
    const raw = await fs.readFile(itineraryPath, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      console.warn('[API] Failed to read existing travel itinerary:', error);
    }
    return null;
  }
}

function runValidationAfterExecution(params: {
  execution: Promise<void>;
  repairExecutor: (
    projectId: string,
    projectPath: string,
    instruction: string,
    model: string,
    sessionId?: string,
    requestId?: string
  ) => Promise<void>;
  projectId: string;
  projectPath: string;
  instruction: string;
  selectedModel: string;
  sessionId?: string;
  requestId: string;
  conversationId?: string | null;
  cliSource?: string | null;
}): Promise<void> {
  const validateAndRepair = async (executionError?: unknown) => {
    if (await isUserRequestCancelled(params.requestId)) {
      await updateQuantGenerationStep({
        projectPath: params.projectPath,
        projectId: params.projectId,
        requestId: params.requestId,
        stepId: 'agent_execution',
        status: 'failed',
        summary: '请求已取消，停止执行后续验证。',
        runStatus: 'cancelled',
        errorMessage: '请求已取消。',
      });
      await finishQuantGenerationQueueItem({
        projectPath: params.projectPath,
        projectId: params.projectId,
        requestId: params.requestId,
        status: 'cancelled',
        errorMessage: '请求已取消。',
      });
      return;
    }

    await updateQuantGenerationStep({
      projectPath: params.projectPath,
      projectId: params.projectId,
      requestId: params.requestId,
      stepId: 'agent_execution',
      status: executionError ? 'failed' : 'success',
      summary: executionError ? 'Agent 执行异常结束，进入验证确认产物状态。' : 'Agent 执行完成，进入自动验证。',
      ...(executionError
        ? { errorMessage: executionError instanceof Error ? executionError.message : String(executionError || 'Agent execution failed') }
        : {}),
    });
    await updateQuantGenerationStep({
      projectPath: params.projectPath,
      projectId: params.projectId,
      requestId: params.requestId,
      stepId: 'validation',
      status: 'running',
      summary: '开始自动验证生成产物。',
    });
    const firstReport = await validateQuantProject({
      projectId: params.projectId,
      projectPath: params.projectPath,
      requestId: params.requestId,
      conversationId: params.conversationId,
      cliSource: params.cliSource,
    });

    if (firstReport.passed) {
      await updateQuantGenerationStep({
        projectPath: params.projectPath,
        projectId: params.projectId,
        requestId: params.requestId,
        stepId: 'validation',
        status: 'success',
        summary: '自动验证通过。',
        metadata: {
          checkCount: firstReport.checks.length,
        },
      });
      await updateQuantGenerationStep({
        projectPath: params.projectPath,
        projectId: params.projectId,
        requestId: params.requestId,
        stepId: 'completed',
        status: 'success',
        summary: '生成链路完成。',
        runStatus: 'completed',
      });
      await finishQuantGenerationQueueItem({
        projectPath: params.projectPath,
        projectId: params.projectId,
        requestId: params.requestId,
        status: 'completed',
      });
      if (await isUserRequestCancelled(params.requestId)) {
        return;
      }
      await markUserRequestAsCompleted(params.requestId);
      if (executionError) {
        streamManager.publish(params.projectId, {
          type: 'status',
          data: {
            status: 'validation_passed_after_agent_error',
            message: 'Agent 执行异常结束，但产物自动验证已通过。',
            requestId: params.requestId,
          },
        });
      }
      return;
    }

    if (executionError) {
      if (await isUserRequestCancelled(params.requestId)) {
        return;
      }
      const message =
        executionError instanceof Error
          ? executionError.message
          : String(executionError || 'Agent execution failed');
      await markUserRequestAsFailed(
        params.requestId,
        `Agent 执行异常且自动验证未通过：${message}`
      );
    }

    const failedChecks = firstReport.checks.filter((check) => check.status === 'failed');
    await updateQuantGenerationStep({
      projectPath: params.projectPath,
      projectId: params.projectId,
      requestId: params.requestId,
      stepId: 'validation',
      status: 'failed',
      summary: `自动验证未通过：${failedChecks.length} 项失败。`,
      metadata: {
        failedChecks: failedChecks.map((check) => ({ id: check.id, summary: check.summary })),
      },
      errorMessage: `自动验证未通过：${failedChecks.length} 项失败。`,
    });

    const repairRequestId = `${params.requestId}-validation-repair`;
    const repairInstruction = buildQuantValidationRepairInstruction(firstReport, {
      originalInstruction: params.instruction,
    });
    streamManager.publish(params.projectId, {
      type: 'status',
      data: {
        status: 'validation_repairing',
        message: executionError
          ? 'Agent 执行异常结束，正在基于自动验证失败项触发修复。'
          : '自动验证未通过，正在让 Agent 根据失败项修复产物。',
        requestId: params.requestId,
        metadata: {
          repairRequestId,
          failedChecks: firstReport.checks
            .filter((check) => check.status === 'failed')
            .map((check) => ({ id: check.id, summary: check.summary })),
        },
      },
    });

    try {
      await upsertUserRequest({
        id: repairRequestId,
        projectId: params.projectId,
        instruction: repairInstruction,
        cliPreference: params.cliSource,
      });
      await markUserRequestAsProcessing(repairRequestId);
    } catch (error) {
      console.error('[API] Failed to record validation repair request:', error);
    }

    if (await isUserRequestCancelled(params.requestId)) {
      await updateQuantGenerationStep({
        projectPath: params.projectPath,
        projectId: params.projectId,
        requestId: params.requestId,
        stepId: 'repair',
        status: 'failed',
        summary: '原始请求已取消，自动修复未继续执行。',
        runStatus: 'cancelled',
        errorMessage: '原始请求已取消。',
      });
      await finishQuantGenerationQueueItem({
        projectPath: params.projectPath,
        projectId: params.projectId,
        requestId: params.requestId,
        status: 'cancelled',
        errorMessage: '原始请求已取消。',
      });
      await markUserRequestAsFailed(repairRequestId, '原始请求已取消，自动修复未继续执行。');
      return;
    }

    let repairExecutionFailed = false;
    try {
      const repairAttempt = await incrementQuantGenerationRepairAttempt({
        projectPath: params.projectPath,
        projectId: params.projectId,
        requestId: params.requestId,
      });
      await updateQuantGenerationStep({
        projectPath: params.projectPath,
        projectId: params.projectId,
        requestId: params.requestId,
        stepId: 'repair',
        status: 'running',
        summary: `第 ${repairAttempt} 次自动修复开始。`,
        runStatus: 'repairing',
        metadata: {
          repairRequestId,
          failedChecks: failedChecks.map((check) => check.id),
        },
      });
      await params.repairExecutor(
        params.projectId,
        params.projectPath,
        repairInstruction,
        params.selectedModel,
        params.sessionId,
        repairRequestId
      );
    } catch (error) {
      repairExecutionFailed = true;
      console.error('[API] Validation repair execution failed:', error);
      const message = error instanceof Error ? error.message : String(error || 'Validation repair execution failed');
      await updateQuantGenerationStep({
        projectPath: params.projectPath,
        projectId: params.projectId,
        requestId: params.requestId,
        stepId: 'repair',
        status: 'failed',
        summary: '自动修复执行失败。',
        errorMessage: message,
      });
      await markUserRequestAsFailed(repairRequestId, message);
      streamManager.publish(params.projectId, {
        type: 'status',
        data: {
          status: 'validation_repair_failed',
          message: '自动修复执行失败，正在保留最终验证报告用于排查。',
          requestId: repairRequestId,
        },
      });
    }

    if (await isUserRequestCancelled(params.requestId)) {
      if (!repairExecutionFailed) {
        await updateQuantGenerationStep({
          projectPath: params.projectPath,
          projectId: params.projectId,
          requestId: params.requestId,
          stepId: 'repair',
          status: 'failed',
          summary: '原始请求已取消，自动修复后的验证未继续执行。',
          runStatus: 'cancelled',
          errorMessage: '原始请求已取消。',
        });
        await markUserRequestAsFailed(repairRequestId, '原始请求已取消，自动修复后的验证未继续执行。');
      }
      await finishQuantGenerationQueueItem({
        projectPath: params.projectPath,
        projectId: params.projectId,
        requestId: params.requestId,
        status: 'cancelled',
        errorMessage: '原始请求已取消。',
      });
      return;
    }

    if (!repairExecutionFailed) {
      await updateQuantGenerationStep({
        projectPath: params.projectPath,
        projectId: params.projectId,
        requestId: params.requestId,
        stepId: 'repair',
        status: 'success',
        summary: '自动修复执行完成，进入修复后验证。',
      });
    }
    await updateQuantGenerationStep({
      projectPath: params.projectPath,
      projectId: params.projectId,
      requestId: params.requestId,
      stepId: 'final_validation',
      status: 'running',
      summary: '开始修复后自动验证。',
    });
    const finalReport = await validateQuantProject({
      projectId: params.projectId,
      projectPath: params.projectPath,
      requestId: repairRequestId,
      conversationId: params.conversationId,
      cliSource: params.cliSource,
    });

    if (finalReport.passed) {
      await updateQuantGenerationStep({
        projectPath: params.projectPath,
        projectId: params.projectId,
        requestId: params.requestId,
        stepId: 'final_validation',
        status: 'success',
        summary: '修复后验证通过。',
        metadata: {
          checkCount: finalReport.checks.length,
        },
      });
      await updateQuantGenerationStep({
        projectPath: params.projectPath,
        projectId: params.projectId,
        requestId: params.requestId,
        stepId: 'completed',
        status: 'success',
        summary: '生成链路经自动修复后完成。',
        runStatus: 'completed',
      });
      if (await isUserRequestCancelled(params.requestId)) {
        await markUserRequestAsFailed(repairRequestId, '原始请求已取消，自动修复结果未写回完成态。');
        await finishQuantGenerationQueueItem({
          projectPath: params.projectPath,
          projectId: params.projectId,
          requestId: params.requestId,
          status: 'cancelled',
          errorMessage: '原始请求已取消。',
        });
        return;
      }
      await finishQuantGenerationQueueItem({
        projectPath: params.projectPath,
        projectId: params.projectId,
        requestId: params.requestId,
        status: 'completed',
      });
      await markUserRequestAsCompleted(repairRequestId);
      await markUserRequestAsCompleted(params.requestId);
      return;
    }

    const finalFailedChecks = finalReport.checks.filter((check) => check.status === 'failed');
    await updateQuantGenerationStep({
      projectPath: params.projectPath,
      projectId: params.projectId,
      requestId: params.requestId,
      stepId: 'final_validation',
      status: 'failed',
      summary: `自动修复后仍未通过：${finalFailedChecks.length} 项失败。`,
      metadata: {
        failedChecks: finalFailedChecks.map((check) => ({ id: check.id, summary: check.summary })),
      },
      runStatus: 'failed',
      errorMessage: '自动修复后仍未通过平台验证。',
    });
    await markUserRequestAsFailed(
      repairRequestId,
      '自动修复后仍未通过平台验证，请查看 .quantpilot/validation.json 和 .quantpilot/validation-repair-plan.json。'
    );
    await markUserRequestAsFailed(
      params.requestId,
      '自动验证和修复后仍未通过，请查看验证摘要。'
    );
    await finishQuantGenerationQueueItem({
      projectPath: params.projectPath,
      projectId: params.projectId,
      requestId: params.requestId,
      status: 'failed',
      errorMessage: '自动验证和修复后仍未通过，请查看验证摘要。',
    });
  };

  return (async () => {
    let executionError: unknown;
    try {
      await params.execution;
    } catch (error) {
      executionError = error;
      console.error('[API] Agent execution or automatic validation failed:', error);
    }

    try {
      await validateAndRepair(executionError);
    } catch (validationError) {
      console.error('[API] Automatic validation after agent execution failed:', validationError);
      const message =
        validationError instanceof Error
          ? validationError.message
          : String(validationError || 'Automatic validation failed');
      await updateQuantGenerationStep({
        projectPath: params.projectPath,
        projectId: params.projectId,
        requestId: params.requestId,
        stepId: 'validation',
        status: 'failed',
        summary: `自动验证流程异常：${message}`,
        runStatus: 'failed',
        errorMessage: message,
      });
      await markUserRequestAsFailed(params.requestId, `自动验证失败：${message}`);
      await finishQuantGenerationQueueItem({
        projectPath: params.projectPath,
        projectId: params.projectId,
        requestId: params.requestId,
        status: 'failed',
        errorMessage: message,
      });
    }
  })();
}

async function mirrorAssetToPublic(
  projectRoot: string,
  filename: string,
  sourcePath: string,
): Promise<{ publicPath: string | null; publicUrl: string | null }> {
  const resolvedSourcePath = path.isAbsolute(sourcePath) ? sourcePath : path.resolve(/*turbopackIgnore: true*/ process.cwd(), sourcePath);
  const hostUploadsDir = path.join(/*turbopackIgnore: true*/ process.cwd(), 'public', 'uploads');
  let hostPublicPath: string | null = null;

  try {
    await fs.mkdir(hostUploadsDir, { recursive: true });
    const destinationPath = path.join(hostUploadsDir, filename);
    try {
      await fs.access(destinationPath);
    } catch {
      await fs.copyFile(resolvedSourcePath, destinationPath);
    }
    hostPublicPath = destinationPath;
  } catch (error) {
    console.warn('[API] Failed to mirror asset into application public/uploads:', error);
  }

  try {
    const uploadsDir = path.join(projectRoot, 'public', 'uploads');
    await fs.mkdir(uploadsDir, { recursive: true });
    const destinationPath = path.join(uploadsDir, filename);
    try {
      await fs.access(destinationPath);
    } catch {
      await fs.copyFile(resolvedSourcePath, destinationPath);
    }
    return {
      publicPath: hostPublicPath ?? destinationPath,
      publicUrl: hostPublicPath ? `/uploads/${filename}` : null,
    };
  } catch (error) {
    console.warn('[API] Failed to mirror asset into project public/uploads:', error);
    if (hostPublicPath) {
      return { publicPath: hostPublicPath, publicUrl: `/uploads/${filename}` };
    }
    return { publicPath: null, publicUrl: null };
  }
}

function inferExtensionFromMime(mime?: string): string {
  if (!mime) return '.png';
  const normalized = mime.toLowerCase();
  if (normalized.includes('png')) return '.png';
  if (normalized.includes('jpeg') || normalized.includes('jpg')) return '.jpg';
  if (normalized.includes('gif')) return '.gif';
  if (normalized.includes('webp')) return '.webp';
  if (normalized.includes('svg')) return '.svg';
  return '.png';
}

async function materializeBase64Image(
  projectId: string,
  projectRoot: string,
  base64: string,
  nameHint?: string,
  mimeType?: string,
): Promise<{ absolutePath: string; filename: string; publicUrl: string | null }> {
  const buffer = Buffer.from(base64, 'base64');
  const extension = inferExtensionFromMime(mimeType);
  const safeName = nameHint && nameHint.trim() ? nameHint.trim() : `image-${randomUUID()}`;
  const filename = `${safeName.replace(/[^a-zA-Z0-9-_]/g, '-') || 'image'}-${randomUUID()}${extension}`;
  const assetsDir = resolveAssetsPath(projectId);
  await fs.mkdir(assetsDir, { recursive: true });
  const absolutePath = path.join(assetsDir, filename);
  await fs.writeFile(absolutePath, buffer);
  const mirror = await mirrorAssetToPublic(projectRoot, filename, absolutePath);
  return {
    absolutePath,
    filename,
    publicUrl: mirror.publicUrl,
  };
}

type RawImageAttachment = Record<string, unknown>;

type ProcessedImageAttachment = {
  name: string;
  path: string;
  url: string;
  publicUrl?: string;
  originalName?: string;
  mimeType?: string;
  size?: number;
};

async function normalizeImageAttachment(
  projectId: string,
  projectRoot: string,
  raw: RawImageAttachment,
  index: number,
): Promise<ProcessedImageAttachment | null> {
  const name = typeof raw.name === 'string' && raw.name.trim().length > 0 ? raw.name.trim() : `Image ${index + 1}`;
  const providedUrl = typeof raw.url === 'string' && raw.url.trim().length > 0 ? raw.url.trim() : undefined;
  const providedPublicUrl =
    typeof raw.public_url === 'string' && raw.public_url.trim().length > 0
      ? raw.public_url.trim()
      : typeof raw.publicUrl === 'string' && raw.publicUrl.trim().length > 0
      ? raw.publicUrl.trim()
      : undefined;

  const pathValue =
    typeof raw.path === 'string' && raw.path.trim().length > 0 ? ensureAbsoluteAssetPath(projectId, raw.path.trim()) : null;

  const base64DataCandidate =
    typeof raw.base64_data === 'string'
      ? raw.base64_data
      : typeof raw.base64Data === 'string'
      ? raw.base64Data
      : null;

  const mimeTypeCandidate =
    typeof raw.mime_type === 'string'
      ? raw.mime_type
      : typeof raw.mimeType === 'string'
      ? raw.mimeType
      : undefined;

  if (pathValue) {
    try {
      const stat = await fs.stat(pathValue);
      const filename = path.basename(pathValue);
      let effectivePublicUrl = providedPublicUrl;
      if (!effectivePublicUrl) {
        const mirror = await mirrorAssetToPublic(projectRoot, filename, pathValue);
        effectivePublicUrl = mirror.publicUrl ?? undefined;
      }
      return {
        name,
        path: pathValue,
        url: providedUrl ?? `/api/assets/${projectId}/${filename}`,
        publicUrl: effectivePublicUrl,
        originalName: typeof raw.original_name === 'string' ? raw.original_name : undefined,
        mimeType: typeof raw.mime_type === 'string' ? raw.mime_type : typeof raw.mimeType === 'string' ? raw.mimeType : undefined,
        size: stat.size,
      };
    } catch {
      // fall through and try to materialize if base64 present
    }
  }

  if (base64DataCandidate) {
    try {
      const materialized = await materializeBase64Image(
        projectId,
        projectRoot,
        base64DataCandidate,
        name,
        mimeTypeCandidate,
      );
      return {
        name,
        path: materialized.absolutePath,
        url: providedUrl ?? `/api/assets/${projectId}/${materialized.filename}`,
        publicUrl: providedPublicUrl ?? materialized.publicUrl ?? undefined,
        mimeType: mimeTypeCandidate,
      };
    } catch (error) {
      console.error('[API] Failed to materialize base64 image:', error);
      return null;
    }
  }

  return null;
}

async function writeAttachmentContext(params: {
  projectRoot: string;
  projectId: string;
  requestId: string;
  images: ProcessedImageAttachment[];
}): Promise<string | null> {
  if (params.images.length === 0) {
    return null;
  }

  const quantDir = path.join(params.projectRoot, '.quantpilot');
  const relativePath = '.quantpilot/attachments.json';
  const absolutePath = path.join(params.projectRoot, relativePath);
  const payload = {
    schemaVersion: 1,
    projectId: params.projectId,
    requestId: params.requestId,
    createdAt: new Date().toISOString(),
    instruction: '这些图片由用户随本次问题上传。Agent 必须先读取本文件并检查图片，再解析其中的股票、持仓、成本、现金、盈亏、仓位等字段。',
    attachments: params.images.map((image, index) => ({
      id: `image-${index + 1}`,
      name: image.name,
      absolutePath: image.path,
      path: path.relative(params.projectRoot, image.path).replaceAll(path.sep, '/'),
      url: image.url,
      publicUrl: image.publicUrl ?? null,
      mimeType: image.mimeType ?? null,
      size: image.size ?? null,
    })),
    extractionContract: {
      requiredSkill: 'quant-image-extraction',
      requiredTool: 'mcp__QuantPilotImage__quant_extract_uploaded_image',
      optionalVisionTool: 'mcp__MiniMax__understand_image',
      portfolioScreenshotFields: [
        'account_total_asset',
        'cash_available',
        'market_value',
        'daily_pnl',
        'total_pnl',
        'position_ratio',
        'holdings[].name',
        'holdings[].symbol_if_visible_or_resolved',
        'holdings[].quantity',
        'holdings[].cost_price',
        'holdings[].current_price',
        'holdings[].market_value',
        'holdings[].pnl',
        'holdings[].pnl_percent',
      ],
      rule: '无法确定的截图字段必须写 null，并在 evidence/data_quality.json 说明不确定性，不允许编造。',
    },
  };

  await fs.mkdir(quantDir, { recursive: true });
  await fs.writeFile(absolutePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return relativePath;
}

function buildImageAttachmentInstruction(params: {
  attachmentContextPath: string | null;
  images: ProcessedImageAttachment[];
}): string {
  if (params.images.length === 0) {
    return '';
  }

  const imageList = params.images
    .map((image, index) => {
      const relativeHint = image.path;
      return `${index + 1}. ${image.name}：${relativeHint}`;
    })
    .join('\n');

  return `

图片附件处理要求：
- 本次用户上传了 ${params.images.length} 张图片。先读取 ${params.attachmentContextPath ?? '.quantpilot/attachments.json'}，再检查图片内容，不要忽略附件。
- 先使用 \`quant-image-extraction\` skill，并调用 \`mcp__QuantPilotImage__quant_extract_uploaded_image\` 读取附件清单、校验图片文件、生成 imageExtraction 初始结构。不要只说“我看不到图片”。
- 如果 MiniMax MCP 的 \`mcp__MiniMax__understand_image\` 可用，再用它识别截图中的股票名称、数量、成本价、现价、市值、盈亏、仓位、现金和总资产；识别不确定的字段写 null 并在证据文件中说明。
- 对识别出的股票名称必须使用 quant-symbol-resolver 或 /api/v1/symbols/resolve 解析代码，再获取真实行情、K 线、指标和必要的基本面数据。
- 必须把图片提取结果写入 evidence/image_extraction.json；没有 OCR/视觉结果时也要写明 visualRecognition.status 和 needs_manual_confirmation。
- 最终 dashboard-data.json 必须保留 portfolio、holdings、assets、comparison 和 imageExtraction 字段；imageExtraction 要说明哪些字段来自截图识别、哪些来自行情接口补全。
- 如果兼容层无法直接读取图片视觉内容，也必须基于附件清单和文件路径继续处理，并明确列出需要人工确认的截图字段。

图片路径：
${imageList}`;
}

/**
 * POST /api/chat/[project_id]/act
 * Execute AI command
 */
export async function POST(request: NextRequest, { params }: RouteContext) {
  try {
    const { project_id } = await params;
    const rawBody = await request.json().catch(() => ({}));
    const body = (rawBody && typeof rawBody === 'object' ? rawBody : {}) as ChatActRequest &
      Record<string, unknown>;

    const project = await getProjectById(project_id);
    if (!project) {
      return NextResponse.json(
        { success: false, error: 'Project not found' },
        { status: 404 },
      );
    }

    const legacyBody = body as Record<string, unknown>;
    const projectRoot = resolveProjectRoot(project_id, project.repoPath);
    const projectPath = project.repoPath || path.join(/*turbopackIgnore: true*/ process.cwd(), 'projects', project_id);
    const rawInstruction = typeof body.instruction === 'string' ? body.instruction : '';
    const rawDisplayInstruction =
      coerceString((body as Record<string, unknown>).displayInstruction) ??
      coerceString(legacyBody['display_instruction']);
    const instructionWithoutLegacyPaths = rawInstruction.replace(/\n*Image #\d+ path: [^\n]+/g, '').trim();
    const visibleInstructionWithoutLegacyPaths = (rawDisplayInstruction ?? rawInstruction)
      .replace(/\n*Image #\d+ path: [^\n]+/g, '')
      .trim();

    const conversationId =
      coerceString(body.conversationId) ?? coerceString(legacyBody['conversation_id']);

    const requestId =
      coerceString(body.requestId) ??
      coerceString(legacyBody['request_id']) ??
      generateProjectId();

    const rawImages: RawImageAttachment[] = Array.isArray((body as Record<string, unknown>).images)
      ? ((body as Record<string, unknown>).images as RawImageAttachment[])
      : Array.isArray(legacyBody['images'])
      ? (legacyBody['images'] as RawImageAttachment[])
      : [];

    const processedImages: ProcessedImageAttachment[] = [];
    for (let index = 0; index < rawImages.length; index += 1) {
      const normalized = await normalizeImageAttachment(project_id, projectRoot, rawImages[index], index);
      if (normalized) {
        processedImages.push(normalized);
      }
    }

    const attachmentContextPath = await writeAttachmentContext({
      projectRoot,
      projectId: project_id,
      requestId,
      images: processedImages,
    });
    const imageAttachmentInstruction = buildImageAttachmentInstruction({
      attachmentContextPath,
      images: processedImages,
    });
    const imageLines = processedImages.map((image, idx) => `Image #${idx + 1} path: ${image.path}`);
    const finalInstruction = [
      instructionWithoutLegacyPaths || (processedImages.length > 0 ? '请分析用户上传的图片附件。' : ''),
      imageAttachmentInstruction || imageLines.join('\n'),
    ]
      .filter((segment) => segment && segment.trim().length > 0)
      .join('\n\n')
      .trim();
    const displayInstruction =
      visibleInstructionWithoutLegacyPaths ||
      (processedImages.length > 0 ? '请分析上传的图片附件' : finalInstruction);

    if (!finalInstruction) {
      return NextResponse.json(
        { success: false, error: 'instruction or images are required' },
        { status: 400 },
      );
    }

    const cliPreferenceRaw =
      coerceString((body as Record<string, unknown>).cliPreference) ??
      coerceString(legacyBody['cli_preference']) ??
      project.preferredCli ??
      'claude';
    const cliPreference = cliPreferenceRaw.toLowerCase();

    const selectedModelRaw =
      coerceString(body.selectedModel) ??
      coerceString(legacyBody['selected_model']) ??
      project.selectedModel ??
      getDefaultModelForCli(cliPreference);
    const selectedModel = normalizeModelId(cliPreference, selectedModelRaw);

    const quantCapabilityId =
      coerceString((body as Record<string, unknown>).quantCapabilityId) ??
      coerceString(legacyBody['quant_capability_id']) ??
      coerceString((body as Record<string, unknown>).capabilityId) ??
      coerceString(legacyBody['capability_id']);

    const isInitialPrompt =
      body.isInitialPrompt === true ||
      legacyBody['is_initial_prompt'] === true ||
      legacyBody['is_initial_prompt'] === 'true';

    const travelCapabilityId =
      coerceString((body as Record<string, unknown>).travelCapabilityId) ??
      (isTravelCapabilityId(quantCapabilityId) ? quantCapabilityId : null);

    const selectedTravelCapabilityId = resolveTravelCapabilityId(travelCapabilityId);
    const existingItineraryForRequest = await readExistingTravelItinerary(projectPath);
    const shouldReplanTravel =
      !isInitialPrompt || (Boolean(existingItineraryForRequest) && isTravelAdjustmentText(displayInstruction || finalInstruction));
    const travelClarification = shouldReplanTravel
      ? buildTravelClarification({
          text: displayInstruction || finalInstruction,
          existingItinerary: existingItineraryForRequest,
        })
      : null;

    if (travelClarification) {
      let userMessageId: string | null = null;
      let assistantMessageId: string | null = null;
      try {
        const userMessage = await createMessage({
          projectId: project_id,
          role: 'user',
          messageType: 'chat',
          content: displayInstruction || finalInstruction,
          conversationId: conversationId ?? undefined,
          cliSource: 'local-travel-planner',
          requestId,
        });
        userMessageId = userMessage.id;
        const assistantMessage = await createMessage({
          projectId: project_id,
          role: 'assistant',
          messageType: 'chat',
          content: travelClarification.message,
          conversationId: conversationId ?? undefined,
          cliSource: 'local-travel-planner',
          metadata: {
            type: 'travel_clarification_required',
            reason: travelClarification.reason,
          },
          requestId,
        });
        assistantMessageId = assistantMessage.id;
        await markUserRequestAsCompleted(requestId).catch(() => {});
        streamManager.publish(project_id, {
          type: 'message',
          data: serializeMessage(userMessage, { requestId }),
        });
        streamManager.publish(project_id, {
          type: 'message',
          data: serializeMessage(assistantMessage, { requestId }),
        });
      } catch (error) {
        if (process.env.SKIP_DB_SYNC !== '1') {
          throw error;
        }
        console.warn('[API] Local travel clarification completed without database-backed chat messages.');
      }

      streamManager.publish(project_id, {
        type: 'status',
        data: {
          status: 'travel_clarification_required',
          message: travelClarification.message,
          requestId,
          metadata: {
            reason: travelClarification.reason,
          },
        },
      });

      return NextResponse.json({
        success: true,
        status: 'travel_clarification_required',
        requestId,
        userMessageId,
        assistantMessageId,
        conversationId: conversationId ?? null,
        message: travelClarification.message,
        reason: travelClarification.reason,
        needsClarification: true,
      });
    }

    if (!shouldReplanTravel) {
      const travelGoal = displayInstruction || finalInstruction;
      const travelResult = await parseAndPlanTravel({ goal: travelGoal });
      await writeTravelPlanArtifacts({
        projectPath,
        requestId,
        capabilityId: selectedTravelCapabilityId,
        instruction: travelGoal,
        result: travelResult as Record<string, any>,
      });

      let userMessageId: string | null = null;
      let assistantMessageId: string | null = null;
      try {
        const userMessage = await createMessage({
          projectId: project_id,
          role: 'user',
          messageType: 'chat',
          content: displayInstruction || finalInstruction,
          conversationId: conversationId ?? undefined,
          cliSource: 'local-travel-planner',
          requestId,
        });
        userMessageId = userMessage.id;
        const assistantMessage = await createMessage({
          projectId: project_id,
          role: 'assistant',
          messageType: 'chat',
          content: buildTravelAssistantMessage(travelResult as Record<string, any>),
          conversationId: conversationId ?? undefined,
          cliSource: 'local-travel-planner',
          metadata: {
            type: 'travel_plan_completed',
            capabilityId: selectedTravelCapabilityId,
            itineraryPath: 'data_file/final/itinerary-data.json',
            evidencePath: 'evidence/sources.json',
            runPlanPath: '.travelpilot/run_plan.json',
            generationMetrics: travelResult.planning_response.generation_metrics,
          },
          requestId,
        });
        assistantMessageId = assistantMessage.id;
        await markUserRequestAsCompleted(requestId).catch(() => {});
        streamManager.publish(project_id, {
          type: 'message',
          data: serializeMessage(userMessage, { requestId }),
        });
        streamManager.publish(project_id, {
          type: 'message',
          data: serializeMessage(assistantMessage, { requestId }),
        });
      } catch (error) {
        if (process.env.SKIP_DB_SYNC !== '1') {
          throw error;
        }
        console.warn('[API] Local travel plan completed without database-backed chat messages.');
      }

      streamManager.publish(project_id, {
        type: 'status',
        data: {
          status: 'travel_plan_completed',
          message: 'Beijing travel itinerary generated from local POI/UGC data.',
          requestId,
          metadata: {
            capabilityId: selectedTravelCapabilityId,
            itineraryPath: 'data_file/final/itinerary-data.json',
            proposalCount: travelResult.planning_response.proposals.length,
          },
        },
      });

      return NextResponse.json({
        success: true,
        status: 'travel_plan_completed',
        requestId,
        userMessageId,
        assistantMessageId,
        conversationId: conversationId ?? null,
        itineraryPath: 'data_file/final/itinerary-data.json',
        proposalCount: travelResult.planning_response.proposals.length,
      });
    }

    if (shouldReplanTravel) {
      const travelGoal = displayInstruction || finalInstruction;
      const existingItinerary = existingItineraryForRequest;
      const previousPlanning = existingItinerary?.planning_response || {};
      const previousRequest = (previousPlanning.request_snapshot ||
        existingItinerary?.parsed_request ||
        {}) as Partial<TravelPlanningRequest>;
      const selectedProposal = Array.isArray(previousPlanning.proposals)
        ? previousPlanning.proposals[0]
        : undefined;

      const planningResponse = existingItinerary
        ? await replanTravelRoute({
            previous_request: previousRequest,
            selected_proposal: selectedProposal,
            adjustment_text: travelGoal,
          })
        : (await parseAndPlanTravel({ goal: travelGoal })).planning_response;

      const travelResult = {
        parsed_request: planningResponse.request_snapshot,
        parser_confidence: existingItinerary ? 0.86 : 0.82,
        parser_notes: existingItinerary
          ? ['Local replan applied to the previous itinerary.']
          : ['No previous itinerary was found, so a fresh local travel plan was generated.'],
        parser_correction_hints: [],
        planning_response: planningResponse,
      };

      await writeTravelPlanArtifacts({
        projectPath,
        requestId,
        capabilityId: selectedTravelCapabilityId,
        instruction: travelGoal,
        result: travelResult as Record<string, any>,
      });

      let userMessageId: string | null = null;
      let assistantMessageId: string | null = null;
      try {
        const userMessage = await createMessage({
          projectId: project_id,
          role: 'user',
          messageType: 'chat',
          content: displayInstruction || finalInstruction,
          conversationId: conversationId ?? undefined,
          cliSource: 'local-travel-planner',
          requestId,
        });
        userMessageId = userMessage.id;
        const assistantMessage = await createMessage({
          projectId: project_id,
          role: 'assistant',
          messageType: 'chat',
          content: buildTravelAssistantMessage(travelResult as Record<string, any>),
          conversationId: conversationId ?? undefined,
          cliSource: 'local-travel-planner',
          metadata: {
            type: existingItinerary ? 'travel_replan_completed' : 'travel_plan_completed',
            capabilityId: selectedTravelCapabilityId,
            itineraryPath: 'data_file/final/itinerary-data.json',
            evidencePath: 'evidence/sources.json',
            runPlanPath: '.travelpilot/run_plan.json',
            generationMetrics: planningResponse.generation_metrics,
            replanMetadata: planningResponse.replan_metadata,
          },
          requestId,
        });
        assistantMessageId = assistantMessage.id;
        await markUserRequestAsCompleted(requestId).catch(() => {});
        streamManager.publish(project_id, {
          type: 'message',
          data: serializeMessage(userMessage, { requestId }),
        });
        streamManager.publish(project_id, {
          type: 'message',
          data: serializeMessage(assistantMessage, { requestId }),
        });
      } catch (error) {
        if (process.env.SKIP_DB_SYNC !== '1') {
          throw error;
        }
        console.warn('[API] Local travel replan completed without database-backed chat messages.');
      }

      const status = existingItinerary ? 'travel_replan_completed' : 'travel_plan_completed';
      streamManager.publish(project_id, {
        type: 'status',
        data: {
          status,
          message: existingItinerary
            ? 'Beijing travel itinerary replanned from local POI/UGC data.'
            : 'Beijing travel itinerary generated from local POI/UGC data.',
          requestId,
          metadata: {
            capabilityId: selectedTravelCapabilityId,
            itineraryPath: 'data_file/final/itinerary-data.json',
            proposalCount: planningResponse.proposals.length,
          },
        },
      });

      return NextResponse.json({
        success: true,
        status,
        requestId,
        userMessageId,
        assistantMessageId,
        conversationId: conversationId ?? null,
        itineraryPath: 'data_file/final/itinerary-data.json',
        proposalCount: planningResponse.proposals.length,
      });
    }

    await startQuantGenerationRun({
      projectPath,
      projectId: project_id,
      requestId,
      instruction: finalInstruction,
      cliPreference,
      selectedModel,
    });

    const previousRunPlan = await readQuantRunPlan(projectPath);
    const clarificationContinuation = buildClarificationContinuation({
      previousPlan: previousRunPlan,
      instruction: finalInstruction,
      displayInstruction,
      capabilityId: quantCapabilityId,
    });
    const effectiveInstruction = clarificationContinuation
      ? `${clarificationContinuation.resolvedInstruction}${imageAttachmentInstruction}`
      : finalInstruction;
    const effectiveDisplayInstruction = clarificationContinuation?.displayInstruction ?? displayInstruction;

    const metadata =
      processedImages.length > 0 || clarificationContinuation
        ? {
            ...(processedImages.length > 0
              ? {
                  attachments: processedImages.map((image) => ({
                    name: image.name,
                    url: image.url,
                    publicUrl: image.publicUrl,
                    path: image.path,
                  })),
                  attachmentContextPath,
                }
              : {}),
            ...(clarificationContinuation
              ? {
                  type: 'intent_clarification_continuation',
                  clarificationContinuation: {
                    previousRunId: clarificationContinuation.previousRunId,
                    originalQuestion: clarificationContinuation.originalQuestion,
                    userResponse: clarificationContinuation.userResponse,
                    missing: clarificationContinuation.missing,
                  },
                }
              : {}),
          }
        : undefined;

    console.log('📸 Creating message with attachments:', {
      projectId: project_id,
      hasAttachments: processedImages.length > 0,
      attachmentsCount: processedImages.length,
      metadataKeys: metadata ? Object.keys(metadata) : [],
      metadataString: JSON.stringify(metadata, null, 2)
    });

    const userMessage = await createMessage({
      projectId: project_id,
      role: 'user',
      messageType: 'chat',
      content: effectiveDisplayInstruction || effectiveInstruction,
      conversationId: conversationId ?? undefined,
      cliSource: cliPreference,
      metadata,
      requestId: requestId,
    });

    console.log('📸 Message created successfully:', {
      messageId: userMessage.id,
      hasMetadata: Boolean(metadata),
      metadataType: metadata ? typeof metadata : 'undefined',
      metadataKeys: metadata ? Object.keys(metadata) : [],
      metadataString: metadata ? JSON.stringify(metadata, null, 2) : undefined,
      metadataJsonLength: userMessage.metadataJson ? userMessage.metadataJson.length : 0,
    });

    if (requestId) {
      try {
        const storedInstruction =
          effectiveDisplayInstruction && effectiveDisplayInstruction.trim().length > 0
            ? effectiveDisplayInstruction.trim()
            : instructionWithoutLegacyPaths || effectiveInstruction;

        await upsertUserRequest({
          id: requestId,
          projectId: project_id,
          instruction: storedInstruction || effectiveInstruction,
          cliPreference,
        });
        await markUserRequestAsProcessing(requestId);
      } catch (error) {
        console.error('[API] Failed to record user request metadata:', error);
      }
    }

    streamManager.publish(project_id, {
      type: 'message',
      data: serializeMessage(userMessage, { requestId }),
    });

    await updateProjectActivity(project_id);

    const existingSelected = normalizeModelId(project.preferredCli ?? 'claude', project.selectedModel ?? undefined);

    try {
      await updateQuantGenerationStep({
        projectPath,
        projectId: project_id,
        requestId,
        stepId: 'planning',
        status: 'running',
        summary: '开始生成 run plan。',
      });
      const runPlan = await writeInitialRunPlan({
        projectPath,
        instruction: effectiveInstruction,
        requestId,
        capabilityId: quantCapabilityId,
        hasImageAttachments: processedImages.length > 0,
      });

      if (runPlan.status === 'needs_clarification' && runPlan.clarification?.required) {
        await updateQuantGenerationStep({
          projectPath,
          projectId: project_id,
          requestId,
          stepId: 'planning',
          status: 'warning',
          summary: '任务缺少关键输入，需要用户澄清。',
          runStatus: 'needs_clarification',
          metadata: {
            missing: runPlan.clarification.missing,
            questions: runPlan.clarification.questions,
          },
        });
        const clarificationContent = buildQuantClarificationMessage(runPlan.clarification);
        const assistantMessage = await createMessage({
          projectId: project_id,
          role: 'assistant',
          messageType: 'chat',
          content: clarificationContent,
          conversationId: conversationId ?? undefined,
          cliSource: cliPreference,
          metadata: {
            type: 'intent_clarification',
            clarification: runPlan.clarification,
            runPlanPath: '.quantpilot/run_plan.json',
          },
          requestId,
        });

        await markUserRequestAsCompleted(requestId);
        streamManager.publish(project_id, {
          type: 'message',
          data: serializeMessage(assistantMessage, { requestId }),
        });
        streamManager.publish(project_id, {
          type: 'status',
          data: {
            status: 'intent_clarification_required',
            message: '需要补充关键信息后再开始取数和生成看板。',
            requestId,
            metadata: {
              missing: runPlan.clarification.missing,
              questions: runPlan.clarification.questions,
            },
          },
        });

        return NextResponse.json({
          success: true,
          status: 'intent_clarification_required',
          message: 'Need clarification before agent execution',
          requestId,
          userMessageId: userMessage.id,
          assistantMessageId: assistantMessage.id,
          conversationId: conversationId ?? null,
          clarification: runPlan.clarification,
        });
      }

      await updateQuantGenerationStep({
        projectPath,
        projectId: project_id,
        requestId,
        stepId: 'planning',
        status: 'success',
        summary: `已生成 ${runPlan.capabilityId} 执行计划。`,
        metadata: {
          capabilityId: runPlan.capabilityId,
          symbols: runPlan.symbols,
          expectedArtifacts: runPlan.expectedArtifacts,
        },
      });
      await updateQuantGenerationStep({
        projectPath,
        projectId: project_id,
        requestId,
        stepId: 'data_prefetch',
        status: 'running',
        summary: '开始预取真实数据。',
      });
      const prefetch = await prefetchQuantDataForRunPlan({
        projectPath,
        plan: runPlan,
      });
      await updateQuantGenerationStep({
        projectPath,
        projectId: project_id,
        requestId,
        stepId: 'data_prefetch',
        status: prefetch.skipped ? 'skipped' : 'success',
        summary: prefetch.summary,
        metadata: {
          skipped: prefetch.skipped,
          symbol: prefetch.skipped ? undefined : prefetch.symbol,
          symbols: prefetch.skipped ? undefined : prefetch.symbols,
          finalDataPath: prefetch.skipped ? undefined : prefetch.finalDataPath,
          rawFiles: prefetch.skipped ? undefined : prefetch.rawFiles,
        },
      });
      if (!prefetch.skipped) {
        await ensureQuantDashboardTemplate(projectPath);
      }
      if (!prefetch.skipped) {
        streamManager.publish(project_id, {
          type: 'status',
          data: {
            status: 'quant_data_prefetched',
            message: prefetch.summary,
            requestId,
            metadata: {
              symbol: prefetch.symbol,
              finalDataPath: prefetch.finalDataPath,
              rawFiles: prefetch.rawFiles,
            },
          },
        });
      }
    } catch (error) {
      console.error('[API] Failed to prepare QuantPilot run plan or data prefetch:', error);
      await updateQuantGenerationStep({
        projectPath,
        projectId: project_id,
        requestId,
        stepId: 'data_prefetch',
        status: 'failed',
        summary: '生成计划或数据预取失败。',
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    }

    if (
      project.preferredCli !== cliPreference ||
      existingSelected !== selectedModel
    ) {
      try {
        await updateProject(project_id, {
          preferredCli: cliPreference,
          selectedModel,
        });
      } catch (error) {
        console.error('[API] Failed to persist project CLI/model settings:', error);
      }
    }

    try {
      const status = previewManager.getStatus(project_id);
      if (!status.url) {
        previewManager.start(project_id).catch((error) => {
          console.warn('[API] Failed to auto-start preview (will continue):', error);
        });
      }
    } catch (error) {
      console.warn('[API] Preview auto-start check failed (will continue):', error);
    }

    const cliRuntime = await loadCliRuntime(cliPreference);

    const sessionId =
      !isInitialPrompt && cliPreference === 'claude'
        ? project.activeClaudeSessionId || undefined
        : !isInitialPrompt && cliPreference === 'cursor'
          ? project.activeCursorSessionId || undefined
          : undefined;

    void runQuantGenerationQueued({
      projectPath,
      projectId: project_id,
      requestId,
      instruction: effectiveInstruction,
      cliPreference,
      selectedModel,
      completeOnTaskSuccess: false,
      completeOnTaskFailure: false,
      task: async () => {
        await runValidationAfterExecution({
          execution: (async () => {
            await updateQuantGenerationStep({
              projectPath,
              projectId: project_id,
              requestId,
              stepId: 'agent_execution',
              status: 'running',
              summary: isInitialPrompt ? '开始初始化并生成工作空间。' : '开始让 Agent 修改工作空间。',
            });
            if (isInitialPrompt) {
              await cliRuntime.initializeNextJsProject(
                project_id,
                projectPath,
                effectiveInstruction,
                selectedModel,
                requestId
              );
              return;
            }
            await cliRuntime.applyChanges(
              project_id,
              projectPath,
              effectiveInstruction,
              selectedModel,
              sessionId,
              requestId,
              processedImages
            );
          })(),
          repairExecutor: cliRuntime.applyChanges,
          projectId: project_id,
          projectPath,
          instruction: effectiveInstruction,
          selectedModel,
          sessionId,
          requestId,
          conversationId,
          cliSource: cliPreference,
        });
      },
    }).catch((error) => {
      console.error('[API] Queued generation task failed:', error);
    });

    return NextResponse.json({
      success: true,
      message: 'AI execution started',
      requestId,
      userMessageId: userMessage.id,
      conversationId: conversationId ?? null,
    });
  } catch (error) {
    console.error('[API] Failed to execute AI:', error);
    return NextResponse.json(
      {
        success: false,
        error: 'Failed to execute AI',
        message: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 },
    );
  }
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
