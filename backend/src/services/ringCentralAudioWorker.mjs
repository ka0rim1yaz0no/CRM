import { parentPort } from "node:worker_threads";
import decodeMp3 from "@audio/decode-mp3";
import { pipeline } from "@huggingface/transformers";

const modelId = process.env.RINGCENTRAL_ASR_MODEL || "onnx-community/whisper-base.en";
let transcriberPromise;
let workQueue = Promise.resolve();

function resampleTo16Khz(samples, sampleRate) {
  if (sampleRate === 16_000) return samples;

  const outputLength = Math.max(1, Math.round(samples.length * 16_000 / sampleRate));
  const output = new Float32Array(outputLength);

  for (let index = 0; index < outputLength; index += 1) {
    const sourcePosition = index * sampleRate / 16_000;
    const sourceIndex = Math.floor(sourcePosition);
    const fraction = sourcePosition - sourceIndex;
    const current = samples[sourceIndex] || 0;
    const next = samples[Math.min(sourceIndex + 1, samples.length - 1)] || 0;
    output[index] = current * (1 - fraction) + next * fraction;
  }

  return output;
}

async function transcribe(audio) {
  const decoded = await decodeMp3(new Uint8Array(audio));
  const channels = decoded.channelData.filter((channel) => channel?.length);
  if (channels.length === 0) {
    throw new Error("RingCentral recording did not contain an audio channel.");
  }

  const sampleCount = Math.max(...channels.map((channel) => channel.length));
  const combinedAudio = new Float32Array(sampleCount);
  for (let index = 0; index < sampleCount; index += 1) {
    let sampleTotal = 0;
    let contributingChannels = 0;
    for (const channel of channels) {
      if (index >= channel.length) continue;
      sampleTotal += channel[index];
      contributingChannels += 1;
    }
    combinedAudio[index] = contributingChannels > 0 ? sampleTotal / contributingChannels : 0;
  }

  transcriberPromise ||= pipeline(
    "automatic-speech-recognition",
    modelId,
    { dtype: "q8" }
  );
  const transcriber = await transcriberPromise;
  const output = await transcriber(resampleTo16Khz(combinedAudio, decoded.sampleRate), {
    chunk_length_s: 30,
    stride_length_s: 5,
  });

  return {
    transcript: String(output?.text || "").trim(),
    durationSeconds: combinedAudio.length / decoded.sampleRate,
  };
}

async function handleJob(job) {
  try {
    const result = await transcribe(job.audio);
    parentPort?.postMessage({ id: job.id, result });
  } catch (error) {
    parentPort?.postMessage({
      id: job.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

parentPort?.on("message", (job) => {
  workQueue = workQueue.then(() => handleJob(job));
});
