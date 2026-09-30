/**
 * Projects API Routes
 * GET /api/projects - Get all projects
 * POST /api/projects - Create new project
 */

import { NextRequest } from 'next/server';
import { getAllProjects, createProject, isSafeProjectId } from '@/lib/services/project';
import type { CreateProjectInput } from '@/types/backend';
import { serializeProjects, serializeProject } from '@/lib/serializers/project';
import { getDefaultModelForCli, normalizeModelId } from '@/lib/constants/cliModels';
import { createSuccessResponse, createErrorResponse, handleApiError } from '@/lib/utils/api-response';
import { getQuantCapability } from '@/lib/quant/capabilities';

/**
 * GET /api/projects
 * Get all projects list
 */
export async function GET() {
  try {
    const projects = await getAllProjects();
    return createSuccessResponse(serializeProjects(projects));
  } catch (error) {
    return handleApiError(error, 'API', 'Failed to fetch projects');
  }
}

/**
 * POST /api/projects
 * Create new project
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const preferredCli = String(body.preferredCli || body.preferred_cli || 'claude').toLowerCase();
    const requestedModel = body.selectedModel || body.selected_model;
    const quantCapability = getQuantCapability(
      body.quantCapabilityId || body.quant_capability_id || body.capabilityId || body.capability_id
    );

    const input: CreateProjectInput = {
      project_id: body.project_id,
      name: body.name,
      initialPrompt: body.initialPrompt || body.initial_prompt,
      preferredCli,
      selectedModel: normalizeModelId(preferredCli, requestedModel ?? getDefaultModelForCli(preferredCli)),
      description: body.description,
      quantCapabilityId: quantCapability.id,
      quantCapabilitySource:
        body.quantCapabilitySource || body.quant_capability_source || body.capabilitySource || body.capability_source,
    };

    // Validation
    if (!isSafeProjectId(input.project_id)) {
      return createErrorResponse('project_id is not a safe path identifier', undefined, 400);
    }
    if (typeof input.name !== 'string' || !input.name.trim()) {
      return createErrorResponse('name is required', undefined, 400);
    }
    input.name = input.name.trim();

    const project = await createProject(input);
    return createSuccessResponse(serializeProject(project), 201);
  } catch (error) {
    return handleApiError(error, 'API', 'Failed to create project');
  }
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
