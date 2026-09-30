"use client";
import { useState, useEffect, useCallback, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';

const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? '';

interface GitHubRepoModalProps {
  isOpen: boolean;
  onClose: () => void;
  projectId: string;
  projectName?: string;
  onSuccess: () => void;
}

export default function GitHubRepoModal({ 
  isOpen, 
  onClose, 
  projectId, 
  projectName,
  onSuccess 
}: GitHubRepoModalProps) {
  const [repoName, setRepoName] = useState('');
  const [description, setDescription] = useState('');
  const [isPrivate, setIsPrivate] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [nameError, setNameError] = useState('');
  const [isCheckingAvailability, setIsCheckingAvailability] = useState(false);
  const [availabilityCheckedName, setAvailabilityCheckedName] = useState('');
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const repoNameInputRef = useRef<HTMLInputElement | null>(null);
  const previouslyFocusedElementRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  const isLoadingRef = useRef(isLoading);
  onCloseRef.current = onClose;
  isLoadingRef.current = isLoading;

  const sanitizeRepoName = useCallback((name: string): string => {
    if (!name) return '';
    
    return name
      // Convert to lowercase
      .toLowerCase()
      // Replace spaces and underscores with hyphens
      .replace(/[\s_]+/g, '-')
      // Remove invalid characters
      .replace(/[^a-z0-9.-]/g, '')
      // Remove consecutive periods and hyphens
      .replace(/[-]{2,}/g, '-')
      .replace(/[.]{2,}/g, '.')
      // Remove leading/trailing periods and hyphens
      .replace(/^[.-]+|[.-]+$/g, '')
      // Limit to 100 characters
      .substring(0, 100);
  }, []);

  const validateRepoName = useCallback((name: string): string => {
    if (!name.trim()) {
      return 'Repository name is required';
    }

    // GitHub repository name constraints
    if (name.length > 100) {
      return 'Repository name must be 100 characters or less';
    }

    if (name.startsWith('.') || name.startsWith('-') || name.endsWith('.') || name.endsWith('-')) {
      return 'Repository name cannot start or end with a period or hyphen';
    }

    if (!/^[a-zA-Z0-9._-]+$/.test(name)) {
      return 'Repository name can only contain alphanumeric characters, periods, hyphens, and underscores';
    }

    if (name.includes('..')) {
      return 'Repository name cannot contain consecutive periods';
    }

    // Reserved names
    const reservedNames = ['con', 'prn', 'aux', 'nul', 'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9', 'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9'];
    if (reservedNames.includes(name.toLowerCase())) {
      return 'Repository name cannot be a reserved name';
    }

    return '';
  }, []);

  const suggestedRepoName = sanitizeRepoName(`${projectName || projectId || 'project'}-repo`);

  const checkRepoAvailability = useCallback(async (name: string, signal: AbortSignal): Promise<string> => {
    if (!name.trim()) return '';

    const response = await fetch(`${API_BASE}/api/github/check-repo/${encodeURIComponent(name)}`, {
      method: 'GET',
      signal,
    });
    const payload = await response.json().catch(() => ({})) as {
      available?: boolean;
      message?: string;
      error?: string;
    };

    if (response.status === 409 || payload.available === false) {
      return `Repository name "${name}" already exists`;
    }
    if (response.status === 401) {
      return 'GitHub token not configured. Please add your token in Global Settings.';
    }
    if (response.status === 404) {
      return 'Could not verify this repository name (HTTP 404). Check your GitHub connection and try again.';
    }
    if (!response.ok) {
      return payload.message || payload.error || `Could not verify repository availability (HTTP ${response.status}).`;
    }
    if (payload.available !== true) {
      return 'GitHub returned an invalid availability response. Please try again.';
    }

    return '';
  }, []);

  // Initialize and set sanitized repo name when modal opens
  useEffect(() => {
    if (isOpen && !repoName) {
      const sanitized = sanitizeRepoName(projectName || projectId || '');
      setRepoName(sanitized);
    }
  }, [isOpen, projectName, projectId, repoName, sanitizeRepoName]);

  // Validate repo name when it changes
  useEffect(() => {
    if (!isOpen) return;

    const normalizedName = repoName.trim();
    const basicError = validateRepoName(normalizedName);
    setAvailabilityCheckedName('');

    if (basicError) {
      setIsCheckingAvailability(false);
      setNameError(basicError);
      return;
    }

    const controller = new AbortController();
    setNameError('');
    setIsCheckingAvailability(true);
    const timeoutId = window.setTimeout(async () => {
      try {
        const availabilityError = await checkRepoAvailability(normalizedName, controller.signal);
        if (controller.signal.aborted) return;
        setNameError(availabilityError);
        setAvailabilityCheckedName(availabilityError ? '' : normalizedName);
      } catch (error) {
        if (controller.signal.aborted) return;
        console.error('Error checking repository availability:', error);
        setNameError('Could not verify repository availability. Check your connection and try again.');
      } finally {
        if (!controller.signal.aborted) {
          setIsCheckingAvailability(false);
        }
      }
    }, 500);

    return () => {
      window.clearTimeout(timeoutId);
      controller.abort();
    };
  }, [checkRepoAvailability, isOpen, repoName, validateRepoName]);

  // Reset state when modal closes
  useEffect(() => {
    if (!isOpen) {
      setRepoName('');
      setNameError('');
      setDescription('');
      setIsPrivate(false);
      setIsCheckingAvailability(false);
      setAvailabilityCheckedName('');
    }
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    previouslyFocusedElementRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    window.requestAnimationFrame(() => repoNameInputRef.current?.focus());

    const handleDialogKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (!isLoadingRef.current) onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const dialog = dialogRef.current;
      if (!dialog) return;
      const focusableElements = Array.from(dialog.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])'
      )).filter((element) => !element.hasAttribute('hidden'));
      if (!focusableElements.length) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const firstElement = focusableElements[0];
      const lastElement = focusableElements[focusableElements.length - 1];
      if (event.shiftKey && document.activeElement === firstElement) {
        event.preventDefault();
        lastElement.focus();
      } else if (!event.shiftKey && document.activeElement === lastElement) {
        event.preventDefault();
        firstElement.focus();
      }
    };

    document.addEventListener('keydown', handleDialogKeyDown);
    return () => {
      document.removeEventListener('keydown', handleDialogKeyDown);
      previouslyFocusedElementRef.current?.focus();
      previouslyFocusedElementRef.current = null;
    };
  }, [isOpen]);

  const handleRepoNameChange = (value: string) => {
    setRepoName(value);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    const error = validateRepoName(repoName);
    if (error) {
      setNameError(error);
      return;
    }
    if (isCheckingAvailability || availabilityCheckedName !== repoName.trim() || nameError) {
      setNameError(nameError || 'Wait for the current repository name to be verified.');
      return;
    }

    setIsLoading(true);
    try {
      const response = await fetch(`${API_BASE}/api/projects/${projectId}/github/connect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          repo_name: repoName.trim(),
          description: description.trim(),
          private: isPrivate
        })
      });

      if (response.ok) {
        const result = await response.json();
        onSuccess();
        onClose();
        // Show success message with repository URL
        alert(`Repository created successfully!\n${result.repo_url}`);
      } else {
        let errorMessage = 'Unknown error occurred';
        
        try {
          const errorData = await response.json();
          if (errorData.detail) {
            errorMessage = errorData.detail;
          } else if (errorData.message) {
            errorMessage = errorData.message;
          }
        } catch {
          errorMessage = await response.text() || `HTTP ${response.status}: ${response.statusText}`;
        }

        if (response.status === 404) {
          errorMessage = 'API endpoint not found. Please ensure the backend service is running and the GitHub integration is properly configured.';
        } else if (response.status === 401) {
          errorMessage = 'GitHub authentication failed. Please check your GitHub token in Global Settings.';
        } else if (response.status === 403) {
          errorMessage = 'GitHub access denied. Please ensure your token has the required permissions to create repositories.';
        }

        alert(`Failed to create repository:\n${errorMessage}`);
      }
    } catch (error) {
      console.error('GitHub repository creation error:', error);
      alert('Failed to create repository. Please try again.');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <AnimatePresence initial={false}>
      {isOpen && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/50">
        <div className="absolute inset-0" onClick={() => {
          if (!isLoading) onClose();
        }}>
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          >
            <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" />
          </motion.div>
        </div>
        
        <div className="relative max-h-[calc(100dvh-2rem)] w-full max-w-2xl overflow-y-auto rounded-xl border border-slate-200 bg-white shadow-2xl">
          <motion.div 
            initial={{ opacity: 0, scale: 0.95, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 20 }}
            transition={{ type: "spring", duration: 0.3 }}
            data-testid="github-repo-modal"
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="github-repo-title"
            tabIndex={-1}
          >
          {/* Header */}
          <div className="px-6 py-4 border-b border-slate-200 bg-slate-50 ">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 bg-slate-900 text-white rounded-full flex items-center justify-center">
                  <svg width="20" height="20" viewBox="0 0 98 96" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <path fillRule="evenodd" clipRule="evenodd" d="M48.854 0C21.839 0 0 22 0 49.217c0 21.756 13.993 40.172 33.405 46.69 2.427.49 3.316-1.059 3.316-2.362 0-1.141-.08-5.052-.08-9.127-13.59 2.934-16.42-5.867-16.42-5.867-2.184-5.704-5.42-7.17-5.42-7.17-4.448-3.015.324-3.015.324-3.015 4.934.326 7.523 5.052 7.523 5.052 4.367 7.496 11.404 5.378 14.235 4.074.404-3.178 1.699-5.378 3.074-6.6-10.839-1.141-22.243-5.378-22.243-24.283 0-5.378 1.94-9.778 5.014-13.2-.485-1.222-2.184-6.275.486-13.038 0 0 4.125-1.304 13.426 5.052a46.97 46.97 0 0 1 12.214-1.63c4.125 0 8.33.571 12.213 1.63 9.302-6.356 13.427-5.052 13.427-5.052 2.67 6.763.97 11.816.485 13.038 3.155 3.422 5.015 7.822 5.015 13.2 0 18.905-11.404 23.06-22.324 24.283 1.78 1.548 3.316 4.481 3.316 9.126 0 6.6-.08 11.897-.08 13.526 0 1.304.89 2.853 3.316 2.364 19.412-6.52 33.405-24.935 33.405-46.691C97.707 22 75.788 0 48.854 0z" fill="currentColor"/>
                  </svg>
                </div>
                <div>
                  <h2 id="github-repo-title" className="text-xl font-semibold text-slate-900 ">Create a new repository</h2>
                  <p className="text-sm text-slate-600 ">A repository contains all project files, including revision history.</p>
                </div>
              </div>
              <button
                type="button"
                onClick={onClose}
                className="text-slate-400 hover:text-slate-600 p-1"
                disabled={isLoading}
                aria-label="Close repository dialog"
              >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <path d="M18 6L6 18M6 6l12 12" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
                </svg>
              </button>
            </div>
          </div>

          {/* Form */}
          <form onSubmit={handleSubmit} className="p-6">
            <div className="space-y-6">
              {/* Repository Name */}
              <div>
                <label htmlFor="github-repo-name" className="block text-sm font-medium text-slate-900 mb-2">
                  Repository name <span className="text-red-500">*</span>
                </label>
                <div className="relative">
                  <input
                    id="github-repo-name"
                    ref={repoNameInputRef}
                    type="text"
                    value={repoName}
                    onChange={(e) => handleRepoNameChange(e.target.value)}
                    className={`w-full px-3 py-2 pr-10 border rounded-md bg-white text-slate-900 focus:ring-2 focus:border-transparent ${
                      nameError 
                        ? 'border-red-500 focus:ring-red-500' 
                        : 'border-slate-300 focus:ring-blue-500'
                    }`}
                    placeholder="my-awesome-project"
                    required
                    disabled={isLoading}
                    maxLength={100}
                    aria-invalid={Boolean(nameError)}
                    aria-describedby="github-repo-name-status"
                  />
                  {isCheckingAvailability && (
                    <div className="absolute right-3 top-1/2 transform -translate-y-1/2">
                      <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-slate-900 "></div>
                    </div>
                  )}
                </div>
                {nameError && (
                  <p id="github-repo-name-status" role="alert" className="mt-1 text-sm text-red-600 flex items-center gap-1">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2"/>
                      <line x1="12" y1="8" x2="12" y2="12" stroke="currentColor" strokeWidth="2"/>
                      <line x1="12" y1="16" x2="12.01" y2="16" stroke="currentColor" strokeWidth="2"/>
                    </svg>
                    {nameError}
                  </p>
                )}
                {!nameError && !isCheckingAvailability && (
                  <p id="github-repo-name-status" className="mt-1 text-xs text-slate-500 ">
                    Great repository names are short and memorable. Need inspiration? How about <button type="button" className="text-slate-900 hover:underline" onClick={() => {
                      handleRepoNameChange(suggestedRepoName);
                    }}>
                      {suggestedRepoName}
                    </button>?
                  </p>
                )}
                {isCheckingAvailability && (
                  <p id="github-repo-name-status" role="status" aria-live="polite" className="mt-1 text-xs text-blue-600 ">
                    Checking availability...
                  </p>
                )}
              </div>

              {/* Description */}
              <div>
                <label htmlFor="github-repo-description" className="block text-sm font-medium text-slate-900 mb-2">
                  Description <span className="text-slate-500">(optional)</span>
                </label>
                <input
                  id="github-repo-description"
                  type="text"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  className="w-full px-3 py-2 border border-slate-300 rounded-md bg-white text-slate-900 focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  placeholder="A short description of your repository"
                  disabled={isLoading}
                />
              </div>

              {/* Repository Visibility */}
              <fieldset>
                <legend className="block text-sm font-medium text-slate-900 mb-3">
                  Repository visibility
                </legend>
                <div className="space-y-3">
                  <label className="flex items-start gap-3 p-3 border border-slate-200 rounded-md cursor-pointer hover:bg-slate-50 ">
                    <input
                      type="radio"
                      name="visibility"
                      checked={!isPrivate}
                      onChange={() => setIsPrivate(false)}
                      className="mt-1 text-slate-900 "
                      disabled={isLoading}
                    />
                    <div>
                      <div className="flex items-center gap-2">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                          <path d="M3 7v10a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2z" stroke="currentColor" strokeWidth="2"/>
                          <path d="M7 7V5a5 5 0 0 1 10 0v2" stroke="currentColor" strokeWidth="2"/>
                        </svg>
                        <span className="font-medium text-slate-900 ">Public</span>
                      </div>
                      <p className="text-sm text-slate-600 mt-1">
                        Anyone on the internet can see this repository. You choose who can commit.
                      </p>
                    </div>
                  </label>
                  
                  <label className="flex items-start gap-3 p-3 border border-slate-200 rounded-md cursor-pointer hover:bg-slate-50 ">
                    <input
                      type="radio"
                      name="visibility"
                      checked={isPrivate}
                      onChange={() => setIsPrivate(true)}
                      className="mt-1 text-slate-900 "
                      disabled={isLoading}
                    />
                    <div>
                      <div className="flex items-center gap-2">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                          <path d="M19 11H5m14 0a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-6a2 2 0 0 1 2-2m14 0V9a7 7 0 0 0-14 0v2" stroke="currentColor" strokeWidth="2"/>
                        </svg>
                        <span className="font-medium text-slate-900 ">Private</span>
                      </div>
                      <p className="text-sm text-slate-600 mt-1">
                        You choose who can see and commit to this repository.
                      </p>
                    </div>
                  </label>
                </div>
              </fieldset>

            </div>

            {/* Actions */}
            <div className="flex justify-end gap-3 mt-8 pt-6 border-t border-slate-200 ">
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 text-slate-700 border border-slate-300 rounded-md hover:bg-slate-50 transition-colors"
                disabled={isLoading}
              >
                Cancel
              </button>
              <button
                type="submit"
                className="px-6 py-2 bg-green-600 hover:bg-green-700 disabled:bg-green-400 text-white rounded-md font-medium transition-colors flex items-center gap-2"
                disabled={isLoading || isCheckingAvailability || !repoName.trim() || !!nameError || availabilityCheckedName !== repoName.trim()}
              >
                {isLoading && (
                  <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white"></div>
                )}
                {isLoading ? 'Creating repository...' : 'Create repository'}
              </button>
            </div>
          </form>
          </motion.div>
        </div>
        </div>
      )}
    </AnimatePresence>
  );
}
