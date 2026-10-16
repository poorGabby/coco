import type { Env } from "./env.js";
import { runExportWorker } from "./amplitude-export-jobs.js";

const env = {amplitudeApiKey:process.env.AMPLITUDE_API_KEY,amplitudeSecretKey:process.env.AMPLITUDE_SECRET_KEY,
  amplitudeExportBucket:process.env.AMPLITUDE_EXPORT_BUCKET,amplitudeExportJob:process.env.AMPLITUDE_EXPORT_JOB} as Env;
runExportWorker(env, process.env.COCO_EXPORT_JOB_ID ?? "").then(
  () => console.log("Amplitude export task complete"),
  () => { console.error("Amplitude export task failed; inspect private job status"); process.exitCode=1; },
);
