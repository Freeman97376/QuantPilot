"use client";

import { useCallback, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ArrowUp, Image as ImageIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { fadeUp, listContainer, listItem, scaleIn, softTransition, springPanelTransition } from "@/lib/motion";
import { getRoleExperience } from "@/lib/quant/task-experience";
import { cn } from "@/lib/utils";
import type { QuantCapabilityId } from "@/lib/quant/capabilities";
import type { ActiveCliId } from "@/lib/utils/cliOptions";

interface ModelOption {
  id: string;
  name: string;
}

interface AssistantOption {
  id: string;
  name: string;
}

interface RoleModule {
  id: string;
  name: string;
  description: string;
  capabilityId: QuantCapabilityId;
  inputPlaceholder: string;
}

interface UploadedImage {
  id: string;
  name: string;
  url: string;
  path: string;
  file?: File;
}

interface CreateTaskFormProps {
  prompt: string;
  onPromptChange: (value: string) => void;
  isCreating: boolean;
  onSubmit: () => void;
  uploadedImages: UploadedImage[];
  onImagesChange: (images: UploadedImage[]) => void;
  selectedAssistant: ActiveCliId;
  onAssistantChange: (id: string) => void;
  assistantOptions: AssistantOption[];
  isAssistantSelectable: (id: string) => boolean;
  selectedModel: string;
  onModelChange: (id: string) => void;
  modelOptions: ModelOption[];
  selectedRole: RoleModule;
  onRoleChange?: (id: QuantCapabilityId) => void;
}

function CreateTaskForm({
  prompt,
  onPromptChange,
  isCreating,
  onSubmit,
  uploadedImages,
  onImagesChange,
  selectedAssistant,
  onAssistantChange,
  assistantOptions,
  isAssistantSelectable,
  selectedModel,
  onModelChange,
  modelOptions,
  selectedRole,
}: CreateTaskFormProps) {
  const [isDragOver, setIsDragOver] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const roleExperience = getRoleExperience(selectedRole.capabilityId);

  const handleFiles = useCallback(
    (files: FileList | File[]) => {
      setIsUploading(true);
      const filesArray = Array.from(files as ArrayLike<File>);
      const imagesToAdd = filesArray
        .filter((file) => file.type.startsWith("image/"))
        .map((file) => ({
          id: crypto.randomUUID(),
          name: file.name,
          url: URL.createObjectURL(file),
          path: "",
          file,
        }));

      if (imagesToAdd.length > 0) {
        onImagesChange([...uploadedImages, ...imagesToAdd]);
      }
      setIsUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    },
    [uploadedImages, onImagesChange]
  );

  const removeImage = (id: string) => {
    onImagesChange(
      uploadedImages.filter((img) => {
        if (img.id === id && img.url) URL.revokeObjectURL(img.url);
        return img.id !== id;
      })
    );
  };

  return (
    <motion.form
      layout
      {...scaleIn}
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
      onDragEnter={(e) => {
        e.preventDefault();
        e.stopPropagation();
        setIsDragOver(true);
      }}
      onDragLeave={(e) => {
        e.preventDefault();
        e.stopPropagation();
        if (!e.currentTarget.contains(e.relatedTarget as Node)) {
          setIsDragOver(false);
        }
      }}
      onDragOver={(e) => {
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = "copy";
      }}
      onDrop={(e) => {
        e.preventDefault();
        e.stopPropagation();
        setIsDragOver(false);
        if (e.dataTransfer.files.length > 0) handleFiles(e.dataTransfer.files);
      }}
      transition={springPanelTransition}
      className={cn(
        "relative w-full max-w-4xl overflow-hidden rounded-2xl border bg-white text-card-foreground shadow-[0_4px_24px_-8px_rgba(0,0,0,0.08)] transition-all duration-200 ease-out",
        "focus-within:border-primary/30 focus-within:shadow-[0_8px_40px_-20px_hsl(var(--primary))]",
        isDragOver ? "border-primary bg-primary/3 shadow-[0_12px_48px_-24px_hsl(var(--primary))]" : "border-slate-200"
      )}
    >
      {/* Uploaded image previews */}
      <AnimatePresence initial={false}>
        {uploadedImages.length > 0 && (
        <motion.div
          layout
          variants={listContainer}
          initial="initial"
          animate="animate"
          exit="exit"
          className="flex flex-wrap gap-2 px-5 pt-4"
        >
          {uploadedImages.map((image, index) => (
            <motion.div
              key={image.id}
              layout
              variants={listItem}
              className="group relative"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={image.url}
                alt={image.name}
                className="h-16 w-16 rounded-lg border border-slate-200 object-cover"
              />
              <span className="absolute bottom-1 left-1 rounded bg-black/55 px-1 text-[10px] text-white">
                图 {index + 1}
              </span>
              <button
                type="button"
                onClick={() => removeImage(image.id)}
                className="absolute -right-2 -top-2 flex h-5 w-5 items-center justify-center rounded-full bg-red-500 text-xs text-white opacity-0 transition-opacity hover:bg-red-600 group-hover:opacity-100"
                aria-label={`移除图片 ${image.name}`}
              >
                ×
              </button>
            </motion.div>
          ))}
        </motion.div>
        )}
      </AnimatePresence>

      <motion.div layout transition={softTransition}>
        <div className="border-b bg-gradient-to-r from-white to-slate-50/70 px-6 py-4">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="secondary" className="rounded-md border-primary/10 bg-primary/8 px-3 py-1.5 text-sm text-primary">
              {selectedRole.name}
            </Badge>
            <span className="text-sm text-muted-foreground">
              {roleExperience.inputHint}
            </span>
          </div>
          <p className="mt-1.5 text-sm leading-6 text-muted-foreground">
            <span className="font-medium text-foreground/70">将生成：</span>
            {roleExperience.outputHint}
          </p>
        </div>
        <Textarea
          value={prompt}
          onChange={(e) => onPromptChange(e.target.value)}
          placeholder={selectedRole.inputPlaceholder}
          disabled={isCreating}
          className="min-h-[150px] resize-none border-0 bg-transparent px-6 py-5 text-[18px] leading-8 shadow-none transition-[min-height] duration-200 placeholder:text-muted-foreground/72 focus-visible:ring-0 md:focus:min-h-[176px]"
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              onSubmit();
            }
          }}
        />
      </motion.div>

      {/* Drag overlay */}
      <AnimatePresence>
        {isDragOver && (
        <motion.div
          {...fadeUp}
          className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-lg border-2 border-dashed border-primary bg-primary/10"
        >
          <div className="text-center text-primary">
            <ImageIcon className="mx-auto mb-2 h-6 w-6" />
            <p className="text-sm font-semibold">将图片拖到这里</p>
            <p className="mt-1 text-xs">支持 JPG、PNG、GIF、WEBP</p>
          </div>
        </motion.div>
        )}
      </AnimatePresence>

      {/* Toolbar */}
      <div className="border-t border-slate-200 bg-white px-4 py-4">
        <motion.div
          layout
          variants={listContainer}
          initial="initial"
          animate="animate"
          className="mb-4 flex flex-wrap gap-2"
        >
          {roleExperience.templates.map((template) => (
            <motion.button
              key={template.title}
              type="button"
              variants={listItem}
              onClick={() => onPromptChange(template.prompt)}
              disabled={isCreating}
              className="rounded-full border border-slate-200 bg-slate-50/80 px-3.5 py-1.5 text-sm font-medium text-slate-600 shadow-sm transition-all hover:border-primary/25 hover:bg-primary/5 hover:text-primary disabled:cursor-not-allowed disabled:opacity-60"
            >
              {template.title}
            </motion.button>
          ))}
        </motion.div>

        <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="relative h-10 w-10"
          aria-label="上传图片"
          asChild
        >
          <label>
            <ImageIcon className="h-5 w-5" />
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              multiple
              onChange={(e) => e.target.files && handleFiles(e.target.files)}
              disabled={isUploading || isCreating}
              className="sr-only"
            />
          </label>
        </Button>

        <Select value={selectedAssistant} onValueChange={onAssistantChange}>
            <SelectTrigger className="h-11 w-[170px] rounded-xl border-slate-200 bg-white text-base">
            <SelectValue placeholder="选择助手" />
          </SelectTrigger>
          <SelectContent>
            {assistantOptions.map((opt) => (
              <SelectItem
                key={opt.id}
                value={opt.id}
                disabled={!isAssistantSelectable(opt.id)}
              >
                {opt.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {modelOptions.length > 0 && (
          <Select value={selectedModel} onValueChange={onModelChange}>
            <SelectTrigger className="h-11 w-[190px] rounded-xl border-slate-200 bg-white text-base">
              <SelectValue placeholder="选择模型" />
            </SelectTrigger>
            <SelectContent>
              {modelOptions.map((m) => (
                <SelectItem key={m.id} value={m.id}>
                  {m.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}

        <motion.div whileTap={{ scale: 0.96 }} transition={softTransition}>
          <Button
          type="submit"
          disabled={(!prompt.trim() && uploadedImages.length === 0) || isCreating}
          size="icon"
          className="h-11 w-11 rounded-xl bg-primary text-primary-foreground shadow-sm hover:bg-primary/90"
          aria-label="提交任务"
        >
          {isCreating ? (
            <svg
              className="h-4 w-4 animate-spin"
              xmlns="http://www.w3.org/2000/svg"
              fill="none"
              viewBox="0 0 24 24"
            >
              <circle
                className="opacity-25"
                cx="12"
                cy="12"
                r="10"
                stroke="currentColor"
                strokeWidth="4"
              />
              <path
                className="opacity-75"
                fill="currentColor"
                d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
              />
            </svg>
          ) : (
            <ArrowUp className="h-5 w-5" />
          )}
          </Button>
        </motion.div>
        </div>
      </div>
    </motion.form>
  );
}

export { CreateTaskForm };
export type { CreateTaskFormProps, UploadedImage };
