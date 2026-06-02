"use client";

import { useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Pencil, Search, Trash2 } from "lucide-react";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { EmptyState } from "@/components/ui/empty-state";
import { fadeUp, listContainer, listItem } from "@/lib/motion";
import { getTaskVisualState } from "@/lib/quant/task-experience";
import { cn } from "@/lib/utils";
import type { Project as ProjectSummary } from "@/types/project";

interface TaskDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projects: ProjectSummary[];
  editingProject: ProjectSummary | null;
  onEditProject: (project: ProjectSummary | null) => void;
  onUpdateProject: (projectId: string, name: string) => void;
  onOpenProject: (project: ProjectSummary) => void;
  onDeleteProject: (project: ProjectSummary) => void;
  onSearchChange?: (query: string) => void;
  formatTime: (date: string | null) => string;
  formatCliInfo: (cli?: string, model?: string) => string;
  getCapabilityShortName: (capabilityId?: string | null) => string;
}

function TaskDrawer({
  open,
  onOpenChange,
  projects,
  editingProject,
  onEditProject,
  onUpdateProject,
  onOpenProject,
  onDeleteProject,
  formatTime,
  formatCliInfo,
  getCapabilityShortName,
}: TaskDrawerProps) {
  const [search, setSearch] = useState("");

  const filtered = search.trim()
    ? projects.filter((p) => {
        const kw = search.toLowerCase();
        return [p.name, p.description, p.initialPrompt]
          .filter(Boolean)
          .some((v) => String(v).toLowerCase().includes(kw));
      })
    : projects;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="left" className="flex w-full max-w-[420px] flex-col p-0 sm:max-w-[420px]">
        <SheetHeader className="border-b bg-gradient-to-r from-white to-slate-50/70 px-5 py-4">
          <div className="flex items-baseline gap-1.5">
            <SheetTitle className="text-base font-semibold">任务记录</SheetTitle>
            <SheetDescription className="text-xs text-muted-foreground">{projects.length} 项</SheetDescription>
          </div>
        </SheetHeader>

        <motion.div {...fadeUp} className="border-b bg-muted/20 px-5 py-3">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="搜索对话标题..."
              className="border-slate-200/70 bg-white pl-9 text-sm placeholder:text-muted-foreground/60"
            />
          </div>
        </motion.div>

        <div className="flex-1 overflow-y-auto">
          {filtered.length === 0 ? (
            <motion.div {...fadeUp}>
              <EmptyState
                title="暂无匹配的任务记录"
                description={search ? "尝试其他关键词" : "创建第一个任务开始使用"}
                className="m-4 border-0"
              />
            </motion.div>
          ) : (
            <motion.div
              variants={listContainer}
              initial="initial"
              animate="animate"
              className="divide-y divide-slate-100"
            >
            <AnimatePresence initial={false}>
            {filtered.map((project) => {
              const isEditing = editingProject?.id === project.id;
              const title = project.name || project.initialPrompt || "未命名任务";
              const capabilityName = getCapabilityShortName(project.quantCapabilityId);
              const visualState = getTaskVisualState({
                status: project.status,
                hasPreview: Boolean(project.previewUrl),
              });

              return (
                <motion.div
                  key={project.id}
                  layout
                  variants={listItem}
                  initial="initial"
                  animate="animate"
                  exit="exit"
                  className="group relative px-5 py-4 transition-colors duration-150 hover:bg-gradient-to-r hover:from-slate-50 hover:to-white"
                >
                  {isEditing ? (
                    <form
                      onSubmit={(e) => {
                        e.preventDefault();
                        const fd = new FormData(e.currentTarget);
                        const name = String(fd.get("name") || "").trim();
                        if (name) onUpdateProject(project.id, name);
                      }}
                      className="space-y-2"
                    >
                      <input
                        name="name"
                        defaultValue={title}
                        autoFocus
                        className="flex h-9 w-full rounded-md border border-input bg-background px-3 text-sm font-medium shadow-sm outline-none focus:ring-1 focus:ring-ring"
                        onKeyDown={(e) => {
                          if (e.key === "Escape") onEditProject(null);
                        }}
                      />
                      <div className="flex justify-end gap-2">
                        <Button
                          type="button"
                          onClick={() => onEditProject(null)}
                          size="sm"
                          variant="outline"
                          className="h-8"
                        >
                          取消
                        </Button>
                        <Button type="submit" size="sm" className="h-8">
                          保存
                        </Button>
                      </div>
                    </form>
                  ) : (
                    <div>
                      <button
                        type="button"
                        onClick={() => onOpenProject(project)}
                        className="block w-full min-w-0 text-left"
                      >
                        <div className="flex items-start justify-between gap-3">
                          <p className="min-w-0 truncate text-sm font-semibold text-slate-900">
                            {title}
                          </p>
                          <span
                            className={cn(
                              "inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium",
                              visualState.className
                            )}
                          >
                            <span className={cn("h-1.5 w-1.5 rounded-full", visualState.dotClassName)} />
                            {visualState.label}
                          </span>
                        </div>
                        <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-slate-500">
                          <span>{formatTime(project.lastMessageAt || project.createdAt)}</span>
                          <span>@{project.id.slice(-8)}</span>
                        </div>
                        <p className="mt-1 truncate text-xs text-slate-400">
                          {capabilityName} ·{" "}
                          {formatCliInfo(
                            project.preferredCli ?? undefined,
                            project.selectedModel ?? undefined
                          )}
                        </p>
                      </button>
                      <div className="mt-3 flex items-center gap-2">
                        <Button
                          type="button"
                          size="sm"
                          className="h-8 px-3 text-xs"
                          onClick={() => onOpenProject(project)}
                        >
                          {project.previewUrl ? "打开看板" : "继续对话"}
                        </Button>
                        <span className="text-xs text-slate-400">{visualState.description}</span>
                      </div>
                      <div className="pointer-events-none absolute right-3 top-4 z-10 flex gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                        <button
                          type="button"
                          onClick={() => onEditProject(project)}
                          className="pointer-events-auto rounded-md border border-slate-200/60 bg-white p-1.5 text-slate-400 shadow-sm hover:border-slate-300 hover:text-slate-700"
                          aria-label="重命名任务"
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => onDeleteProject(project)}
                          className="pointer-events-auto rounded-md border border-slate-200/60 bg-white p-1.5 text-slate-400 shadow-sm hover:border-red-200 hover:text-red-500"
                          aria-label="删除任务"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </div>
                  )}
                </motion.div>
              );
            })}
            </AnimatePresence>
            </motion.div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

export { TaskDrawer };
export type { TaskDrawerProps };
