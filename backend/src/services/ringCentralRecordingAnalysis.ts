import crypto from "node:crypto";
import { Worker } from "node:worker_threads";

type RecordingAnalysis = {
  transcript: string;
  durationSeconds: number;
};

type WorkerResponse = {
  id?: string;
  result?: RecordingAnalysis;
  error?: string;
};

type PendingJob = {
  resolve: (value: RecordingAnalysis) => void;
  reject: (reason: Error) => void;
  timeout: NodeJS.Timeout;
};

const maximumRecordingBytes = 15 * 1024 * 1024;
const analysisTimeoutMs = 90_000;

let workerReference: Worker | null = null;
const pendingJobs = new Map<string, PendingJob>();

function rejectPendingJobs(message: string) {
  for (const job of pendingJobs.values()) {
    clearTimeout(job.timeout);
    job.reject(new Error(message));
  }
  pendingJobs.clear();
}

function createWorker() {
  const worker = new Worker(new URL("./ringCentralAudioWorker.mjs", import.meta.url));

  worker.on("message", (message: WorkerResponse) => {
    const id = String(message.id || "");
    const job = pendingJobs.get(id);
    if (!job) return;

    clearTimeout(job.timeout);
    pendingJobs.delete(id);

    if (message.error || !message.result) {
      job.reject(new Error(message.error || "RingCentral recording analysis failed."));
    } else {
      job.resolve(message.result);
    }
  });
  worker.on("error", (error) => {
    if (workerReference === worker) workerReference = null;
    rejectPendingJobs(error.message || "RingCentral recording worker failed.");
  });
  worker.on("exit", (code) => {
    if (workerReference === worker) workerReference = null;
    if (code !== 0) {
      rejectPendingJobs(`RingCentral recording worker stopped with code ${code}.`);
    }
  });

  workerReference = worker;
  return worker;
}

export function analyzeRingCentralRecording(audio: ArrayBuffer) {
  if (audio.byteLength === 0) {
    return Promise.reject(new Error("RingCentral recording was empty."));
  }
  if (audio.byteLength > maximumRecordingBytes) {
    return Promise.reject(new Error("RingCentral recording exceeded the local analysis size limit."));
  }

  const worker = workerReference || createWorker();
  const id = crypto.randomUUID();

  return new Promise<RecordingAnalysis>((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingJobs.delete(id);
      reject(new Error("RingCentral recording analysis timed out."));
    }, analysisTimeoutMs);

    pendingJobs.set(id, { resolve, reject, timeout });
    worker.postMessage({ id, audio }, [audio]);
  });
}
