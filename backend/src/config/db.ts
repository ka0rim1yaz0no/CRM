import mongoose from "mongoose";

export async function connectDatabase(uri: string) {
  if (!uri) {
    throw new Error("MONGODB_URI is required. This backend command needs a configured database. For a NEW disposable local test setup, run npm run dev:attendance -- --duration-model --auto-time-out from the CRM root instead. To retain existing test records, restart the preserved local fixture launcher. No database address was guessed.");
  }

  await mongoose.connect(uri);
}
