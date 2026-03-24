import { useEffect, useState, useCallback, useMemo } from "react";
import { desktop } from "../lib/desktop";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { 
  ExperimentRunState, 
  ExperimentRunStateStatus,
  ExperimentLoopConfig,
  AgentTaskContext, 
  WorkspaceSnapshot
} from "../types";

export interface UseAutoExperimentParams {
  projectRoot?: string;
  activeTaskContext?: AgentTaskContext | null;
  snapshot: WorkspaceSnapshot | null;
  profileId: string;
  sessionId: string;
  filePath: string;
}

export interface ExperimentLogEntry {
  timestamp: string;
  level: string;
  message: string;
  iteration: number;
}

export function useAutoExperiment({
  projectRoot,
  activeTaskContext,
  snapshot: _snapshot,
  profileId,
  sessionId,
  filePath,
}: UseAutoExperimentParams) {
  const [runState, setRunState] = useState<ExperimentRunState | null>(null);
  const [experimentLogs, setExperimentLogs] = useState<ExperimentLogEntry[]>([]);

  // Auto-resolve: if no explicit experiment task is active, pick the first
  // non-done experiment-stage task from the snapshot so the user can start
  // the auto-experiment directly from the stage view.
  const resolvedTaskContext = useMemo<AgentTaskContext | null>(() => {
    if (activeTaskContext?.stage === "experiment") return activeTaskContext;
    const tasks = _snapshot?.research?.tasks;
    if (!tasks) return null;
    const fallback = tasks.find(
      (t) => t.stage === "experiment" && t.status !== "done" && t.status !== "cancelled",
    );
    if (!fallback) return null;
    return {
      taskId: fallback.id,
      title: fallback.title,
      stage: fallback.stage,
      description: fallback.description,
      nextActionPrompt: fallback.nextActionPrompt,
      taskPrompt: fallback.taskPrompt,
      contextNotes: fallback.contextNotes,
      suggestedSkills: fallback.suggestedSkills,
      inputsNeeded: fallback.inputsNeeded,
      artifactPaths: fallback.artifactPaths,
    };
  }, [activeTaskContext, _snapshot?.research?.tasks]);

  const isExperimentTask = Boolean(resolvedTaskContext);
  const stateFilePath = projectRoot ? `${projectRoot}/.viewerleaf/research/Experiment/automation/run-state.json` : "";

  const loadState = useCallback(async () => {
    if (!stateFilePath || !isExperimentTask) {
       setRunState(null);
       return;
    }
    try {
      const content = await desktop.readFile(stateFilePath);
      if (content && content.content) {
        const loaded = JSON.parse(content.content) as ExperimentRunState;

        // Detect orphaned running/paused states (daemon died from app restart / crash)
        if (loaded.status === "running" || loaded.status === "paused") {
          try {
            const alive: boolean = await invoke("is_experiment_running");
            if (!alive) {
              // Daemon is dead — mark as interrupted so UI offers restart
              loaded.status = "interrupted" as ExperimentRunStateStatus;
            }
          } catch {
            // is_experiment_running call failed — assume dead
            loaded.status = "interrupted" as ExperimentRunStateStatus;
          }
        }

        setRunState(loaded);
      }
    } catch {
      setRunState(null);
    }
  }, [stateFilePath, isExperimentTask]);

  useEffect(() => {
    void loadState();
    const interval = setInterval(() => void loadState(), 2000);
    return () => clearInterval(interval);
  }, [loadState]);

  // Listen for experiment:log events from the backend daemon
  useEffect(() => {
    let cancelled = false;
    const promise = listen<ExperimentLogEntry>("experiment:log", (event) => {
      if (!cancelled) {
        setExperimentLogs((prev) => [...prev.slice(-199), event.payload]);
      }
    });
    return () => {
      cancelled = true;
      promise.then((fn) => fn());
    };
  }, []);

  const clearLogs = useCallback(() => setExperimentLogs([]), []);

  /** Helper: invoke run_auto_experiment and return true on success. */
  const tryStartDaemon = async (config: ExperimentLoopConfig): Promise<boolean> => {
    try {
      await invoke("run_auto_experiment", {
        payload: {
          profileId,
          // Prefer persisted session ID (from interrupted/paused experiment) to
          // maintain agent context continuity across app restarts.
          sessionId: runState?.sessionId || sessionId,
          filePath,
          taskContext: resolvedTaskContext,
          loopConfig: config,
        }
      });
      return true;
    } catch (err) {
      console.error("run_auto_experiment failed:", err);
      return false;
    }
  };

  const startExperiment = async (config: ExperimentLoopConfig) => {
    if (!resolvedTaskContext) {
      console.warn("No experiment-stage task found – cannot start auto experiment");
      return;
    }

    // Guard: don't start if an experiment is actively running or paused with live daemon
    if (runState && ["running", "paused"].includes(runState.status)) {
      console.warn("An experiment is already active, ignoring start request");
      return;
    }

    // Invoke the backend daemon. It writes the initial state file itself,
    // so there's no race between frontend write and daemon read.
    const started = await tryStartDaemon(config);
    if (started) {
      // Clear logs from previous run
      setExperimentLogs([]);
      // Optimistically update UI; the 2s poll will pick up real state
      setRunState({
        status: "running",
        iterations: 0,
        runHistory: [],
        currentFailures: 0,
        maxFailures: config.maxFailures,
        startTimeMs: Date.now(),
        sessionId: sessionId || undefined,
      });
    }
  };

  const pauseExperiment = async () => {
    try {
      await invoke("pause_auto_experiment");
    } catch (err) {
      console.error("pause_auto_experiment failed:", err);
    }
  };

  const resumeExperiment = async () => {
    // First, tell the daemon to unpause
    try {
      await invoke("resume_auto_experiment");
    } catch (err) {
      console.error("resume_auto_experiment failed:", err);
    }

    // If daemon is dead (app restart), we need to re-invoke it
    try {
      const alive: boolean = await invoke("is_experiment_running");
      if (!alive) {
        const config = _snapshot?.research?.experimentLoop;
        if (config && resolvedTaskContext) {
          await tryStartDaemon(config);
        }
      }
    } catch {
      // Best effort
    }
  };

  const stopExperiment = async () => {
    try {
      await invoke("stop_auto_experiment");
    } catch (err) {
      console.error("stop_auto_experiment failed:", err);
    }
  };

  return {
    runState,
    experimentLogs,
    clearLogs,
    startExperiment,
    pauseExperiment,
    resumeExperiment,
    stopExperiment
  };
}
